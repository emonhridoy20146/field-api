import { Schema, model } from 'mongoose';

/**
 * Every target change is a dated record (06-data-model §targets). Nothing is overwritten, so the
 * target of any past day can be worked out again and reports never change afterwards.
 */
const targetSchema = new Schema(
  {
    branchId: { type: String, required: true },
    // null = the branch default for everyone without a personal target.
    userId: { type: String, default: null },
    kind: { type: String, enum: ['set', 'cleared'], required: true },
    amountPoisha: { type: Number, default: null },
    visits: { type: Number, default: null },
    effectiveFrom: { type: String, required: true },
    reason: { type: String, required: true },
    setBy: { type: String, required: true },
    setAt: { type: Date, required: true },
  },
  { collection: 'staff_targets', versionKey: false },
);
export const TargetModel = model('StaffTarget', targetSchema);
