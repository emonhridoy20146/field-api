import { describe, expect, it } from 'vitest';
import { cronAuthorized, drainOutbox, ensureMongo } from '../serverless.js';
import type { DispatchStats } from '../../core/events/outbox.js';

describe('cronAuthorized (ADR-034)', () => {
  const secret = 'test-secret-0123456789';

  it('accepts the exact bearer secret', () => {
    expect(cronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
  });

  it('refuses a wrong, missing or non-bearer header', () => {
    expect(cronAuthorized('Bearer nope', secret)).toBe(false);
    expect(cronAuthorized(undefined, secret)).toBe(false);
    expect(cronAuthorized(secret, secret)).toBe(false);
  });

  it('refuses everything when the secret is unset or too short', () => {
    expect(cronAuthorized('Bearer ', undefined)).toBe(false);
    expect(cronAuthorized('Bearer short', 'short')).toBe(false);
  });
});

describe('drainOutbox (ADR-034 time budget)', () => {
  /** Fake outbox: `items` waiting, each batch takes `batchMs` on a fake clock. */
  function fake(items: number, batchMs: number) {
    let t = 0;
    let left = items;
    const calls: number[] = [];
    const dispatch = async (limit: number): Promise<DispatchStats> => {
      calls.push(limit);
      t += batchMs;
      const done = Math.min(limit, left);
      left -= done;
      return { done, retried: 0, failed: 0 };
    };
    return { dispatch, now: () => t, calls, left: () => left, advance: (ms: number) => (t += ms) };
  }

  it('stops when the outbox is empty', async () => {
    const f = fake(12, 100);
    const s = await drainOutbox(40_000, f.dispatch, f.now);
    expect(s).toEqual({ done: 12, retried: 0, failed: 0 });
    expect(f.calls).toEqual([5, 5, 5, 5]); // 5 + 5 + 2, then one empty batch
  });

  it('stops at the deadline and leaves the rest for the next call', async () => {
    const f = fake(1000, 10_000);
    const s = await drainOutbox(40_000, f.dispatch, f.now);
    expect(f.calls).toHaveLength(4);
    expect(s.done).toBe(20);
    expect(f.left()).toBe(980);
  });

  it('runs no batch when the jobs already used the budget', async () => {
    const f = fake(10, 100);
    f.advance(45_000); // jobs took 45 s of a 40 s budget
    const s = await drainOutbox(40_000, f.dispatch, f.now);
    expect(f.calls).toHaveLength(0);
    expect(s).toEqual({ done: 0, retried: 0, failed: 0 });
  });
});

describe('ensureMongo (a reused Vercel instance that lost its connection)', () => {
  const fake = (readyState: number) => {
    const calls: string[] = [];
    return { calls, conn: { readyState, asPromise: async () => void calls.push('wait') }, connect: async () => void calls.push('connect'), warn: (m: string) => void calls.push(`warn:${m}`) };
  };
  it('does nothing when connected', async () => {
    const f = fake(1);
    await ensureMongo(f.conn, f.connect, f.warn);
    expect(f.calls).toEqual([]);
  });
  it('connects again when disconnected, waits when connecting', async () => {
    const d = fake(0);
    await ensureMongo(d.conn, d.connect, d.warn);
    expect(d.calls).toEqual(['connect']);
    const c = fake(2);
    await ensureMongo(c.conn, c.connect, c.warn);
    expect(c.calls).toEqual(['wait']);
  });
  it('never throws: a failed reconnect is only logged', async () => {
    const warned: string[] = [];
    await ensureMongo({ readyState: 0, asPromise: async () => undefined }, async () => Promise.reject(new Error('timed out')), (m) => void warned.push(m));
    expect(warned).toEqual(['mongo reconnect failed: timed out']);
  });
});
