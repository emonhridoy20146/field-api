import { Schema, model } from 'mongoose';
import { PROSPECT_STATUSES } from '../domain/rules.js';

// Collection `prospects`: documented in docs/06-data-model.md; indexes in the manifest migration.
const person = { id: { type: String, required: true }, name: { type: String, default: '' } };

const historySchema = new Schema(
  {
    status: { type: String, enum: PROSPECT_STATUSES, required: true },
    at: { type: Date, required: true },
    by: person,
    reason: { type: String, default: null },
    convertedCustomerId: { type: String, default: null },
    convertedErpCustomerId: { type: String, default: null },
  },
  { _id: false },
);

const schema = new Schema(
  {
    clientId: { type: String, required: true },
    name: { type: String, required: true },
    phones: { type: [new Schema({ number: { type: String, required: true }, label: { type: String, default: null } }, { _id: false })], default: [] },
    address: { type: String, default: null },
    note: { type: String, default: null },
    location: { type: new Schema({ lat: Number, lng: Number, accuracyM: { type: Number, default: null } }, { _id: false }), default: null },
    branchId: { type: String, required: true },
    createdBy: person,
    createdAt: { type: Date, required: true },
    createdDate: { type: String, required: true }, // Asia/Dhaka business date of createdAt
    status: { type: String, enum: PROSPECT_STATUSES, default: 'new' },
    statusChangedAt: { type: Date, required: true },
    convertedCustomerId: { type: String, default: null },
    convertedErpCustomerId: { type: String, default: null },
    convertedAt: { type: Date, default: null },
    convertedDate: { type: String, default: null }, // Asia/Dhaka business date of convertedAt (dashboard ranges)
    convertedBy: { type: new Schema(person, { _id: false }), default: null },
    fromProspectId: { type: String, default: null },
    history: { type: [historySchema], default: [] },
    updatedAt: { type: Date, required: true },
    version: { type: Number, default: 1 },
  },
  { collection: 'prospects', versionKey: false },
);
export const ProspectModel = model('Prospect', schema);
