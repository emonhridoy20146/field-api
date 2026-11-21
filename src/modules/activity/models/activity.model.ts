import { Schema, model } from 'mongoose';

/** One line of the staff activity feed, written from a domain event. Rebuildable in spirit: the records stay in their own modules. */
const activitySchema = new Schema(
  {
    key: { type: String, required: true },
    type: { type: String, required: true },
    branchId: { type: String, default: null },
    actorId: { type: String, default: null },
    customerId: { type: String, default: null },
    entity: { type: String, required: true },
    entityId: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, required: true },
  },
  { collection: 'activity_items', versionKey: false },
);
export const ActivityItemModel = model('ActivityItem', activitySchema);

/** Until when each admin has looked at the feed (for the bell's count). */
const seenSchema = new Schema({ userId: { type: String, required: true }, at: { type: Date, required: true } }, { collection: 'activity_seen', versionKey: false });
export const ActivitySeenModel = model('ActivitySeen', seenSchema);
