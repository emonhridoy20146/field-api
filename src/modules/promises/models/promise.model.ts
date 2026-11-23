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
    // 1.45.0 (FR-PRM-006) follow-up chain. Documents older than 1.45.0 lack these: attempt reads as 1, chainRootId as own id.
    followUpOf: { type: String, default: null },
    followUpId: { type: String, default: null }, // newest non-cancelled follow-up
    attempt: { type: Number, default: 1 },
    chainRootId: { type: String, default: null },
    noFollowUpAlertedAt: { type: Date, default: null }, // the office was alerted once (promises.follow-up-alert)
  },
  { collection: 'promises', versionKey: false },
);
export const PromiseModel = model('Promise', promiseSchema);
