import { Schema, model } from 'mongoose';

const tagShape = { state: String, severity: String, reasonCode: String, reason: String, setBy: String, setAt: Date };

/** Immutable history (FR-TAG-006). Never updated or deleted. */
const tagEventSchema = new Schema(
  {
    customerId: { type: String, required: true },
    branchId: { type: String, default: null },
    kind: { type: String, enum: ['change', 'request', 'review_requested', 'decision'], required: true },
    previous: { type: tagShape, default: null },
    next: { type: tagShape, default: null },
    reasonCode: String,
    reason: String,
    actorId: { type: String, default: null },
    actorName: { type: String, default: 'system' },
    actorRole: { type: String, default: 'system' },
    source: { type: String, enum: ['web', 'app', 'system'], required: true },
    deviceLocation: { type: { lat: Number, lng: Number, accuracyM: Number, _id: false }, default: null },
    approvalOf: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { collection: 'tag_events', versionKey: false },
);
export const TagEventModel = model('TagEvent', tagEventSchema);

/** Open review items: staff tag requests (approval mode) and "balance cleared" prompts. */
const tagReviewSchema = new Schema(
  {
    _id: String, // = the tag event id that opened it (contract: /tags/review-queue/{eventId})
    customerId: { type: String, required: true },
    branchId: { type: String, default: null },
    kind: { type: String, enum: ['approval', 'balance_cleared'], required: true },
    requested: { type: tagShape, default: null },
    requestedBy: { type: String, default: null },
    status: { type: String, enum: ['open', 'approved', 'rejected', 'superseded'], default: 'open' },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionReason: { type: String, default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'tag_reviews', versionKey: false },
);
export const TagReviewModel = model('TagReview', tagReviewSchema);
