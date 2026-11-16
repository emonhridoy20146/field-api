import { Schema, model } from 'mongoose';

const handoverSchema = new Schema(
  {
    branchId: { type: String, required: true },
    fromUserId: { type: String, required: true },
    toUserId: { type: String, required: true },
    areaIds: { type: [String], default: [] },
    customerIds: { type: [String], default: [] },
    reason: { type: String, required: true },
    effectiveDate: { type: String, required: true }, // Dhaka business date
    endDate: { type: String, default: null }, // temporary cover: reverts after this date
    status: { type: String, enum: ['pending_acceptance', 'accepted', 'rejected', 'cancelled', 'expired', 'reverted'], default: 'pending_acceptance' },
    createdBy: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: null },
    appliedAt: { type: Date, default: null },
    revertedAt: { type: Date, default: null },
    transfer: { type: { ended: [String], created: [String], _id: false }, default: null },
    summary: { type: Schema.Types.Mixed, default: {} },
    remindedAt: { type: Date, default: null },
  },
  { collection: 'handovers', versionKey: false, timestamps: true },
);
export const HandoverModel = model('Handover', handoverSchema);
