import { Schema, model } from 'mongoose';

const collectionSchema = new Schema(
  {
    clientId: { type: String, required: true },
    idempotencyKey: { type: String, required: true }, // client key; also the ERP key (CLAUDE.md §2.4)
    payloadHash: { type: String, required: true },
    branchId: { type: String, required: true },
    customerId: { type: String, required: true },
    erpCustomerId: { type: String, required: true },
    erpBranchId: { type: String, required: true },
    erpPlanId: { type: String, required: true },
    collectorId: { type: String, required: true },
    deviceId: { type: String, default: null },
    amountPoisha: { type: Number, required: true },
    method: { type: String, required: true },
    transactionRef: { type: String, default: null },
    payerName: { type: String, default: null },
    note: { type: String, default: null },
    receiptNo: { type: String, required: true },
    physicalReceiptNo: { type: String, default: null },
    recordedAt: { type: Date, required: true },
    deviceTime: { type: Date, default: null },
    receivedAt: { type: Date, required: true },
    businessDate: { type: String, required: true },
    geo: {
      type: { point: { type: { type: String }, coordinates: [Number] }, accuracyM: Number, mock: Boolean, distanceToPinM: { type: Number, default: null }, _id: false },
      default: null,
    },
    geoUnavailableReason: { type: String, default: null },
    visitClientId: { type: String, default: null },
    photoMediaId: { type: String, default: null },
    status: { type: String, required: true },
    statusHistory: { type: [{ status: String, at: Date, by: String, _id: false }], default: [] },
    erp: {
      type: {
        key: String, // key currently used for ERP posting (original or a resolve request's key)
        paymentId: String,
        receiptNo: String,
        postedAt: Date,
        lastError: String,
        attempts: Number,
        deferred: Boolean,
        reversed: Boolean,
        reversedAt: String,
        _id: false,
      },
      default: {},
    },
    conflict: { type: { code: String, message: { en: String, bn: String }, erpResponse: Schema.Types.Mixed, raisedAt: Date, _id: false }, default: null },
    resolution: { type: { action: String, by: String, at: Date, reason: String, proofMediaId: String, targetPlanId: String, _id: false }, default: null },
    voided: { type: { by: String, at: Date, reason: String, _id: false }, default: null },
    flags: { type: [String], default: [] },
    version: { type: Number, default: 1 },
  },
  { collection: 'collections', versionKey: false },
);
export const CollectionModel = model('Collection', collectionSchema);
