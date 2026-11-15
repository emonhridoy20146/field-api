import { Schema, model } from 'mongoose';

/**
 * ERP read model (cache, never truth) + FOS overlay under `fos` (customer_overlays merged into the
 * same document so scope/filters are one indexed query — ADR-025). ERP sync only writes `erp`-side
 * fields; `fos.*` is only written by FOS events.
 */
const customerSchema = new Schema(
  {
    erpCustomerId: { type: String, required: true },
    branchId: { type: String, default: null },
    erpBranchId: { type: String, required: true },
    code: String,
    name: { bn: String, en: String },
    phones: { type: [String], default: [] },
    guarantor: { type: Schema.Types.Mixed, default: null },
    address: String,
    areaCode: { type: String, default: null },
    erpLocation: { lat: Number, lng: Number },
    location: { type: { type: String, enum: ['Point'] }, coordinates: { type: [Number], default: undefined } },
    locationStatus: { type: String, enum: ['ok', 'missing', 'invalid', 'suspect_swapped', 'overridden'], default: 'missing' },
    locationSource: { type: String, enum: ['erp', 'overlay'], default: 'erp' },
    plans: { type: Schema.Types.Mixed, default: [] },
    recentPayments: { type: Schema.Types.Mixed, default: [] },
    derived: {
      totalOutstandingPoisha: { type: Number, default: 0 },
      overdue: { type: Boolean, default: false },
      daysOverdue: { type: Number, default: 0 },
      overdueAmountPoisha: { type: Number, default: 0 },
      nextDueDate: { type: String, default: null },
      dueToday: { type: Boolean, default: false },
      badSuggested: { type: Boolean, default: false },
      badReason: { type: Schema.Types.Mixed, default: null },
      plans: { type: Schema.Types.Mixed, default: [] },
      computedFor: String,
    },
    erpStatus: { type: String, enum: ['active', 'inactive', 'closed', 'missing'], default: 'active' },
    erpUpdatedAt: { type: String, default: null },
    erpFetchedAt: { type: Date, required: true },
    fos: {
      assigneeId: { type: String, default: null },
      areaId: { type: String, default: null },
      tag: { type: Schema.Types.Mixed, default: null },
      openPromiseDates: { type: [String], default: [] },
      locationOverride: { type: Schema.Types.Mixed, default: null },
      lastRefreshAt: { type: Date, default: null },
    },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { collection: 'erp_customers', versionKey: false, timestamps: true },
);
export const CustomerModel = model('ErpCustomer', customerSchema);

const proposalSchema = new Schema(
  {
    clientId: { type: String, required: true },
    customerId: { type: String, required: true },
    branchId: String,
    proposedBy: String,
    point: { type: { type: String, enum: ['Point'] }, coordinates: [Number] },
    accuracyM: Number,
    photoMediaId: { type: String, default: null },
    note: { type: String, default: null },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionReason: { type: String, default: null },
  },
  { collection: 'location_proposals', versionKey: false, timestamps: true },
);
export const LocationProposalModel = model('LocationProposal', proposalSchema);
