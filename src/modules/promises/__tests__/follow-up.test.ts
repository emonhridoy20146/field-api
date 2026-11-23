import { describe, expect, it } from 'vitest';
import { attemptOf, chainRootOf, followUpOverdue, followUpProblem, newestFollowUp, nextInChain } from '../domain/follow-up.js';

describe('promise follow-up chain (FR-PRM-006)', () => {
  const broken = { id: 'p1', customerId: 'c1', status: 'broken' };

  it('only a broken or partially kept promise of the same customer can be followed up', () => {
    expect(followUpProblem(null, 'c1')).toBe('NOT_FOUND');
    expect(followUpProblem(broken, 'c2')).toBe('OTHER_CUSTOMER');
    for (const status of ['open', 'kept', 'superseded', 'cancelled']) expect(followUpProblem({ ...broken, status }, 'c1')).toBe('NOT_BROKEN');
    expect(followUpProblem(broken, 'c1')).toBeNull();
    expect(followUpProblem({ ...broken, status: 'partially_kept' }, 'c1')).toBeNull();
  });

  it('promises older than 1.45.0 read as attempt 1 and their own root', () => {
    expect(attemptOf({})).toBe(1);
    expect(attemptOf({ attempt: null })).toBe(1);
    expect(attemptOf({ attempt: 0 })).toBe(1);
    expect(attemptOf({ attempt: 3 })).toBe(3);
    expect(chainRootOf({ id: 'p1' })).toBe('p1');
    expect(chainRootOf({ id: 'p2', chainRootId: 'p1' })).toBe('p1');
  });

  it('a follow-up is the next attempt of the same chain', () => {
    expect(nextInChain(broken)).toEqual({ attempt: 2, chainRootId: 'p1' });
    expect(nextInChain({ id: 'p3', customerId: 'c1', status: 'broken', attempt: 2, chainRootId: 'p1' })).toEqual({ attempt: 3, chainRootId: 'p1' });
  });

  it('the parent shows the newest follow-up that is not cancelled', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 15, 4, m));
    expect(newestFollowUp([])).toBeNull();
    expect(newestFollowUp([{ id: 'a', status: 'cancelled', createdAt: at(1) }])).toBeNull();
    expect(newestFollowUp([{ id: 'a', status: 'open', createdAt: at(1) }, { id: 'b', status: 'cancelled', createdAt: at(2) }])).toBe('a');
    expect(newestFollowUp([{ id: 'a', status: 'broken', createdAt: at(1) }, { id: 'b', status: 'superseded', createdAt: at(2) }])).toBe('b');
    expect(newestFollowUp([{ id: 'b', status: 'open', createdAt: at(1) }, { id: 'a', status: 'open', createdAt: at(1) }])).toBe('b');
  });

  it('alerts once N Dhaka days have passed since the promise closed', () => {
    expect(followUpOverdue('2026-11-17', '2026-11-18', 2)).toBe(false);
    expect(followUpOverdue('2026-11-17', '2026-11-19', 2)).toBe(true);
    expect(followUpOverdue('2026-11-17', '2026-11-25', 2)).toBe(true);
    expect(followUpOverdue('2026-11-17', '2026-11-17', 0)).toBe(true);
    expect(followUpOverdue('2026-11-17', '2026-11-17', -1)).toBe(true);
  });
});
