import { Schema, model } from 'mongoose';

const i18n = { bn: String, en: String, _id: false };

const notificationSchema = new Schema(
  {
    userId: { type: String, required: true },
    type: { type: String, required: true },
    title: { type: i18n, required: true },
    body: { type: i18n, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
    pushed: { type: Boolean, default: false },
    createdAt: { type: Date, required: true },
  },
  { collection: 'notifications', versionKey: false },
);
export const NotificationModel = model('Notification', notificationSchema);

const broadcastSchema = new Schema(
  {
    title: { type: i18n, required: true },
    body: { type: i18n, required: true },
    branchIds: { type: [String], default: [] },
    roles: { type: [String], default: [] },
    requireAck: { type: Boolean, default: false },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
    recipientIds: { type: [String], default: [] },
    ackedBy: { type: [String], default: [] },
  },
  { collection: 'broadcasts', versionKey: false },
);
export const BroadcastModel = model('Broadcast', broadcastSchema);
