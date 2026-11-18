import { Schema, model } from 'mongoose';
import { ctx } from '../../core/context/index.js';
import { isOid } from '../../core/db/index.js';
import { businessRule, notFound } from '../../core/errors/index.js';
import { inBangladesh } from '../../core/geo/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import { isSuperAdmin, type AuthUser } from '../../core/security/types.js';
import * as audit from '../audit/index.js';
import type { ErpBranch } from '../erp-gateway/index.js';

const branchSchema = new Schema(
  {
    erpBranchId: { type: String, required: true },
    code: { type: String, required: true },
    // ERP location type (1.13.0): warehouses can hold receivables, so they are synced like branches.
    kind: { type: String, enum: ['branch', 'warehouse'], default: 'branch' },
    name: { bn: String, en: String },
    district: String,
    address: String,
    location: { type: { type: String, enum: ['Point'] }, coordinates: [Number] },
    active: { type: Boolean, default: true },
    // FOS-only extras (FR-BR-001)
    dutyOverride: { shiftId: String },
    cashLimitDefaultPoisha: { type: Number, default: null },
    erpSyncedAt: Date,
  },
  { collection: 'branches', versionKey: false, timestamps: true },
);
const BranchModel = model('Branch', branchSchema);

export interface BranchView {
  id: string;
  erpBranchId: string;
  code: string;
  kind: 'branch' | 'warehouse';
  name: { bn: string; en: string };
  district: string;
  address: string;
  lat: number | null;
  lng: number | null;
  active: boolean;
  cashLimitDefaultPoisha: number | null;
}

function view(b: {
  _id: { toHexString(): string };
  erpBranchId: string;
  code: string;
  kind?: string | null;
  name?: { bn?: string | null; en?: string | null } | null;
  district?: string | null;
  address?: string | null;
  location?: { coordinates?: number[] } | null;
  active?: boolean | null;
  cashLimitDefaultPoisha?: number | null;
}): BranchView {
  const c = b.location?.coordinates;
  return {
    id: b._id.toHexString(),
    erpBranchId: b.erpBranchId,
    code: b.code,
    kind: b.kind === 'warehouse' ? 'warehouse' : 'branch',
    name: { bn: b.name?.bn ?? '', en: b.name?.en ?? '' },
    district: b.district ?? '',
    address: b.address ?? '',
    lat: c && c.length === 2 ? c[1]! : null,
    lng: c && c.length === 2 ? c[0]! : null,
    active: b.active ?? true,
    cashLimitDefaultPoisha: b.cashLimitDefaultPoisha ?? null,
  };
}

export async function upsertFromErp(branches: ErpBranch[]): Promise<void> {
  const now = ctx().clock.now();
  for (const b of branches) {
    await BranchModel.updateOne(
      { erpBranchId: b.erpBranchId },
      {
        $set: {
          code: b.code,
          kind: b.kind ?? 'branch',
          name: b.name,
          district: b.district,
          address: b.address,
          active: b.active,
          erpSyncedAt: now,
          ...(b.lat !== null && b.lng !== null ? { location: { type: 'Point', coordinates: [b.lng, b.lat] } } : {}),
        },
      },
      { upsert: true },
    );
  }
  await ctx().bus.emit('branch.synced', { count: branches.length });
}

/**
 * Set or clear a branch's map point in FOS (1.13.0). ERP sync never clears it: the ERP has no branch
 * coordinates, and upsertFromErp only writes a location when the ERP sends one.
 */
export async function setLocation(
  user: AuthUser,
  id: string,
  p: { lat: number; lng: number } | { lat: null; lng: null },
  meta: RequestMeta,
): Promise<BranchView> {
  if (!isOid(id)) throw notFound('branch');
  const before = await BranchModel.findById(id).lean();
  if (!before) throw notFound('branch');
  if (p.lat !== null && !inBangladesh({ lat: p.lat, lng: p.lng })) throw businessRule('LOCATION_OUTSIDE_BANGLADESH');
  const update =
    p.lat === null
      ? { $unset: { location: 1 } }
      : { $set: { location: { type: 'Point', coordinates: [p.lng, p.lat] } } };
  const after = await BranchModel.findByIdAndUpdate(id, update, { new: true }).lean();
  const v = view(after!);
  await audit.record({
    actor: user,
    action: 'branch.location_set',
    entity: 'branch',
    entityId: id,
    branchId: id,
    before: { lat: view(before).lat, lng: view(before).lng },
    after: { lat: v.lat, lng: v.lng },
    meta,
  });
  return v;
}

export async function listBranches(user?: AuthUser): Promise<BranchView[]> {
  const filter = user && !isSuperAdmin(user) ? { _id: { $in: user.branchIds.filter(isOid) } } : {};
  return (await BranchModel.find(filter).sort({ code: 1 }).lean()).map(view);
}

export async function getBranch(id: string): Promise<BranchView | null> {
  if (!isOid(id)) return null;
  const b = await BranchModel.findById(id).lean();
  return b ? view(b) : null;
}

export async function getByErpBranchId(erpBranchId: string): Promise<BranchView | null> {
  const b = await BranchModel.findOne({ erpBranchId }).lean();
  return b ? view(b) : null;
}

export async function getBranches(ids: string[]): Promise<Map<string, BranchView>> {
  const rows = await BranchModel.find({ _id: { $in: ids.filter(isOid) } }).lean();
  return new Map(rows.map((r) => [r._id.toHexString(), view(r)]));
}
