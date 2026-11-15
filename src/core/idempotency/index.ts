import { createHash } from 'node:crypto';
import { Schema, model } from 'mongoose';
import { AppError } from '../errors/index.js';
import { isDuplicateKey } from '../db/index.js';
import { ctx } from '../context/index.js';

/** Canonical JSON (sorted keys) so field order never changes the hash. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
}

/** sha256 of the selected fields (all if omitted). Informational fields such as `note` are excluded by callers. */
export function payloadHash(payload: Record<string, unknown>, fields?: string[]): string {
  const picked = fields ? Object.fromEntries(fields.map((f) => [f, payload[f]])) : payload;
  return `sha256:${createHash('sha256').update(canonicalJson(picked)).digest('hex')}`;
}

const recordSchema = new Schema(
  {
    _id: { type: String },
    scope: { type: String, required: true },
    payloadHash: { type: String, required: true },
    state: { type: String, enum: ['pending', 'done'], default: 'pending' },
    statusCode: Number,
    response: Schema.Types.Mixed,
    entityId: String,
    createdAt: { type: Date, required: true },
  },
  { collection: 'idempotency_records', versionKey: false },
);
export const IdempotencyModel = model('IdempotencyRecord', recordSchema);

export interface IdempotentResult<T> {
  statusCode: number;
  body: T;
  replayed: boolean;
}

/**
 * Generic idempotency wrapper for client mutations (deposits, resolutions).
 * Same key + same hash → stored response; same key + different hash → 409 IDEMPOTENCY_MISMATCH.
 */
export async function withIdempotency<T>(
  scope: string,
  key: string,
  hash: string,
  fn: () => Promise<{ statusCode: number; body: T; entityId?: string }>,
): Promise<IdempotentResult<T>> {
  const id = `${scope}:${key}`;
  try {
    await IdempotencyModel.create({ _id: id, scope, payloadHash: hash, createdAt: ctx().clock.now() });
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const existing = await IdempotencyModel.findById(id).lean();
    if (!existing) throw e;
    if (existing.payloadHash !== hash) throw new AppError('IDEMPOTENCY_MISMATCH', { idempotencyKey: key });
    if (existing.state !== 'done') throw new AppError('INVALID_STATE', { reason: 'REQUEST_IN_PROGRESS' });
    return { statusCode: 200, body: existing.response as T, replayed: true };
  }
  try {
    const res = await fn();
    await IdempotencyModel.updateOne(
      { _id: id },
      { $set: { state: 'done', statusCode: res.statusCode, response: res.body, entityId: res.entityId } },
    );
    return { ...res, replayed: false };
  } catch (err) {
    await IdempotencyModel.deleteOne({ _id: id, state: 'pending' });
    throw err;
  }
}
