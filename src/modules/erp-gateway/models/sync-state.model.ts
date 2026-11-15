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
  },
  { collection: 'erp_sync_state', versionKey: false },
);
export const ErpSyncStateModel = model('ErpSyncState', syncStateSchema);
