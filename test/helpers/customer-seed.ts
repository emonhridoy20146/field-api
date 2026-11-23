import { expect } from 'vitest';
import type { as } from './app.js';

/** 1.46.0 paging tests: a seeded set of heavy customer documents (fake names and phones). */
export const N_A = 1250;
export const N_B = 30;

export type PagingRow = {
  id: string;
  erpCustomerId: string;
  name: { en: string };
  daysOverdue: number;
  totalOutstandingPoisha: number;
  nextDueDate: string | null;
  payState: string;
};

/** A realistic heavy document: two plans with 60 schedule lines each, a guarantor and a risk snapshot. */
export function seedDoc(i: number, branchId: string, prefix: string, fs1: string) {
  const outstanding = (i % 7) * 100_000;
  const plan = (n: number) => ({
    erpPlanId: `${prefix}${i}-${n}`,
    kind: n === 1 && i % 5 === 0 ? 'credit' : 'installment',
    status: outstanding > 0 ? 'active' : 'closed',
    outstandingPoisha: n === 0 ? outstanding : 0,
    schedules: Array.from({ length: 60 }, (_, k) => ({
      date: `2026-${String((k % 12) + 1).padStart(2, '0')}-15`,
      amountPoisha: 50_000,
      paidPoisha: 0,
      note: 'x'.repeat(40),
    })),
  });
  return {
    erpCustomerId: `${prefix}${String(i).padStart(5, '0')}`,
    branchId,
    erpBranchId: prefix,
    code: `C${prefix}${i}`,
    // Duplicate names on purpose: the _id tie-break must keep pages from overlapping.
    name: { en: `Customer ${String(i % 400).padStart(3, '0')}`, bn: '' },
    phones: [`017${String(10_000_000 + i).slice(-8)}`],
    address: 'Barishal',
    guarantor: { name: 'Fake Guarantor', phone: '01700000000', address: 'y'.repeat(200) },
    erpRisk: { grade: 'B', notes: 'z'.repeat(300) },
    location: { type: 'Point', coordinates: [90.37 + (i % 50) / 1000, 22.71 + Math.floor(i / 50) / 1000] },
    locationStatus: 'ok',
    plans: [plan(0), plan(1)],
    recentPayments: [{ date: '2026-11-02', amountPoisha: 10_000, reversed: false, collectorName: 'Fake Collector' }],
    derived: {
      totalOutstandingPoisha: outstanding,
      overdue: i % 3 === 0 && outstanding > 0,
      daysOverdue: i % 3 === 0 && outstanding > 0 ? (i % 90) + 1 : 0,
      overdueAmountPoisha: 0,
      nextInstallmentPoisha: outstanding > 0 ? 50_000 : null,
      nextDueDate: outstanding > 0 ? `2026-12-${String((i % 28) + 1).padStart(2, '0')}` : null,
      dueToday: false,
      badSuggested: false,
      missedCount: i % 3 === 0 && outstanding > 0 ? 1 : 0,
      plans: [{ lines: Array.from({ length: 60 }, () => ({ status: 'upcoming', amountPoisha: 50_000 })) }],
    },
    erpStatus: 'active',
    erpFetchedAt: new Date('2026-11-15T03:00:00Z'),
    fos: { assigneeId: i % 4 === 0 ? fs1 : null, areaId: null, tag: null, openPromiseDates: [], extraPhones: [] },
  };
}

export type Client = Awaited<ReturnType<typeof as>>;

/** Walks the whole list with the given page size through `offset` and returns every id in order. */
export async function walk(c: Client, query: string, size: number): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += size) {
    const r = await c.get(`/customers?${query}&limit=${size}&offset=${offset}`);
    expect(r.status).toBe(200);
    out.push(...r.body.items.map((x: PagingRow) => x.id));
    if (!r.body.nextCursor) break;
  }
  return out;
}
