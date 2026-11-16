import { Schema, model } from 'mongoose';

const visitSchema = new Schema(
  {
    clientId: { type: String, required: true },
    branchId: { type: String, required: true },
    customerId: { type: String, required: true },
    userId: { type: String, required: true },
    checkInAt: { type: Date, required: true },
    checkOutAt: { type: Date, default: null },
    deviceTime: { type: Date, default: null },
    receivedAt: { type: Date, required: true },
    outcome: { type: String, required: true },
    geo: { type: { point: { type: { type: String }, coordinates: [Number] }, accuracyM: Number, mock: Boolean, distanceToPinM: Number, _id: false }, default: null },
    geoUnavailableReason: { type: String, default: null },
    photoMediaIds: { type: [String], default: [] },
    source: { type: String, enum: ['manual', 'suggested'], default: 'manual' },
    flags: { type: [String], default: [] },
    // FR-CW-003: set only when colleagues took part; participantIds never contains the recorder.
    coWork: { type: { sessionId: String, participantIds: [String], _id: false }, default: null },
  },
  { collection: 'visits', versionKey: false },
);
export const VisitModel = model('Visit', visitSchema);
