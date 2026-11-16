import { Schema, model } from 'mongoose';

const promiseSchema = new Schema(
  {
    clientId: { type: String, required: true },
    branchId: { type: String, required: true },
    customerId: { type: String, required: true },
    erpPlanId: { type: String, default: null },
    ownerId: { type: String, required: true },
    createdBy: { type: String, required: true },
    promisedDate: { type: String, required: true },
    promisedAmountPoisha: { type: Number, required: true },
    note: { type: String, default: null },
    status: { type: String, enum: ['open', 'kept', 'partially_kept', 'broken', 'superseded', 'cancelled'], default: 'open' },
    paidTowardsPoisha: { type: Number, default: 0 },
    createdAt: { type: Date, required: true },
    createdDate: { type: String, required: true }, // Dhaka business date of creation
    closedAt: { type: Date, default: null },
    closeReason: { type: String, default: null },
    remindedFor: { type: String, default: null },
  },
  { collection: 'promises', versionKey: false },
);
export const PromiseModel = model('Promise', promiseSchema);
