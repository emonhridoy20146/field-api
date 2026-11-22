import { Schema, model } from 'mongoose';

const eventSchema = new Schema(
  {
    clientId: { type: String, required: true },
    userId: { type: String, required: true },
    branchId: { type: String, default: null },
    businessDate: { type: String, required: true },
    type: { type: String, enum: ['work_in', 'break_start', 'break_end', 'work_out'], required: true },
    at: { type: Date, required: true },
    deviceTime: { type: Date, default: null },
    receivedAt: { type: Date, required: true },
    geo: { type: { lat: Number, lng: Number, accuracyM: Number, mock: Boolean, _id: false }, default: null },
    geoUnavailableReason: { type: String, default: null },
    selfieMediaId: { type: String, default: null },
    // FR-MED-004 (1.37.0): an admin deleted the photo; the log replaces it ("Deleted by admin <byName> · <at>").
    selfieDeleted: { type: { at: Date, by: String, byName: String, mediaId: String, _id: false }, default: null },
    source: { type: String, enum: ['app', 'correction', 'system'], default: 'app' },
    correction: { type: { by: String, reason: String, replacesEventId: String, _id: false }, default: null },
    replacedBy: { type: String, default: null }, // original stays; only excluded from the derived day (FR-ATT-006)
    flags: { type: [String], default: [] },
  },
  { collection: 'attendance_events', versionKey: false },
);
export const AttendanceEventModel = model('AttendanceEvent', eventSchema);

/** Derived per (userId, businessDate); always rebuildable from events. */
const daySchema = new Schema(
  {
    userId: { type: String, required: true },
    branchId: { type: String, default: null },
    businessDate: { type: String, required: true },
    status: String,
    state: String,
    firstIn: { type: Date, default: null },
    lastOut: { type: Date, default: null },
    lateMin: { type: Number, default: 0 },
    breakMin: { type: Number, default: 0 },
    dutyMin: { type: Number, default: 0 },
    overBreakMin: { type: Number, default: 0 },
    windowBreakMin: { type: Number, default: 0 },
    // absent on days derived before 1.25.0: such a day is derived again on its next read
    overtimeMin: Number,
    breaks: { type: [{ start: Date, end: Date, _id: false }], default: [] },
    autoClosed: { type: Boolean, default: false },
    corrected: { type: Boolean, default: false },
    closed: { type: Boolean, default: false },
    flags: { type: [String], default: [] },
    shift: { type: { start: String, end: String, _id: false }, default: null },
    updatedAt: Date,
  },
  { collection: 'attendance_days', versionKey: false },
);
export const AttendanceDayModel = model('AttendanceDay', daySchema);

const leaveSchema = new Schema(
  {
    userId: { type: String, required: true },
    branchId: { type: String, default: null },
    type: { type: String, enum: ['casual', 'sick', 'other'], required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    reason: { type: String, default: null },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionReason: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
  },
  { collection: 'leave_requests', versionKey: false },
);
export const LeaveModel = model('LeaveRequest', leaveSchema);
