import { Schema, model } from 'mongoose';

const syncStateSchema = new Schema(
  {
    _id: String, // e.g. 'customers:branch:3'
    cursor: { type: String, default: null }, // updated_since watermark (ISO)
    lastSuccessAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    consecutiveFailures: { type: Number, default: 0 },
    lagSec: { type: Number, default: null },
    // 1.17.0: a customer pull that ran out of time (manual sync button) continues here on the next run.
    resume: { type: Schema.Types.Mixed, default: null }, // { cursor, since, serverTime }
    lockedUntil: { type: Date, default: null }, // manual sync lock (_id 'manual-sync')
  },
  { collection: 'erp_sync_state', versionKey: false },
);
export const ErpSyncStateModel = model('ErpSyncState', syncStateSchema);
