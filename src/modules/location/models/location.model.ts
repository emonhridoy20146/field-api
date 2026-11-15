import { Schema, model } from 'mongoose';

/**
 * Raw points live in a time-series collection created by this module's migration (never by
 * autoCreate, which would make a plain collection). Only on-duty points are ever written here.
 */
const pointSchema = new Schema(
  {
    recordedAt: { type: Date, required: true },
    meta: { type: { userId: String, branchId: String, deviceId: String, _id: false }, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracyM: { type: Number, required: true },
    speedMps: { type: Number, default: null },
    headingDeg: { type: Number, default: null },
    altitudeM: { type: Number, default: null },
    activity: { type: String, default: 'unknown' },
    battery: { type: Number, default: null },
    charging: { type: Boolean, default: null },
    mock: { type: Boolean, default: false },
    receivedAt: { type: Date, required: true },
  },
  { collection: 'location_points', versionKey: false, autoCreate: false, autoIndex: false },
);
export const LocationPointModel = model('LocationPoint', pointSchema);

const latestSchema = new Schema(
  {
    _id: { type: String }, // userId
    branchId: { type: String, default: null },
    point: { type: { type: String, enum: ['Point'] }, coordinates: { type: [Number] } },
    accuracyM: { type: Number, default: null },
    recordedAt: { type: Date, default: null },
    battery: { type: Number, default: null },
    activity: { type: String, default: 'unknown' },
    mock: { type: Boolean, default: false },
    // From heartbeats (FR-LOC-010): tells "tracking stopped" apart from "not moving".
    heartbeatAt: { type: Date, default: null },
    gpsEnabled: { type: Boolean, default: null },
    permission: { type: String, default: null },
    bgRestricted: { type: Boolean, default: null },
    appVersion: { type: String, default: null },
    trackingProvider: { type: String, default: null },
    trackingProviderFallback: { type: Boolean, default: null },
  },
  { collection: 'location_latest', versionKey: false },
);
export const LocationLatestModel = model('LocationLatest', latestSchema);

const heartbeatSchema = new Schema(
  {
    userId: { type: String, required: true },
    at: { type: Date, required: true },
    battery: { type: Number, default: null },
    charging: { type: Boolean, default: null },
    gpsEnabled: { type: Boolean, default: null },
    permission: { type: String, default: null },
    bgRestricted: { type: Boolean, default: null },
    appVersion: { type: String, default: null },
    pendingPoints: { type: Number, default: null },
    pendingMutations: { type: Number, default: null },
    trackingProvider: { type: String, default: null },
    trackingProviderFallback: { type: Boolean, default: null },
  },
  { collection: 'location_heartbeats', versionKey: false },
);
export const HeartbeatModel = model('LocationHeartbeat', heartbeatSchema);

const stopSchema = new Schema(
  {
    userId: { type: String, required: true },
    branchId: { type: String, default: null },
    businessDate: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    dwellMin: { type: Number, required: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    customerId: { type: String, default: null },
    customerName: { type: String, default: null },
    distanceToPinM: { type: Number, default: null },
    pointsCount: { type: Number, default: 0 },
  },
  { collection: 'location_stops', versionKey: false },
);
export const StopModel = model('LocationStop', stopSchema);

const summarySchema = new Schema(
  {
    userId: { type: String, required: true },
    branchId: { type: String, default: null },
    businessDate: { type: String, required: true },
    day: { type: Date, required: true }, // start of the business day, for the TTL index
    distanceKm: Number,
    movingMin: Number,
    stoppedMin: Number,
    stopsCount: Number,
    customerStops: Number,
    gapsMin: Number,
    mockPoints: Number,
    firstPointAt: { type: Date, default: null },
    lastPointAt: { type: Date, default: null },
  },
  { collection: 'location_daily_summaries', versionKey: false },
);
export const DailySummaryModel = model('LocationDailySummary', summarySchema);
