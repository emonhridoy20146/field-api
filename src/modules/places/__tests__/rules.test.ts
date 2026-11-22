import { describe, expect, it } from 'vitest';
import { canEdit, checkDecision, checkMoveRequest, containsPattern, EVENTS_SHOWN, PLACE_ICONS, recentEvents, validPoint, type PlaceState } from '../domain/rules.js';

const bazaar = { lat: 22.7012, lng: 90.3711 };
const base: PlaceState = { status: 'active', createdBy: 'u1', location: bazaar, pendingMove: null };
const pending = { lat: 22.702, lng: 90.372, requestedBy: 'u2', requestedAt: new Date('2026-11-22T04:00:00Z'), reason: null, clientId: 'c-1' };

describe('places: points and icons', () => {
  it('only Bangladesh points are places', () => {
    expect(validPoint(bazaar)).toBe(true);
    expect(validPoint({ lat: 0, lng: 0 })).toBe(false);
    expect(validPoint({ lat: 51.5, lng: -0.12 })).toBe(false);
    expect(validPoint({ lat: Number.NaN, lng: 90 })).toBe(false);
  });
  it('the icon list is short and fixed', () => {
    expect(PLACE_ICONS).toHaveLength(10);
    expect(PLACE_ICONS).toContain('other');
  });
});

describe('places: who may edit (FR-PLC-003)', () => {
  it('the creator changes words, others need place.manage', () => {
    expect(canEdit(base, 'u1', false, false)).toEqual({ ok: true });
    expect(canEdit(base, 'u2', false, false)).toEqual({ ok: false, code: 'NOT_OWNER' });
    expect(canEdit(base, 'u2', true, false)).toEqual({ ok: true });
  });
  it('a direct move is an office action, even for the creator', () => {
    expect(canEdit(base, 'u1', false, true)).toEqual({ ok: false, code: 'MOVE_NEEDS_MANAGE' });
    expect(canEdit(base, 'u1', true, true)).toEqual({ ok: true });
  });
});

describe('places: move requests (FR-PLC-004)', () => {
  const far = { lat: 22.7022, lng: 90.3711 }; // ~111 m north
  it('a request carries the distance', () => {
    const r = checkMoveRequest(base, 'u2', 'c-9', far);
    expect(r.kind).toBe('request');
    if (r.kind === 'request') expect(r.distanceM).toBeGreaterThan(100);
  });
  it('one open request per place; the same clientId by the same person is a replay', () => {
    const p = { ...base, pendingMove: pending };
    expect(checkMoveRequest(p, 'u2', 'c-1', far)).toEqual({ kind: 'replay' });
    expect(checkMoveRequest(p, 'u3', 'c-1', far)).toEqual({ kind: 'error', code: 'MOVE_PENDING' });
    expect(checkMoveRequest(p, 'u2', 'c-2', far)).toEqual({ kind: 'error', code: 'MOVE_PENDING' });
  });
  it('a deleted place, a point abroad and a tiny move are refused', () => {
    expect(checkMoveRequest({ ...base, status: 'deleted' }, 'u2', 'c', far)).toEqual({ kind: 'error', code: 'PLACE_DELETED' });
    expect(checkMoveRequest(base, 'u2', 'c', { lat: 40, lng: 90 })).toEqual({ kind: 'error', code: 'OUTSIDE_BANGLADESH' });
    expect(checkMoveRequest(base, 'u2', 'c', { lat: 22.70122, lng: 90.3711 })).toEqual({ kind: 'error', code: 'MOVE_TOO_SHORT' });
  });
});

describe('places: decisions (FR-PLC-005)', () => {
  const p = { ...base, pendingMove: pending };
  it('approve needs no reason, reject needs 5 characters', () => {
    expect(checkDecision(p, 'approve', undefined)).toEqual({ ok: true });
    expect(checkDecision(p, 'reject', ' no ')).toEqual({ ok: false, code: 'REASON_REQUIRED' });
    expect(checkDecision(p, 'reject', 'Wrong side of the road')).toEqual({ ok: true });
  });
  it('nothing to decide without an open request, or on a deleted place', () => {
    expect(checkDecision(base, 'approve', undefined)).toEqual({ ok: false, code: 'NO_PENDING_MOVE' });
    expect(checkDecision({ ...p, status: 'deleted' }, 'approve', undefined)).toEqual({ ok: false, code: 'PLACE_DELETED' });
  });
});

describe('places: helpers', () => {
  it('keeps the newest events', () => {
    const ev = Array.from({ length: EVENTS_SHOWN + 7 }, (_, i) => i);
    const out = recentEvents(ev);
    expect(out).toHaveLength(EVENTS_SHOWN);
    expect(out[0]).toBe(7);
    expect(out.at(-1)).toBe(EVENTS_SHOWN + 6);
  });
  it('search text is literal', () => {
    expect(new RegExp(containsPattern('a.b (c)'), 'i').test('A.B (C) shop')).toBe(true);
    expect(new RegExp(containsPattern('a.b'), 'i').test('axb')).toBe(false);
  });
});
