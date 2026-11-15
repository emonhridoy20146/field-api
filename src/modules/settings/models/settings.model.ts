import { Schema, model } from 'mongoose';

const settingSchema = new Schema(
  {
    key: { type: String, required: true },
    scope: { type: String, enum: ['global', 'branch'], required: true },
    branchId: { type: String, default: null },
    value: { type: Schema.Types.Mixed },
    updatedBy: { type: String, default: null },
    updatedAt: { type: Date },
  },
  { collection: 'settings', versionKey: false },
);
export const SettingModel = model('Setting', settingSchema);

const holidaySchema = new Schema(
  {
    date: { type: String, required: true },
    name: { bn: String, en: String },
    branchIds: { type: [String], default: [] },
    type: { type: String, enum: ['national', 'branch'], default: 'national' },
    createdBy: String,
  },
  { collection: 'holidays', versionKey: false, timestamps: true },
);
export const HolidayModel = model('Holiday', holidaySchema);

const shiftSchema = new Schema(
  {
    name: { type: String, required: true },
    start: { type: String, required: true },
    end: { type: String, required: true },
    weeklyOff: { type: [Number], default: [5] },
    lateGraceMin: { type: Number, default: 15 },
    maxBreakMin: { type: Number, default: 60 },
    version: { type: Number, default: 1 },
  },
  { collection: 'shifts', versionKey: false, timestamps: true },
);
export const ShiftModel = model('Shift', shiftSchema);
