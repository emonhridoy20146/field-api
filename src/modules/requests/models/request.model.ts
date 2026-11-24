import { Schema, model } from 'mongoose';
import { LEVELS, PRIORITIES, QUEUES, REQUEST_TYPES, STATUSES, TIMELINE_KINDS } from '../domain/rules.js';

// Collection `requests`: documented in docs/06-data-model.md; indexes in the manifest migration.
const person = new Schema({ id: { type: String, required: true }, name: { type: String, default: '' } }, { _id: false });
const target = new Schema({ queue: { type: String, enum: QUEUES, required: true }, user: { type: person, default: null } }, { _id: false });

/** Append-only (FR-REQ-006): entries are only ever $push-ed, never updated or pulled. */
const timelineSchema = new Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: TIMELINE_KINDS, required: true },
    at: { type: Date, required: true },
    actor: { type: person, required: true },
    note: { type: String, default: null },
    from: { type: target, default: null },
    to: { type: target, default: null },
    status: { type: new Schema({ from: { type: String, default: null }, to: { type: String, enum: STATUSES } }, { _id: false }), default: null },
    clientId: { type: String, default: null }, // comments: the client's id, so a resent comment is a replay
  },
  { _id: false },
);

const schema = new Schema(
  {
    clientId: { type: String, required: true },
    type: { type: String, enum: REQUEST_TYPES, required: true },
    priority: { type: String, enum: PRIORITIES, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    customerId: { type: String, default: null },
    photoMediaIds: { type: [String], default: [] },
    branchId: { type: String, required: true },
    createdBy: { type: person, required: true },
    createdAt: { type: Date, required: true },
    createdDate: { type: String, required: true }, // Asia/Dhaka business date of createdAt
    status: { type: String, enum: STATUSES, default: 'open' },
    level: { type: String, enum: LEVELS, required: true },
    currentQueue: { type: String, enum: QUEUES, required: true },
    assignee: { type: person, default: null },
    /** Creator and everyone the request was ever assigned to: whose devices hear about each change (sync). */
    participantIds: { type: [String], default: [] },
    dueAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: person, default: null },
    resolutionNote: { type: String, default: null },
    closedAt: { type: Date, default: null },
    closedDate: { type: String, default: null }, // Asia/Dhaka business date of closedAt (bootstrap window)
    timeline: { type: [timelineSchema], default: [] },
    updatedAt: { type: Date, required: true },
    version: { type: Number, default: 1 },
  },
  { collection: 'requests', versionKey: false },
);
export const RequestModel = model('StaffRequest', schema);
