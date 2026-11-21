import { describe, expect, it } from 'vitest';
import { CONSUMED_EVENTS, FROM_EVENT } from '../domain/feed.js';

describe('activity feed lines (FR-ACT-001)', () => {
  it('a collection keeps who, whom, how much and how; never free text', () => {
    const d = FROM_EVENT['collection.received']!({ collectionId: 'c1', branchId: 'b1', collectorId: 'u1', customerId: 'k1', amountPoisha: 150000, method: 'bkash', flags: ['far_from_pin'], note: 'ignored', phone: '01712345678' });
    expect(d).toEqual({ key: 'collection:c1', type: 'collection', branchId: 'b1', actorId: 'u1', customerId: 'k1', entity: 'collection', entityId: 'c1', data: { amountPoisha: 150000, method: 'bkash', flags: ['far_from_pin'] } });
  });
  it('a visit, a promise and the two kinds of staff pin', () => {
    expect(FROM_EVENT['visit.recorded']!({ visitId: 'v1', branchId: 'b1', userId: 'u1', customerId: 'k1', outcome: 'promised', flags: [] })).toMatchObject({ key: 'visit:v1', actorId: 'u1', data: { outcome: 'promised' } });
    expect(FROM_EVENT['promise.created']!({ promiseId: 'p1', branchId: 'b1', ownerId: 'u2', customerId: 'k1', promisedDate: '2026-11-25' })).toMatchObject({ key: 'promise:p1', type: 'promise', actorId: 'u2', data: { promisedDate: '2026-11-25' } });
    expect(FROM_EVENT['customer.location.proposed']!({ proposalId: 'x1', customerId: 'k1', branchId: 'b1', proposedBy: 'u3' })).toMatchObject({ key: 'pin:x1', type: 'pin', actorId: 'u3', entity: 'customer', entityId: 'k1', data: { applied: false } });
    expect(FROM_EVENT['customer.location.approved']!({ proposalId: 'x2', customerId: 'k2', branchId: 'b1', autoApplied: true, proposedBy: 'u3' })).toMatchObject({ key: 'pin:x2', data: { applied: true } });
  });
  it('a manager deciding a pin or setting one directly is not staff activity; events without their id are skipped', () => {
    expect(FROM_EVENT['customer.location.approved']!({ proposalId: 'x3', customerId: 'k1', direct: true })).toBeNull();
    expect(FROM_EVENT['customer.location.approved']!({ customerId: 'k1', autoApplied: true })).toBeNull();
    expect(FROM_EVENT['collection.received']!({ amountPoisha: 5 })).toBeNull();
    expect(FROM_EVENT['visit.recorded']!({})).toBeNull();
    // an older pin event without the staff member still makes a line
    expect(FROM_EVENT['customer.location.proposed']!({ proposalId: 'x4', customerId: 'k1' })?.actorId).toBeNull();
  });
  it('listens to exactly these events', () => {
    expect(CONSUMED_EVENTS.sort()).toEqual(['collection.received', 'customer.location.approved', 'customer.location.proposed', 'promise.created', 'visit.recorded']);
  });
});
