import { Schema, model } from 'mongoose';

const sessionSchema = new Schema(
  {
    userId: { type: String, required: true },
    familyId: { type: String, required: true },
    refreshTokenHash: { type: String, required: true },
    /** Hash of the previous token in this family — reuse of it means theft (FR-AUTH-002). */
    previousTokenHashes: { type: [String], default: [] },
    deviceId: { type: String, default: null },
    client: { type: String, enum: ['app', 'web'], required: true },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
    lastUsedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
  },
  { collection: 'sessions', versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
);
export const SessionModel = model('Session', sessionSchema);

const attemptSchema = new Schema(
  { key: { type: String, required: true }, at: { type: Date, required: true }, success: Boolean },
  { collection: 'login_attempts', versionKey: false },
);
export const LoginAttemptModel = model('LoginAttempt', attemptSchema);
