import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { as, createTestApp, handIn, seedBasics, type Seeded, type TestApp } from '../helpers/app.js';
import { expectConforms } from '../helpers/openapi.js';
import { deltaSync } from '../../src/modules/erp-gateway/index.js';
import { applyAssignments, getByErpId } from '../../src/modules/customers/index.js';
import { setFlagSystem } from '../../src/modules/flags/index.js';

// Contract 1.33.0 (FR-COL-017): the office sees who withdrew or voided a collection, that and how it was edited,
// and the activity feed has a line for a withdrawal, an edit and a deleted deposit.
let t: TestApp;
let s: Seeded;
let cust = '';
let seq = 100;
type Client = Awaited<ReturnType<typeof as>>;
type Line = { type: string; actor: { id: string } | null; by: { id: string; name: { en?: string; bn?: string } } | null; customer: { id: string } | null; entity: string; entityId: string; data: Record<string, unknown> };
const collect = async (c: Client, amountPoisha: number) =>
  c.post(
    '/collections',
    { clientId: randomUUID(), customerId: cust, amountPoisha, method: 'cash', receiptNo: `BRL01-FS014-261115-${String(++seq).padStart(4, '0')}`, recordedAt: '2026-11-15T03:00:00Z', geo: { lat: 22.7, lng: 90.36, accuracyM: 10 } },
    { 'idempotency-key': randomUUID() },
  );
const feed = async (c: Client, type: string) => ((await c.get(`/activity?type=${type}`)).body.items as Line[]);

beforeAll(async () => {
  t = await createTestApp();
  s = await seedBasics(t);
  await deltaSync();
  cust = (await getByErpId('100246'))!.id;
  await applyAssignments([{ customerId: cust, assigneeId: s.fs1.id }]);
  await setFlagSystem('module.activity', true);
});
afterAll(async () => t.close());

describe('who voided it and how (voided.kind / byName)', () => {
  it('a collector withdrawing is "withdrawn"; an office void is "admin"; both name the person', async () => {
    const fs = await as(t, '01700000003');
    const bm = await as(t, '01700000002');
    const a = (await collect(fs, 120_000)).body.id as string;
    const b = (await collect(fs, 130_000)).body.id as string;

    const w = await fs.post(`/collections/${a}/withdraw`, { reason: 'wrong customer' });
    expect(w.body.voided).toMatchObject({ by: s.fs1.id, kind: 'withdrawn', reason: 'wrong customer' });
    expect(w.body.voided.byName).toBeTruthy();

    const v = await bm.post(`/collections/${b}/void`, { reason: 'entered twice by the office' });
    expect(v.status).toBe(200);
    const read = await bm.get(`/collections/${b}`);
    expectConforms('GET', '/collections/{id}', 200, read.body);
    expect(read.body.voided).toMatchObject({ by: s.bm.id, kind: 'admin', reason: 'entered twice by the office' });
    expect(read.body.voided.byName).toBeTruthy();

    // the same payload reaches the list the office uses
    const list = (await bm.get('/collections?status=voided')).body.items as { id: string; voided: { kind: string } }[];
    expect(Object.fromEntries(list.filter((c) => [a, b].includes(c.id)).map((c) => [c.id, c.voided.kind]))).toEqual({ [a]: 'withdrawn', [b]: 'admin' });
  });
});

describe('edited marker (edited.count / previousAmountPoisha)', () => {
  it('keeps the FIRST original amount across edits and counts them; a repeat of the same values is not an edit', async () => {
    const fs = await as(t, '01700000003');
    const id = (await collect(fs, 200_000)).body.id as string;
    expect((await fs.get(`/collections/${id}`)).body.edited).toBeUndefined();

    const e1 = await fs.patch(`/collections/${id}`, { amountPoisha: 180_000 });
    expectConforms('PATCH', '/collections/{id}', 200, e1.body);
    expect(e1.body.edited).toMatchObject({ count: 1, by: s.fs1.id, previousAmountPoisha: 200_000 });
    expect(e1.body.edited.byName).toBeTruthy();
    const e2 = await fs.patch(`/collections/${id}`, { amountPoisha: 150_000, note: 'again' });
    expect(e2.body.edited).toMatchObject({ count: 2, previousAmountPoisha: 200_000 });
    expect((await fs.patch(`/collections/${id}`, { amountPoisha: 150_000, note: 'again' })).body.edited.count).toBe(2);

    // the office reads it too
    const bm = await as(t, '01700000002');
    expect((await bm.get(`/collections/${id}`)).body.edited).toMatchObject({ count: 2, previousAmountPoisha: 200_000 });
  });
});

describe('the admin activity feed has lines for the new actions (FR-ACT-001)', () => {
  it('a withdrawal and each edit appear, with the staff member, customer and amount (deposits are final since 1.35.0)', async () => {
    const fs = await as(t, '01700000003');
    const bm = await as(t, '01700000002');
    const sa = await as(t, '01700000001');
    const c = (await collect(fs, 300_000)).body.id as string;
    await fs.patch(`/collections/${c}`, { amountPoisha: 280_000 });
    await fs.patch(`/collections/${c}`, { amountPoisha: 270_000 });
    await fs.post(`/collections/${c}/withdraw`, {});
    const dep = await handIn(fs);
    expect(dep.status).toBe(201);
    expect((await bm.post(`/cash/deposits/${dep.body.id}/delete`, { reason: 'entered by mistake' })).status).toBe(409);

    const edits = (await feed(sa, 'collection_edited')).filter((l) => l.entityId === c);
    expect(edits).toHaveLength(2);
    expect(edits.map((l) => l.data.editCount).sort()).toEqual([1, 2]);
    expect(edits.find((l) => l.data.editCount === 2)?.data).toMatchObject({ amountPoisha: 270_000, previousAmountPoisha: 280_000 });
    expect(edits[0]).toMatchObject({ actor: { id: s.fs1.id }, customer: { id: cust }, entity: 'collection' });

    const withdrawn = (await feed(sa, 'collection_withdrawn')).find((l) => l.entityId === c);
    expect(withdrawn).toMatchObject({ actor: { id: s.fs1.id }, customer: { id: cust }, data: { amountPoisha: 270_000, method: 'cash' } });

    expect((await feed(sa, 'deposit_deleted')).find((l) => l.entityId === dep.body.id)).toBeUndefined();

    const all = await sa.get('/activity');
    expectConforms('GET', '/activity', 200, all.body);
    expect((all.body.items as Line[]).map((l) => l.type)).toEqual(expect.arrayContaining(['collection_edited', 'collection_withdrawn']));
  });
});
