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
    // 1.13.0 (ADR-033): ERP directions and risk snapshot, display only.
    detailedAddress: { type: String, default: null },
    directions: { type: String, default: null },
    erpRisk: { type: Schema.Types.Mixed, default: null },
    areaCode: { type: String, default: null },
    erpLocation: { lat: Number, lng: Number },
    location: { type: { type: String, enum: ['Point'] }, coordinates: { type: [Number], default: undefined } },
    locationStatus: { type: String, enum: ['ok', 'missing', 'invalid', 'suspect_swapped', 'overridden'], default: 'missing' },
    locationSource: { type: String, enum: ['erp', 'overlay'], default: 'erp' },
    plans: { type: Schema.Types.Mixed, default: [] },
    // 1.50.0 (FR-CUS-023, ADR-068): invoices returned in the ERP, kept out of `plans` so no customer total counts them.
    // 1.53.0 (FR-CUS-024, ADR-071): shown again as `CustomerDetail.returnedPlans`, never counted.
    returnedPlans: { type: Schema.Types.Mixed, default: [] },
    recentPayments: { type: Schema.Types.Mixed, default: [] },
    derived: {
      totalOutstandingPoisha: { type: Number, default: 0 },
      overdue: { type: Boolean, default: false },
      daysOverdue: { type: Number, default: 0 },
      overdueAmountPoisha: { type: Number, default: 0 },
      nextInstallmentPoisha: { type: Number, default: null },
      nextDueDate: { type: String, default: null },
      dueToday: { type: Boolean, default: false },
      badSuggested: { type: Boolean, default: false },
      badReason: { type: Schema.Types.Mixed, default: null },
      // 1.14.0 (ADR-035): missed installments, drives the pin colour. null = derived before 1.14.0.
      missedCount: { type: Number, default: null },
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
      // 1.23.0 (FR-CUS-016, ADR-042): numbers added in FOS; the ERP sync never writes this.
      extraPhones: { type: [Schema.Types.Mixed], default: [] },
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
    // 1.11.0 (FR-CUS-011): how the point was chosen and where the proposer's phone was at the time.
    method: { type: String, enum: ['gps', 'map'], default: 'gps' },
    devicePoint: { type: { type: String, enum: ['Point'] }, coordinates: { type: [Number], default: undefined } },
    deviceAccuracyM: { type: Number, default: null },
    deviceMock: { type: Boolean, default: false },
    /** Staff pin applied without a manager because the customer had no usable pin (setting customers.staffPinApproval). */
    autoApplied: { type: Boolean, default: false },
    /** Set directly by a manager on the web (POST /customers/{id}/location); never pending. */
    direct: { type: Boolean, default: false },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionReason: { type: String, default: null },
  },
  { collection: 'location_proposals', versionKey: false, timestamps: true },
);
export const LocationProposalModel = model('LocationProposal', proposalSchema);
