import { Schema, model, type ClientSession } from 'mongoose';
import { ctx } from '../context/index.js';

/**
 * Mobile change feed (FR-SYNC-001). Lives in core because every module writes to it inside its own
 * transaction (ADR-024). The `sync` module only reads it.
 */
const counterSchema = new Schema({ _id: String, value: { type: Number, default: 0 } }, { collection: 'counters', versionKey: false });
export const CounterModel = model('Counter', counterSchema);

const changeSchema = new Schema(
  {
    seq: { type: Number, required: true, unique: true },
    userIds: { type: [String], index: true },
    branchId: { type: String, default: null },
    /** 1.18.0 (ADR-037): also for every device of this branch (staff who see the whole branch's customers). */
    fanoutBranchId: { type: String, default: null },
    entity: { type: String, required: true },
    entityId: { type: String, required: true },
    op: { type: String, enum: ['upsert', 'delete'], required: true },
    reason: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { collection: 'sync_changes', versionKey: false },
);
export const ChangeModel = model('SyncChange', changeSchema);

export async function nextSeq(name: string, session?: ClientSession, by = 1): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate({ _id: name }, { $inc: { value: by } }, { upsert: true, new: true, session });
  return doc!.value;
}

export interface ChangeInput {
  entity: string;
  entityId: string;
  op?: 'upsert' | 'delete';
  userIds: string[];
  branchId?: string | null;
  /** Deliver to every user of this branch as well (the entity's loader still applies each user's scope). */
  fanoutBranchId?: string | null;
  reason?: string;
}

export async function recordChanges(changes: ChangeInput[], session?: ClientSession): Promise<void> {
  const real = changes
    .map((c) => ({ ...c, userIds: c.userIds.filter((u): u is string => !!u) }))
    .filter((c) => c.userIds.length > 0 || !!c.fanoutBranchId);
  if (!real.length) return;
  const last = await nextSeq('sync_seq', session, real.length);
  const first = last - real.length + 1;
  const at = ctx().clock.now();
  await ChangeModel.insertMany(
    real.map((c, i) => ({
      seq: first + i,
      userIds: [...new Set(c.userIds)],
      branchId: c.branchId ?? null,
      fanoutBranchId: c.fanoutBranchId ?? null,
      entity: c.entity,
      entityId: c.entityId,
      op: c.op ?? 'upsert',
      reason: c.reason ?? null,
      at,
    })),
    { session },
  );
}

export const recordChange = (c: ChangeInput, session?: ClientSession) => recordChanges([c], session);

export async function currentSeq(): Promise<number> {
  const c = await CounterModel.findById('sync_seq').lean();
  return c?.value ?? 0;
}
