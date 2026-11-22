import { Schema, model } from 'mongoose';

const depositSchema = new Schema(
  {
    clientId: { type: String, required: true },
    branchId: { type: String, required: true },
    userId: { type: String, required: true },
    amountPoisha: { type: Number, required: true },
    destination: { type: String, enum: ['branch_cashier', 'bank', 'manager'], required: true },
    reference: { type: String, default: null },
    slipMediaId: { type: String, default: null },
    depositedAt: { type: Date, required: true },
    geo: { type: { lat: Number, lng: Number, accuracyM: Number, _id: false }, default: null },
    // 1.35.0: new deposits are `submitted` (final); pending/verified/rejected/deleted are from before.
    status: { type: String, enum: ['pending', 'verified', 'rejected', 'deleted', 'submitted'], default: 'pending' },
    // 1.35.0 (FR-CASH-010): the collections it handed in (cash and the rest); absent on older deposits.
    collectionIds: { type: [String], default: undefined },
    nonCashPoisha: { type: Number, default: undefined },
    nonCashCount: { type: Number, default: undefined },
    // 1.35.0: what older (pre-1.35.0) deposits had already paid of the collections this one took
    legacyAbsorbedPoisha: { type: Number, default: undefined },
    verifiedBy: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    // 1.32.0: an admin deleted the deposit (the row stays, ADR-018 spirit)
    deletedBy: { type: String, default: null },
    deletedAt: { type: Date, default: null },
    deleteReason: { type: String, default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'cash_deposits', versionKey: false },
);
export const DepositModel = model('CashDeposit', depositSchema);

const closingSchema = new Schema(
  {
    userId: { type: String, required: true },
    branchId: { type: String, required: true },
    businessDate: { type: String, required: true },
    cashCollectedPoisha: Number,
    mobileCollectedPoisha: Number,
    depositedPoisha: Number,
    onHandPoisha: Number,
    confirmedAt: Date,
    note: { type: String, default: null },
  },
  { collection: 'cash_closings', versionKey: false },
);
export const ClosingModel = model('CashClosing', closingSchema);
