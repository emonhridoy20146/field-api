import { Schema, model } from 'mongoose';
import { ROLES } from '../../../core/security/types.js';

const userSchema = new Schema(
  {
    name: { bn: { type: String, default: '' }, en: { type: String, default: '' } },
    phone: { type: String, required: true },
    username: { type: String, default: undefined },
    passwordHash: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: true },
    role: { type: String, enum: ROLES, required: true },
    branchIds: { type: [String], default: [] },
    employeeCode: { type: String, required: true },
    erpEmployeeId: { type: String, default: null },
    photoMediaId: { type: String, default: null },
    shiftId: { type: String, default: null },
    cashLimitPoisha: { type: Number, default: null },
    active: { type: Boolean, default: true },
    locale: { type: String, enum: ['bn', 'en'], default: 'bn' },
    digits: { type: String, enum: ['bn', 'latin'], default: 'bn' },
    privacyNoticeAcceptedVersion: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
    schemaVersion: { type: Number, default: 1 },
  },
  { collection: 'users', versionKey: false, timestamps: true },
);
export const UserModel = model('User', userSchema);
