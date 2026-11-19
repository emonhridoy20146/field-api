import { Schema, model } from 'mongoose';

const eventSchema = new Schema(
  {
    type: { type: String, enum: ['created', 'edited', 'resolve_requested', 'verified', 'rejected', 'cancelled'], required: true },
    by: { type: String, required: true },
    at: { type: Date, required: true },
    note: { type: String, default: null },
  },
  { _id: false },
);

/** A free-form job an admin gives to one field staff member (06-data-model §4b). Not tied to a customer. */
const taskSchema = new Schema(
  {
    branchId: { type: String, required: true },
    assigneeId: { type: String, required: true },
    createdBy: { type: String, required: true },
    title: { type: String, required: true },
    note: { type: String, default: null },
    /** Dhaka calendar date YYYY-MM-DD, optional. */
    dueDate: { type: String, default: null },
    status: { type: String, enum: ['open', 'resolve_requested', 'resolved', 'cancelled'], default: 'open' },
    /** What the staff member wrote with the latest resolve request. */
    resolveNote: { type: String, default: null },
    resolveRequestedAt: { type: Date, default: null },
    /** The admin's note with the latest verify, reject or cancel. */
    decisionNote: { type: String, default: null },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    events: { type: [eventSchema], default: [] },
    clientId: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'staff_tasks', versionKey: false },
);
export const TaskModel = model('StaffTask', taskSchema);
