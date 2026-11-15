import { Schema, model } from 'mongoose';

const auditSchema = new Schema(
  {
    seq: { type: Number, required: true },
    at: { type: Date, required: true },
    actorId: { type: String, default: null },
    actorRole: { type: String, default: null },
    actorName: { type: String, default: null },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, default: null },
    branchId: { type: String, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    reason: { type: String, default: null },
    ip: { type: String, default: null },
    deviceId: { type: String, default: null },
    userAgent: { type: String, default: null },
    requestId: { type: String, default: null },
    money: { type: Boolean, default: false },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { collection: 'audit_logs', versionKey: false },
);
export const AuditLogModel = model('AuditLog', auditSchema);
