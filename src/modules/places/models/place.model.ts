import { Schema, model } from 'mongoose';

const pointSchema = new Schema({ type: { type: String, enum: ['Point'], required: true }, coordinates: { type: [Number], required: true } }, { _id: false });

const eventSchema = new Schema(
  {
    type: { type: String, enum: ['created', 'edited', 'moved', 'move_requested', 'move_approved', 'move_rejected', 'deleted'], required: true },
    by: { type: String, required: true },
    at: { type: Date, required: true },
    note: { type: String, default: null },
    from: { type: { lat: Number, lng: Number, _id: false }, default: null },
    to: { type: { lat: Number, lng: Number, _id: false }, default: null },
    /** The move request's clientId (move_requested only), so an offline retry after the decision is a replay. Not shown. */
    clientId: { type: String, default: null },
  },
  { _id: false },
);

const pendingMoveSchema = new Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    requestedBy: { type: String, required: true },
    requestedAt: { type: Date, required: true },
    reason: { type: String, default: null },
    clientId: { type: String, required: true },
  },
  { _id: false },
);

const decisionSchema = new Schema(
  {
    decision: { type: String, enum: ['approve', 'reject'], required: true },
    by: { type: String, required: true },
    at: { type: Date, required: true },
    reason: { type: String, default: null },
    requestedBy: { type: String, required: true },
  },
  { _id: false },
);

/** A text marker on the map (06-data-model `map_places`, ADR-051). Not customer data and not a tracking point. */
const placeSchema = new Schema(
  {
    clientId: { type: String, default: null },
    /** The creator's first branch, for the record only; null when they have none. Not a scope (ADR-054). */
    branchId: { type: String, default: null },
    name: { type: String, required: true },
    note: { type: String, default: null },
    icon: { type: String, required: true },
    /** GeoJSON [lng, lat] for the 2dsphere index (bbox queries). */
    point: { type: pointSchema, required: true },
    status: { type: String, enum: ['active', 'deleted'], default: 'active' },
    version: { type: Number, default: 1 },
    pendingMove: { type: pendingMoveSchema, default: null },
    lastMoveDecision: { type: decisionSchema, default: null },
    events: { type: [eventSchema], default: [] },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },
    deleteReason: { type: String, default: null },
  },
  { collection: 'map_places', versionKey: false },
);
export const PlaceModel = model('MapPlace', placeSchema);
