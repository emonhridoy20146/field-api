import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { JobModel, JobScheduler, type JobDef } from '../../src/core/jobs/index.js';
import { cronTick, OUTBOX_RESERVE_MS } from '../../src/app/serverless.js';
import { manifests } from '../../src/app/register-modules.js';
import type { DispatchStats } from '../../src/core/events/outbox.js';

// 1.45.0: /api/cron is called by a GitHub schedule (every ~5 min, late) and optional pingers, never on the exact
// minute. Jobs must still run once per slot, inside the call's time budget.
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ now: '2026-11-23T04:07:00Z' }); // 10:07 Dhaka
});
afterAll(async () => t.close());
beforeEach(async () => {
  await JobModel.deleteMany({});
});

const empty = async (): Promise<DispatchStats> => ({ done: 0, retried: 0, failed: 0 });

function job(name: string, schedule: string, extra: Partial<JobDef> & { took?: number; clock?: { t: number } } = {}) {
  const runs: (number | undefined)[] = [];
  const def: JobDef = {
    name,
    schedule,
    ...extra,
    handler: async (o) => {
      runs.push(o?.budgetMs);
      if (extra.clock && extra.took) extra.clock.t += extra.took;
    },
  };
  return { def, runs };
}

describe('ERP delta sync schedule', () => {
  it('runs every 2 minutes with a time budget', () => {
    const d = manifests.flatMap((m) => m.jobs ?? []).find((j) => j.name === 'erp.delta-sync')!;
    expect(d.schedule).toBe('*/2 * * * *');
    const reconcile = manifests.flatMap((m) => m.jobs ?? []).find((j) => j.name === 'erp.nightly-reconcile')!;
    expect(reconcile.heavy).toBe(true);
  });
});

describe('JobScheduler catch-up', () => {
  it('runs a slot the call missed, once', async () => {
    const a = job('a', '*/2 * * * *');
    const s = new JobScheduler([a.def]);
    expect(await s.tick(t.clock.now())).toEqual(['a']); // 10:07 → slot 10:06
    expect(await s.tick(t.clock.now())).toEqual([]); // same slot again: no
    expect((await JobModel.findById('a').lean())?.lastRunKey).toBe('2026-11-23T04:06');
    t.clock.set('2026-11-23T04:12:30Z');
    expect(await s.tick(t.clock.now())).toEqual(['a']); // next call 5 min later: slot 10:12
    expect(a.runs).toHaveLength(2);
    t.clock.set('2026-11-23T04:07:00Z');
  });

  it('runs a daily job late, but not outside its window, and never an older slot after a newer one', async () => {
    const d = job('daily', '0 10 * * *', { catchUpMin: 5 });
    const s = new JobScheduler([d.def]);
    expect(await s.tick(new Date('2026-11-23T04:04:00Z'))).toEqual(['daily']); // 10:04 Dhaka
    expect(await s.tick(new Date('2026-11-23T04:06:00Z'))).toEqual([]); // window over and already ran
    await JobModel.updateOne({ _id: 'daily' }, { $set: { lastRunKey: '2026-11-24T04:00' } });
    expect(await s.tick(new Date('2026-11-23T04:02:00Z'))).toEqual([]);
  });
});

describe('cronTick budget', () => {
  it('gives jobs the time left minus the outbox reserve, heavy jobs last, and starts nothing past the deadline', async () => {
    const clock = { t: 0 };
    const heavy = job('heavy', '*/2 * * * *', { heavy: true, took: 1_000, clock });
    const sync = job('sync', '*/2 * * * *', { took: 25_000, clock });
    const quick = job('quick', '* * * * *', { took: 100, clock });
    const r = await cronTick(new JobScheduler([heavy.def, sync.def, quick.def]), { deadline: 40_000, now: () => clock.t, dispatch: empty });
    expect(r.ran).toEqual(['sync', 'quick', 'heavy']);
    expect(sync.runs[0]).toBe(40_000 - OUTBOX_RESERVE_MS);
    expect(quick.runs[0]).toBe(40_000 - 25_000 - OUTBOX_RESERVE_MS);

    // A call that is already out of time runs no job; the slot stays for the next call.
    await JobModel.deleteMany({});
    clock.t = 0;
    const late = job('late', '*/2 * * * *');
    const r2 = await cronTick(new JobScheduler([late.def]), { deadline: OUTBOX_RESERVE_MS + 1_000, now: () => clock.t, dispatch: empty });
    expect(r2.ran).toEqual([]);
    expect(await JobModel.findById('late').lean()).toBeNull();
    const r3 = await cronTick(new JobScheduler([late.def]), { deadline: 40_000, now: () => clock.t, dispatch: empty });
    expect(r3.ran).toEqual(['late']);
  });

  it('a named job runs now with a budget', async () => {
    const n = job('named', '0 3 * * *');
    const r = await cronTick(new JobScheduler([n.def]), { deadline: 30_000, job: 'named', now: () => 0, dispatch: empty });
    expect(r.ran).toEqual(['named']);
    expect(n.runs[0]).toBe(30_000 - OUTBOX_RESERVE_MS);
  });
});
