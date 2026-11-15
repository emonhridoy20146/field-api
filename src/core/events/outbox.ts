import { Schema, model, type ClientSession } from 'mongoose';
import { ctx } from '../context/index.js';

/** Durable side effects, written in the same transaction as the business change (04-architecture §6.5). */
const outboxSchema = new Schema(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['pending', 'processing', 'done', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, required: true },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: null },
    paused: { type: Boolean, default: false },
  },
  { collection: 'outbox', timestamps: true },
);
export const OutboxModel = model('Outbox', outboxSchema);

export type OutboxResult = { status: 'done' } | { status: 'retry'; error: string; delaySec?: number } | { status: 'failed'; error: string };
export type OutboxHandler = (payload: Record<string, unknown>, attempt: number) => Promise<OutboxResult>;

export type OutboxGiveUp = (payload: Record<string, unknown>, error: string) => Promise<void>;
const handlers = new Map<string, { run: OutboxHandler; onGiveUp?: OutboxGiveUp }>();

/** onGiveUp runs when an item ends in `failed` (fatal result or 24 h of retries). */
export function registerOutboxHandler(type: string, run: OutboxHandler, onGiveUp?: OutboxGiveUp): void {
  handlers.set(type, onGiveUp ? { run, onGiveUp } : { run });
}

export async function enqueue(type: string, payload: Record<string, unknown>, session?: ClientSession): Promise<string> {
  const [doc] = await OutboxModel.create([{ type, payload, nextAttemptAt: ctx().clock.now() }], { session });
  return doc!._id.toHexString();
}

/** Backoff: 30 s, 2 m, 10 m, 1 h, then hourly, giving up after 24 h total (FR-COL-008). */
export const BACKOFF_SEC = [30, 120, 600, 3600];
export const MAX_AGE_SEC = 24 * 3600;
export function backoffSec(attempt: number): number {
  return BACKOFF_SEC[Math.min(attempt - 1, BACKOFF_SEC.length - 1)] ?? 3600;
}

export interface DispatchStats {
  done: number;
  retried: number;
  failed: number;
}

/** Claims and runs due outbox items. Safe to run from several workers (lease via lockedUntil). */
export async function dispatchOutbox(limit = 50): Promise<DispatchStats> {
  const stats: DispatchStats = { done: 0, retried: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const now = ctx().clock.now();
    const item = await OutboxModel.findOneAndUpdate(
      {
        status: { $in: ['pending', 'processing'] },
        paused: false,
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
      { $set: { status: 'processing', lockedUntil: new Date(now.getTime() + 60_000) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, new: true },
    );
    if (!item) break;
    const handler = handlers.get(item.type);
    let res: OutboxResult;
    try {
      res = handler ? await handler.run(item.payload as Record<string, unknown>, item.attempts) : { status: 'failed', error: `no handler for ${item.type}` };
    } catch (err) {
      res = { status: 'retry', error: err instanceof Error ? err.message : String(err) };
    }
    const after = ctx().clock.now();
    const age = (after.getTime() - (item.createdAt as Date).getTime()) / 1000;
    if (res.status === 'done') {
      await OutboxModel.updateOne({ _id: item._id }, { $set: { status: 'done', lockedUntil: null, lastError: null } });
      stats.done++;
    } else if (res.status === 'retry' && age < MAX_AGE_SEC) {
      const delay = res.delaySec ?? backoffSec(item.attempts);
      await OutboxModel.updateOne(
        { _id: item._id },
        { $set: { status: 'pending', lockedUntil: null, lastError: res.error, nextAttemptAt: new Date(after.getTime() + delay * 1000) } },
      );
      stats.retried++;
    } else {
      await OutboxModel.updateOne({ _id: item._id }, { $set: { status: 'failed', lockedUntil: null, lastError: res.error } });
      stats.failed++;
      if (handler?.onGiveUp) await handler.onGiveUp(item.payload as Record<string, unknown>, res.error);
    }
  }
  return stats;
}

export async function outboxCounts(type?: string): Promise<{ pending: number; failed: number }> {
  const filter = type ? { type } : {};
  const [pending, failed] = await Promise.all([
    OutboxModel.countDocuments({ ...filter, status: { $in: ['pending', 'processing'] } }),
    OutboxModel.countDocuments({ ...filter, status: 'failed' }),
  ]);
  return { pending, failed };
}

export async function setOutboxPaused(type: string, paused: boolean): Promise<void> {
  await OutboxModel.updateMany({ type, status: { $in: ['pending', 'processing'] } }, { $set: { paused } });
}
