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
  it('a withdrawn or edited collection and a deleted deposit (1.33.0) name the staff member, the customer and the amount', () => {
    expect(FROM_EVENT['collection.withdrawn']!({ collectionId: 'c1', branchId: 'b1', collectorId: 'u1', customerId: 'k1', amountPoisha: 90000, method: 'cash', byUserId: 'u1', reason: 'free text is dropped' })).toEqual({
      key: 'collection_withdrawn:c1', type: 'collection_withdrawn', branchId: 'b1', actorId: 'u1', customerId: 'k1', entity: 'collection', entityId: 'c1', data: { amountPoisha: 90000, method: 'cash' },
    });
    expect(FROM_EVENT['collection.edited']!({ collectionId: 'c1', branchId: 'b1', collectorId: 'u1', customerId: 'k1', amountPoisha: 80000, previousAmountPoisha: 90000, editCount: 2, byUserId: 'u1' })).toMatchObject({
      key: 'collection_edited:c1:2', type: 'collection_edited', actorId: 'u1', data: { amountPoisha: 80000, previousAmountPoisha: 90000, editCount: 2 },
    });
    // a second edit is a second line; a repeated event is the same line
    expect(FROM_EVENT['collection.edited']!({ collectionId: 'c1', editCount: 3 })?.key).toBe('collection_edited:c1:3');
    expect(FROM_EVENT['cash.deposit.deleted']!({ depositId: 'd1', userId: 'u1', byUserId: 'a1', branchId: 'b1', amountPoisha: 500000, reason: 'dropped', wasStatus: 'verified' })).toEqual({
      key: 'deposit_deleted:d1', type: 'deposit_deleted', branchId: 'b1', actorId: 'u1', byId: 'a1', customerId: null, entity: 'deposit', entityId: 'd1', data: { amountPoisha: 500000 },
    });
    expect(FROM_EVENT['collection.withdrawn']!({})).toBeNull();
    expect(FROM_EVENT['cash.deposit.deleted']!({})).toBeNull();
  });
  it('listens to exactly these events', () => {
    expect(CONSUMED_EVENTS.sort()).toEqual(['cash.deposit.deleted', 'collection.edited', 'collection.received', 'collection.withdrawn', 'customer.location.approved', 'customer.location.proposed', 'promise.created', 'visit.recorded']);
  });
});
