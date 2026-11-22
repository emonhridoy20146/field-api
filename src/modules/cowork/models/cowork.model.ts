import { Schema, model } from 'mongoose';

const memberSchema = new Schema(
  {
    userId: { type: String, required: true },
    status: { type: String, enum: ['invited', 'accepted', 'rejected', 'left'], required: true },
    invitedBy: { type: String, required: true },
    invitedAt: { type: Date, required: true },
    respondedAt: { type: Date, default: null },
    leftAt: { type: Date, default: null },
  },
  { _id: false },
);

/** One group of staff working together on one business day (06-data-model §4a). */
const sessionSchema = new Schema(
  {
    branchId: { type: String, required: true },
    businessDate: { type: String, required: true },
    status: { type: String, enum: ['open', 'ended'], default: 'open' },
    createdBy: { type: String, required: true },
    note: { type: String, default: null },
    members: { type: [memberSchema], default: [] },
    // Client ids of the requests that built this session (idempotent retries).
    clientIds: { type: [String], default: [] },
    createdAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    // 1.34.0 (FR-CW-006): set only when an office user ended the session.
    endedBy: { type: String, default: null },
    endReason: { type: String, default: null },
  },
  { collection: 'cowork_sessions', versionKey: false },
);
export const CoworkSessionModel = model('CoworkSession', sessionSchema);
