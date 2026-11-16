import { Schema, model } from 'mongoose';

const areaSchema = new Schema(
  {
    branchId: { type: String, required: true },
    name: { bn: String, en: String },
    code: { type: String, required: true },
    kind: { type: String, enum: ['polygon', 'codes'], required: true },
    polygon: { type: Schema.Types.Mixed, default: null },
    erpAreaCodes: { type: [String], default: [] },
    color: { type: String, default: '#3B82F6' },
    active: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
    createdBy: String,
  },
  { collection: 'areas', versionKey: false, timestamps: true },
);
export const AreaModel = model('Area', areaSchema);

const assignmentSchema = new Schema(
  {
    branchId: { type: String, required: true },
    userId: { type: String, required: true },
    type: { type: String, enum: ['area', 'customer'], required: true },
    areaId: { type: String, default: null },
    customerId: { type: String, default: null },
    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date, default: null },
    source: { type: String, default: 'manual' }, // manual | bulk | handover:<id> | revert:<id>
    reason: { type: String, default: null },
    createdBy: { type: String, default: null },
    endedBy: { type: String, default: null },
  },
  { collection: 'assignments', versionKey: false },
);
export const AssignmentModel = model('Assignment', assignmentSchema);
