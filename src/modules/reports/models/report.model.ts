import { Schema, model } from 'mongoose';

const bucket = { count: { type: Number, default: 0 }, amountPoisha: { type: Number, default: 0 }, _id: false };

/** One row per branch and business date; history cannot be recomputed later, so it is stored nightly (FR-REP-002). */
const snapshotSchema = new Schema(
  {
    businessDate: { type: String, required: true },
    branchId: { type: String, required: true },
    buckets: { d1_30: bucket, d31_60: bucket, d61_90: bucket, d90p: bucket },
    totalOverdue: bucket,
    badSuggested: { type: Number, default: 0 },
    tagged: { type: Number, default: 0 },
    takenAt: { type: Date, required: true },
  },
  { collection: 'overdue_snapshots', versionKey: false },
);
export const OverdueSnapshotModel = model('OverdueSnapshot', snapshotSchema);

const exportSchema = new Schema(
  {
    requestedBy: { type: String, required: true },
    type: { type: String, required: true },
    format: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: {} },
    locale: { type: String, default: 'bn' },
    status: { type: String, enum: ['queued', 'running', 'ready', 'failed'], default: 'queued' },
    storageKey: { type: String, default: null },
    rows: { type: Number, default: null },
    error: { type: String, default: null },
    createdAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'exports', versionKey: false },
);
export const ExportModel = model('Export', exportSchema);
