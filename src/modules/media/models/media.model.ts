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
    status: { type: String, enum: ['pending', 'uploaded'], default: 'pending' },
    capturedAt: { type: Date, default: null },
    geo: { type: { lat: Number, lng: Number, accuracyM: Number, _id: false }, default: null },
    createdAt: { type: Date, required: true },
    confirmedAt: { type: Date, default: null },
  },
  { collection: 'media', versionKey: false },
);
export const MediaModel = model('Media', mediaSchema);
