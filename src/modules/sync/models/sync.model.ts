import { Schema, model } from 'mongoose';

/** Last known sync activity per device (FR-SYNC-005). */
const stateSchema = new Schema(
  {
    deviceId: { type: String, required: true },
    userId: { type: String, required: true },
    branchId: { type: String, default: null },
    lastPullSeq: { type: Number, default: 0 },
    lastPullAt: { type: Date, default: null },
    lastPushAt: { type: Date, default: null },
    pendingReported: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    appVersion: { type: String, default: null },
  },
  { collection: 'device_sync_state', versionKey: false },
);
export const DeviceSyncStateModel = model('DeviceSyncState', stateSchema);
