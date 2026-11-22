import { Schema, model } from 'mongoose';

const inboxSchema = new Schema(
  {
    key: { type: String, required: true }, // dedupe, e.g. 'collection.conflict:6750…'
    type: { type: String, required: true },
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], required: true },
    severityRank: { type: Number, required: true }, // 0 low … 3 critical, for sorting
    branchId: { type: String, default: null },
    /** 1.42.0 (ADR-054): also shown to every holder of this permission, whatever their branch (e.g. `place.manage`). */
    permission: { type: String, default: null },
    entity: { type: String, required: true },
    entityId: { type: String, required: true },
    summary: { type: { bn: String, en: String, _id: false }, required: true },
    link: { type: String, default: null },
    status: { type: String, enum: ['open', 'snoozed', 'resolved'], default: 'open' },
    /** Items that only matter after a delay (e.g. deposit unverified for 24 h) stay hidden until then. */
    visibleFrom: { type: Date, required: true },
    snoozedUntil: { type: Date, default: null },
    resolvedBy: { type: String, default: null }, // user id or 'system'
    resolvedAt: { type: Date, default: null },
    resolveReason: { type: String, default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'inbox_items', versionKey: false },
);
export const InboxItemModel = model('InboxItem', inboxSchema);
