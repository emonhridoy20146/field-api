import { Schema, model } from 'mongoose';

const noteSchema = new Schema(
  {
    clientId: { type: String, required: true },
    branchId: { type: String, required: true },
    customerId: { type: String, required: true },
    authorId: { type: String, required: true },
    category: { type: String, default: 'general' },
    text: { type: String, required: true },
    voiceMediaId: { type: String, default: null },
    visitClientId: { type: String, default: null },
    createdAt: { type: Date, required: true },
    editedAt: { type: Date, default: null },
  },
  { collection: 'notes', versionKey: false },
);
export const NoteModel = model('Note', noteSchema);

const contactSchema = new Schema(
  {
    clientId: { type: String, required: true },
    branchId: { type: String, required: true },
    customerId: { type: String, required: true },
    userId: { type: String, required: true },
    channel: { type: String, required: true },
    target: { type: String, enum: ['customer', 'guarantor'], default: 'customer' },
    phoneIndex: { type: Number, default: null },
    at: { type: Date, required: true },
    durationSec: { type: Number, default: null },
    outcome: { type: String, default: null },
    note: { type: String, default: null },
    receivedAt: { type: Date, required: true },
  },
  { collection: 'contact_attempts', versionKey: false },
);
export const ContactAttemptModel = model('ContactAttempt', contactSchema);
