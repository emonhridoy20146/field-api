import { Schema, model } from 'mongoose';

// Document the collection and its indexes in docs/06-data-model.md.
const schema = new Schema({ branchId: { type: String, default: null }, createdAt: { type: Date, required: true } }, { collection: '__collection__', versionKey: false });
export const ThingModel = model('__Pascal__Thing', schema);
