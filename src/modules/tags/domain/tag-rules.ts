/** Pure tag rules (FR-TAG-003/007/008). No I/O. */

export type TagState = 'none' | 'pending' | 'tagged';
export type Severity = 'watch' | 'bad' | 'legal';
export const TAG_REASONS = ['plan_ended_unpaid', 'repeated_broken_promise', 'absconded', 'refused_to_pay', 'fraud_suspected', 'cleared', 'mistake', 'other'] as const;
export type TagReasonCode = (typeof TAG_REASONS)[number];
const UNTAG_REASONS: TagReasonCode[] = ['cleared', 'mistake', 'other'];
const TAG_REASONS_ONLY: TagReasonCode[] = ['plan_ended_unpaid', 'repeated_broken_promise', 'absconded', 'refused_to_pay', 'fraud_suspected', 'other'];

export interface Tag {
  state: TagState;
  severity?: Severity;
  reasonCode?: string;
  reason?: string;
  setBy?: string;
  setAt?: Date;
  /**
   * Set while a staff request awaits approval. The other fields stay the tag in force, so filters
   * (`tagged_bad`) keep working; an untagged customer with a pending tag request shows as `pending`.
   */
  pendingEventId?: string;
}

export interface TagRequest {
  state: 'tagged' | 'none';
  severity?: Severity | undefined;
  reasonCode: TagReasonCode;
  reason: string;
}

export type TagDecision =
  | { ok: true; mode: 'apply' | 'request'; next: Tag }
  | { ok: false; rule: 'REASON_TOO_SHORT' | 'REASON_CODE_MISMATCH' | 'NO_CHANGE' };

/** The tag in force, ignoring a pending request overlay. */
export function effective(current: Tag | null): Tag {
  if (!current || current.state !== 'tagged') return { state: 'none' };
  const { pendingEventId: _p, ...rest } = current;
  return rest;
}

/**
 * Decide what a tag request does.
 * - In approval mode, a user without `tag.approve` creates a request (mode 'request'); the customer then shows `pending`.
 * - Otherwise the change applies immediately.
 */
export function decide(current: Tag | null, req: TagRequest, opts: { actorId: string; at: Date; requireApproval: boolean; canApprove: boolean }): TagDecision {
  if (req.reason.trim().length < 10) return { ok: false, rule: 'REASON_TOO_SHORT' };
  if (req.state === 'none' ? !UNTAG_REASONS.includes(req.reasonCode) : !TAG_REASONS_ONLY.includes(req.reasonCode)) return { ok: false, rule: 'REASON_CODE_MISMATCH' };
  const now = effective(current);
  const severity: Severity | undefined = req.state === 'tagged' ? (req.severity ?? 'bad') : undefined;
  if (req.state === now.state && (req.state === 'none' || severity === now.severity)) return { ok: false, rule: 'NO_CHANGE' };
  const next: Tag =
    req.state === 'tagged'
      ? { state: 'tagged', severity: severity!, reasonCode: req.reasonCode, reason: req.reason.trim(), setBy: opts.actorId, setAt: opts.at }
      : { state: 'none', reasonCode: req.reasonCode, reason: req.reason.trim(), setBy: opts.actorId, setAt: opts.at };
  return { ok: true, mode: opts.requireApproval && !opts.canApprove ? 'request' : 'apply', next };
}

/** Public shape (openapi Tag): pending requests show as `pending`; internal fields are dropped. */
export function view(t: Tag | null): Record<string, unknown> {
  if (!t || (t.state !== 'tagged' && !t.pendingEventId)) return { state: 'none' };
  if (t.state !== 'tagged') return { state: 'pending' };
  const out: Record<string, unknown> = { state: 'tagged' };
  for (const k of ['severity', 'reasonCode', 'reason', 'setBy'] as const) if (t[k]) out[k] = t[k];
  if (t.setAt) out.setAt = new Date(t.setAt).toISOString();
  return out;
}
