import { Schema, model } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import type { AuthUser } from '../../core/security/types.js';
import type { RequestMeta } from '../../core/http/router.js';
import * as audit from '../audit/index.js';
import { getSetting } from '../settings/index.js';

const flagSchema = new Schema(
  {
    _id: String,
    defaultEnabled: { type: Boolean, default: false },
    branchOverrides: { type: [{ branchId: String, enabled: Boolean, _id: false }], default: [] },
    updatedBy: String,
    updatedAt: Date,
  },
  { collection: 'feature_flags', versionKey: false },
);
const FlagModel = model('FeatureFlag', flagSchema);

interface FlagState {
  defaultEnabled: boolean;
  branchOverrides: { branchId: string; enabled: boolean }[];
}

let cache: { at: number; map: Map<string, FlagState> } | null = null;
const TTL_MS = 10_000;

export function registry() {
  return ctx()
    .manifests.filter((m) => m.featureFlag)
    .map((m) => ({ module: m.name, ...m.featureFlag! }));
}

async function states(): Promise<Map<string, FlagState>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const rows = await FlagModel.find().lean();
  const map = new Map<string, FlagState>();
  for (const r of rows) map.set(String(r._id), { defaultEnabled: r.defaultEnabled, branchOverrides: (r.branchOverrides ?? []).map((o) => ({ branchId: String(o.branchId), enabled: !!o.enabled })) });
  cache = { at: Date.now(), map };
  return map;
}

export function clearFlagCache(): void {
  cache = null;
}

/** Flag value for a branch: override → default. Unknown/unset flags are OFF (default false). */
export async function isEnabled(key: string, branchId?: string | null): Promise<boolean> {
  const s = (await states()).get(key);
  if (!s) return false;
  if (branchId) {
    const o = s.branchOverrides.find((x) => x.branchId === branchId);
    if (o) return o.enabled;
  }
  return s.defaultEnabled;
}

/** Enabled for a user if enabled in any of their branches (SA: globally or in any branch). */
export async function isEnabledForUser(key: string, user: AuthUser | null): Promise<boolean> {
  if (!user) return isEnabled(key);
  const s = (await states()).get(key);
  if (!s) return false;
  if (user.role === 'super_admin') return s.defaultEnabled || s.branchOverrides.some((o) => o.enabled);
  for (const b of user.branchIds) if (await isEnabled(key, b)) return true;
  return false;
}

export async function flagsFor(user: AuthUser | null): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const f of registry()) out[f.key] = await isEnabledForUser(f.key, user);
  return out;
}

export async function effectiveForBranch(branchId: string): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const f of registry()) out[f.key] = await isEnabled(f.key, branchId);
  return out;
}

export async function list() {
  const st = await states();
  return registry().map((f) => {
    const s = st.get(f.key);
    return {
      key: f.key,
      defaultEnabled: s?.defaultEnabled ?? false,
      branchOverrides: s?.branchOverrides ?? [],
      description: f.description,
      owner: f.owner,
      reviewBy: f.reviewBy ?? '',
      ...(f.lockedReason ? { lockedReason: f.lockedReason } : {}),
    };
  });
}

export async function setFlag(
  user: AuthUser,
  key: string,
  input: { defaultEnabled?: boolean; branchOverrides?: { branchId: string; enabled: boolean }[]; reason: string },
  meta: RequestMeta,
) {
  const f = registry().find((x) => x.key === key);
  if (!f) throw notFound('feature_flag');
  const turningOn = input.defaultEnabled === true || (input.branchOverrides ?? []).some((o) => o.enabled);
  // FR-MF-001: a locked flag (microfinance) cannot be enabled until legal approval is recorded.
  if (f.lockedReason && turningOn && !(await getSetting<boolean>('microfinance.legalApproved'))) {
    throw businessRule('FLAG_LOCKED', { key, lockedReason: f.lockedReason });
  }
  if (input.defaultEnabled === undefined && input.branchOverrides === undefined) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'defaultEnabled', message: 'Nothing to change' }] });
  const before = (await states()).get(key) ?? { defaultEnabled: false, branchOverrides: [] };
  const next: FlagState = {
    defaultEnabled: input.defaultEnabled ?? before.defaultEnabled,
    branchOverrides: input.branchOverrides ?? before.branchOverrides,
  };
  await FlagModel.updateOne({ _id: key }, { $set: { ...next, updatedBy: user.id, updatedAt: ctx().clock.now() } }, { upsert: true });
  await audit.record({ actor: user, action: 'flag.changed', entity: 'feature_flag', entityId: key, before, after: next, reason: input.reason, meta });
  clearFlagCache();
  await ctx().bus.emit('flag.changed', { key });
  return { key, ...next };
}

/** Trusted write used by seed scripts and tests. */
export async function setFlagSystem(key: string, defaultEnabled: boolean, branchOverrides: { branchId: string; enabled: boolean }[] = []): Promise<void> {
  await FlagModel.updateOne({ _id: key }, { $set: { defaultEnabled, branchOverrides, updatedAt: ctx().clock.now() } }, { upsert: true });
  clearFlagCache();
}
