/**
 * Map places (FR-PLC-001..006, ADR-051). Pure rules, no database and no clock: unit-tested to ≥ 90 %.
 *
 * A place is created at once (no approval). Its details are changed by the creator or the office; its marker is moved
 * directly by the office, or by a staff move request that waits for the office:
 *
 *   (no request) ──request (staff)──▶ pending ──approve──▶ moved, no request
 *                                        └────reject (reason)──▶ stays, no request
 */
import { haversineM, inBangladesh, type LatLng } from '../../../core/geo/index.js';

export const PLACE_ICONS = ['shop', 'market', 'mosque', 'school', 'bank', 'hospital', 'bus_stop', 'office', 'landmark', 'other'] as const;
export type PlaceIcon = (typeof PLACE_ICONS)[number];
export type PlaceStatus = 'active' | 'deleted';

export const NAME_MAX = 60;
export const NOTE_MAX = 200;
/** A move shorter than this is a slip of the finger, not a correction. */
export const MIN_MOVE_M = 5;
/** History kept on the representation; the full history is in the audit log. */
export const EVENTS_SHOWN = 50;
export const REJECT_REASON_MIN = 5;

export interface PendingMove {
  lat: number;
  lng: number;
  requestedBy: string;
  requestedAt: Date;
  reason: string | null;
  clientId: string;
}

export interface PlaceState {
  status: PlaceStatus;
  createdBy: string;
  location: LatLng;
  pendingMove: PendingMove | null;
}

type Result<T extends string> = { ok: true } | { ok: false; code: T };

/** Coordinates a place may have: inside Bangladesh like every other pin (OUTSIDE_BANGLADESH otherwise). */
export const validPoint = (p: LatLng): boolean => Number.isFinite(p.lat) && Number.isFinite(p.lng) && inBangladesh(p);

/**
 * Who may change name, icon and note: the creator (with place.create) or the office (place.manage). Only the office moves a
 * marker directly; staff send a move request instead.
 */
export function canEdit(place: Pick<PlaceState, 'createdBy'>, userId: string, canManage: boolean, moves: boolean): Result<'NOT_OWNER' | 'MOVE_NEEDS_MANAGE'> {
  if (canManage) return { ok: true };
  if (moves) return { ok: false, code: 'MOVE_NEEDS_MANAGE' };
  return place.createdBy === userId ? { ok: true } : { ok: false, code: 'NOT_OWNER' };
}

export type MoveRequestCheck = { kind: 'request'; distanceM: number } | { kind: 'replay' } | { kind: 'error'; code: 'PLACE_DELETED' | 'MOVE_PENDING' | 'MOVE_TOO_SHORT' | 'OUTSIDE_BANGLADESH' };

/** One open request per place. The same clientId again is an offline retry (replay); anyone else waits for the decision. */
export function checkMoveRequest(place: PlaceState, requesterId: string, clientId: string, to: LatLng): MoveRequestCheck {
  if (place.pendingMove && place.pendingMove.clientId === clientId && place.pendingMove.requestedBy === requesterId) return { kind: 'replay' };
  if (place.status === 'deleted') return { kind: 'error', code: 'PLACE_DELETED' };
  if (place.pendingMove) return { kind: 'error', code: 'MOVE_PENDING' };
  if (!validPoint(to)) return { kind: 'error', code: 'OUTSIDE_BANGLADESH' };
  const distanceM = Math.round(haversineM(place.location, to));
  if (distanceM < MIN_MOVE_M) return { kind: 'error', code: 'MOVE_TOO_SHORT' };
  return { kind: 'request', distanceM };
}

/** The office decides an open request; a rejection tells the staff member why. */
export function checkDecision(place: PlaceState, decision: 'approve' | 'reject', reason: string | undefined): Result<'NO_PENDING_MOVE' | 'REASON_REQUIRED' | 'PLACE_DELETED'> {
  if (place.status === 'deleted') return { ok: false, code: 'PLACE_DELETED' };
  if (!place.pendingMove) return { ok: false, code: 'NO_PENDING_MOVE' };
  if (decision === 'reject' && (reason ?? '').trim().length < REJECT_REASON_MIN) return { ok: false, code: 'REASON_REQUIRED' };
  return { ok: true };
}

/** The newest `EVENTS_SHOWN` events, oldest first. */
export const recentEvents = <T>(events: readonly T[]): T[] => events.slice(-EVENTS_SHOWN);

/** Escape user text for a case-insensitive "contains" search. */
export const containsPattern = (q: string): string => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
