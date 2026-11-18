import { describe, expect, it } from 'vitest';
import { badges, deriveCustomer, deriveLines, finalDueDate, isBadTag, payState, worstPayState, worstStatus, type PlanInput } from '../domain/status.js';
import { businessDate } from '../../../core/time/index.js';

/** Builds a plan of n monthly lines starting at `start` without any month arithmetic in the rule itself. */
function plan(id: string, dueDates: string[], amount: number, paidLines: number, opts: Partial<PlanInput> = {}): PlanInput {
  const schedule = dueDates.map((d, i) => ({ seq: i + 1, dueDate: d, amountPoisha: amount, paidPoisha: i < paidLines ? amount : 0 }));
  const outstanding = (dueDates.length - paidLines) * amount;
  return { erpPlanId: id, endDate: dueDates[dueDates.length - 1]!, outstandingPoisha: outstanding, status: 'active', schedule, ...opts };
}

const months = (y: number, m: number, n: number, day = 10) =>
  Array.from({ length: n }, (_, i) => {
    const mm = m - 1 + i;
    return `${y + Math.floor(mm / 12)}-${String((mm % 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  });

describe('bad-customer suggestion (FR-TAG-001)', () => {
  const today = '2026-11-15';
  it('final due yesterday + 1 poisha outstanding → suggested', () => {
    const p = plan('P', ['2026-11-14'], 100, 0, { outstandingPoisha: 1 });
    expect(deriveCustomer([p], today).badSuggested).toBe(true);
  });
  it('final due today → not suggested (strictly passed)', () => {
    expect(deriveCustomer([plan('P', ['2026-11-15'], 100, 0)], today).badSuggested).toBe(false);
  });
  it('outstanding 0 → not suggested', () => {
    expect(deriveCustomer([plan('P', ['2026-10-01'], 100, 1)], today).badSuggested).toBe(false);
  });
  it('two plans, one qualifies → suggested with that plan as reason', () => {
    const d = deriveCustomer([plan('A', months(2026, 10, 12), 100, 1), plan('B', months(2026, 6, 3), 100, 2)], today);
    expect(d.badSuggested).toBe(true);
    expect(d.badReason).toEqual({ erpPlanId: 'B', finalDueDate: '2026-08-10', outstandingPoisha: 100 });
  });
  it('no end_date → uses max schedule due date (E-05)', () => {
    const p = plan('P', ['2026-09-01', '2026-10-01'], 100, 1, { endDate: null });
    expect(finalDueDate(p)).toBe('2026-10-01');
    expect(deriveCustomer([p], today).badSuggested).toBe(true);
  });
  it.each([3, 5, 6, 12, 18])('%i-installment plans work without month logic', (n) => {
    const dates = months(2025, 12, n);
    const p = plan('P', dates, 100, n - 1);
    const fdd = dates[n - 1]!;
    expect(deriveCustomer([p], today).badSuggested).toBe(fdd < today);
  });
  it('timezone: 2026-11-14T18:30Z is 15 Nov in Dhaka', () => {
    const d = businessDate(new Date('2026-11-14T18:30:00Z'));
    expect(d).toBe('2026-11-15');
    expect(deriveCustomer([plan('P', ['2026-11-14'], 100, 0)], d).badSuggested).toBe(true);
    expect(deriveCustomer([plan('P', ['2026-11-14'], 100, 0)], businessDate(new Date('2026-11-14T17:59:00Z'))).badSuggested).toBe(false);
  });
  it('cancelled plans are ignored', () => {
    expect(deriveCustomer([plan('P', ['2026-01-01'], 100, 0, { status: 'cancelled' })], today).badSuggested).toBe(false);
  });
});

describe('overdue / due today', () => {
  const today = '2026-11-15';
  it('line due today unpaid → dueToday, nextDueDate today', () => {
    const d = deriveCustomer([plan('P', ['2026-10-15', '2026-11-15', '2026-12-15'], 100, 1)], today);
    expect(d).toMatchObject({ dueToday: true, overdue: false, nextDueDate: '2026-11-15', daysOverdue: 0, totalOutstandingPoisha: 200 });
  });
  it('daysOverdue counts from the oldest unpaid line', () => {
    const d = deriveCustomer([plan('P', ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01'], 100, 1)], today);
    expect(d.overdue).toBe(true);
    expect(d.daysOverdue).toBe(45);
    expect(d.overdueAmountPoisha).toBe(200);
  });
  it('partial payment on a line', () => {
    const p: PlanInput = { erpPlanId: 'P', endDate: '2026-12-01', outstandingPoisha: 150, status: 'active', schedule: [{ seq: 1, dueDate: '2026-12-01', amountPoisha: 200, paidPoisha: 50 }] };
    expect(deriveLines(p, today)[0]).toMatchObject({ status: 'partial', paidPoisha: 50, outstandingPoisha: 150, estimated: false });
  });
  it('estimated allocation oldest-first when per-line paid is unknown (E-07)', () => {
    const p: PlanInput = {
      erpPlanId: 'P', endDate: null, outstandingPoisha: 250, status: 'active',
      schedule: [1, 2, 3].map((i) => ({ seq: i, dueDate: `2026-1${i - 1}-01`, amountPoisha: 100, paidPoisha: null })),
    };
    const lines = deriveLines(p, today);
    expect(lines.map((l) => l.paidPoisha)).toEqual([50, 0, 0]);
    expect(lines.every((l) => l.estimated)).toBe(true);
    expect(lines.map((l) => l.status)).toEqual(['overdue', 'overdue', 'upcoming']);
  });
  it('plan past final date with balance but all lines paid is still overdue', () => {
    const p: PlanInput = { erpPlanId: 'P', endDate: '2026-10-01', outstandingPoisha: 500, status: 'active', schedule: [{ seq: 1, dueDate: '2026-10-01', amountPoisha: 100, paidPoisha: 100 }] };
    const d = deriveCustomer([p], today);
    expect(d.overdue).toBe(true);
    expect(d.daysOverdue).toBe(45);
  });
});

describe('badges', () => {
  it('orders worst first and falls back to paid_up/current', () => {
    const b = badges({ overdue: true, dueToday: false, badSuggested: true, totalOutstandingPoisha: 1 }, { promisedToday: true, tagged: false });
    expect(b).toEqual(['bad_suggested', 'overdue', 'promised_today']);
    expect(worstStatus(b)).toBe('bad_suggested');
    expect(badges({ overdue: false, dueToday: false, badSuggested: false, totalOutstandingPoisha: 0 }, { promisedToday: false, tagged: false })).toEqual(['paid_up']);
    expect(badges({ overdue: false, dueToday: false, badSuggested: false, totalOutstandingPoisha: 9 }, { promisedToday: false, tagged: false })).toEqual(['current']);
  });
});

describe('missed installments and pin colour (FR-CUS-012, ADR-035)', () => {
  const today = '2026-11-15';
  const line = (seq: number, dueDate: string, amountPoisha: number, paidPoisha: number, extra: Record<string, unknown> = {}) => ({ seq, dueDate, amountPoisha, paidPoisha, ...extra });
  const of = (schedule: ReturnType<typeof line>[], outstandingPoisha: number, endDate: string | null = null): PlanInput => ({ erpPlanId: 'P', endDate, outstandingPoisha, status: 'active', schedule });

  it('counts past lines with money left; today and later lines are not missed', () => {
    const d = deriveCustomer([of([line(1, '2026-09-10', 100, 100), line(2, '2026-10-10', 100, 40), line(3, '2026-11-10', 100, 0), line(4, '2026-11-15', 100, 0), line(5, '2026-12-10', 100, 0)], 360)], today);
    expect(d.missedCount).toBe(2);
    expect(d.plans[0]!.missedCount).toBe(2);
    expect(d.plans[0]!.lines.map((l) => l.missed)).toEqual([false, true, true, false, false]);
    expect(d.plans[0]!.lines.map((l) => l.daysLate)).toEqual([0, 36, 5, 0, 0]);
  });

  it('a line the ERP rolled forward counts while the line that took its balance is unpaid', () => {
    const rolled = { rolled: true };
    // Sep and Oct were missed and rolled onto Dec (not due yet): two missed installments.
    const behind = of([line(1, '2026-09-10', 0, 0, rolled), line(2, '2026-10-10', 0, 0, rolled), line(3, '2026-12-10', 300, 0)], 300);
    expect(deriveCustomer([behind], today).missedCount).toBe(2);
    // Once the carrier line is paid, the customer has caught up.
    const caughtUp = of([line(1, '2026-09-10', 0, 0, rolled), line(2, '2026-10-10', 0, 0, rolled), line(3, '2026-12-10', 300, 300), line(4, '2027-01-10', 100, 0)], 100);
    expect(deriveCustomer([caughtUp], today).missedCount).toBe(0);
  });

  it('paid date and days late come from the ERP payments on the line', () => {
    const p = of([line(1, '2026-10-10', 100, 100, { payments: [{ date: '2026-10-12', amountPoisha: 60 }, { date: '2026-10-20', amountPoisha: 40 }] }), line(2, '2026-12-10', 100, 0)], 100);
    const l = deriveCustomer([p], today).plans[0]!.lines[0]!;
    expect(l.paidOn).toBe('2026-10-20');
    expect(l.daysLate).toBe(10);
    expect(deriveLines(of([line(1, '2026-10-10', 100, 100)], 0), today)[0]!.paidOn).toBeNull();
  });

  it('pin colours, worst first', () => {
    const base = { badSuggested: false, missedCount: 0, dueToday: false, totalOutstandingPoisha: 500 };
    expect(payState(base, { badTag: true })).toBe('bad');
    expect(payState({ ...base, badSuggested: true }, { badTag: false })).toBe('bad');
    expect(payState({ ...base, missedCount: 3 }, { badTag: false })).toBe('missed_many');
    expect(payState({ ...base, missedCount: 1, dueToday: true }, { badTag: false })).toBe('missed_one');
    expect(payState({ ...base, dueToday: true }, { badTag: false })).toBe('due_today');
    expect(payState(base, { badTag: false })).toBe('on_track');
    expect(payState({ ...base, totalOutstandingPoisha: 0 }, { badTag: false })).toBe('paid_off');
    expect(worstPayState(['on_track', 'missed_one', 'paid_off'])).toBe('missed_one');
  });

  it('a credit sale past its due date is a full term over → red; a watch tag alone is not', () => {
    const credit = of([line(1, '2026-11-01', 5000, 1000)], 4000, '2026-11-01');
    const d = deriveCustomer([credit], today);
    expect(payState(d, { badTag: false })).toBe('bad');
    expect(isBadTag({ state: 'tagged', severity: 'watch' })).toBe(false);
    expect(isBadTag({ state: 'tagged', severity: 'legal' })).toBe(true);
    expect(isBadTag({ state: 'tagged' })).toBe(true);
    expect(isBadTag({ state: 'none' })).toBe(false);
  });
});
