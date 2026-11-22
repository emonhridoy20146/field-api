import { Schema, model } from 'mongoose';

const mediaSchema = new Schema(
  {
    ownerId: { type: String, required: true },
    branchId: { type: String, default: null },
    kind: { type: String, required: true },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true }, // hex
    key: { type: String, required: true },
    status: { type: String, enum: ['pending', 'uploaded', 'deleted'], default: 'pending' },
    capturedAt: { type: Date, default: null },
    geo: { type: { lat: Number, lng: Number, accuracyM: Number, _id: false }, default: null },
    createdAt: { type: Date, required: true },
    confirmedAt: { type: Date, default: null },
    // ADR-050: the copy in Cloudinary; once set, reads use it and the base-store copy is removed (baseRemovedAt).
    cloud: { type: { provider: String, publicId: String, version: Number, bytes: Number, format: String, copiedAt: Date, _id: false }, default: null },
    baseRemovedAt: { type: Date, default: null },
    // FR-MED-003/004: deleted by an admin. The row stays (the log); filesRemovedAt once Cloudinary and the base store are clean.
    deleted: { type: { at: Date, by: String, byName: String, reason: String, scope: String, filesRemovedAt: Date, _id: false }, default: null },
  },
  { collection: 'media', versionKey: false },
);
export const MediaModel = model('Media', mediaSchema);
