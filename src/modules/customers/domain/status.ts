import { diffDays } from '../../../core/time/index.js';

/** Minimal plan shape the rules need (internal types, never Laravel names). */
export interface PlanInput {
  erpPlanId: string;
  endDate: string | null;
  outstandingPoisha: number;
  status: string;
  schedule: { seq: number; dueDate: string; amountPoisha: number; paidPoisha: number | null }[];
}

export type LineStatus = 'paid' | 'partial' | 'due' | 'overdue' | 'upcoming';

export interface LineDerived {
  seq: number;
  dueDate: string;
  amountPoisha: number;
  paidPoisha: number;
  outstandingPoisha: number;
  status: LineStatus;
  estimated: boolean;
}

export interface PlanDerived {
  erpPlanId: string;
  finalDueDate: string | null;
  badSuggested: boolean;
  lines: LineDerived[];
}

export interface CustomerDerived {
  totalOutstandingPoisha: number;
  overdue: boolean;
  daysOverdue: number;
  nextDueDate: string | null;
  dueToday: boolean;
  badSuggested: boolean;
  badReason: { erpPlanId: string; finalDueDate: string; outstandingPoisha: number } | null;
  overdueAmountPoisha: number;
  plans: PlanDerived[];
}

const IGNORED = new Set(['cancelled']);

/**
 * FR-TAG-001: final due date = plan end date from ERP, else the max schedule due date (E-05).
 * Never derived from an installment count or month arithmetic (CLAUDE.md §2.9).
 */
export function finalDueDate(p: PlanInput): string | null {
  if (p.endDate) return p.endDate;
  if (!p.schedule.length) return null;
  return p.schedule.reduce((m, l) => (l.dueDate > m ? l.dueDate : m), p.schedule[0]!.dueDate);
}

/**
 * Per-line paid amounts. When ERP gives them, use them. When it does not (E-07), allocate the
 * paid part oldest-first so that the ERP outstanding sits on the newest lines — display only, `estimated`.
 */
export function deriveLines(p: PlanInput, today: string): LineDerived[] {
  const lines = [...p.schedule].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.seq - b.seq);
  const estimated = lines.some((l) => l.paidPoisha === null);
  let paidPool = estimated ? Math.max(0, lines.reduce((s, l) => s + l.amountPoisha, 0) - p.outstandingPoisha) : 0;
  return lines.map((l) => {
    let paid: number;
    if (p.outstandingPoisha <= 0) paid = l.amountPoisha;
    else if (estimated) {
      paid = Math.min(l.amountPoisha, paidPool);
      paidPool -= paid;
    } else paid = Math.min(l.amountPoisha, Math.max(0, l.paidPoisha ?? 0));
    const out = l.amountPoisha - paid;
    let status: LineStatus;
    if (out <= 0) status = 'paid';
    else if (l.dueDate < today) status = 'overdue';
    else if (l.dueDate === today) status = 'due';
    else status = paid > 0 ? 'partial' : 'upcoming';
    return { seq: l.seq, dueDate: l.dueDate, amountPoisha: l.amountPoisha, paidPoisha: paid, outstandingPoisha: out, status, estimated };
  });
}

/** Overdue/due-today/bad-suggestion for one customer on a Dhaka business date (02-requirements §4.4). */
export function deriveCustomer(plans: PlanInput[], today: string): CustomerDerived {
  const active = plans.filter((p) => !IGNORED.has(p.status));
  const planDerived: PlanDerived[] = [];
  let oldestOverdue: string | null = null;
  let nextDue: string | null = null;
  let dueToday = false;
  let overdueAmount = 0;
  let bad: CustomerDerived['badReason'] = null;
  for (const p of active) {
    const fdd = finalDueDate(p);
    const lines = deriveLines(p, today);
    const isBad = !!fdd && fdd < today && p.outstandingPoisha > 0;
    if (isBad && (!bad || fdd < bad.finalDueDate)) bad = { erpPlanId: p.erpPlanId, finalDueDate: fdd, outstandingPoisha: p.outstandingPoisha };
    if (p.outstandingPoisha > 0) {
      for (const l of lines) {
        if (l.outstandingPoisha <= 0) continue;
        if (l.dueDate < today) {
          overdueAmount += l.outstandingPoisha;
          if (!oldestOverdue || l.dueDate < oldestOverdue) oldestOverdue = l.dueDate;
        } else {
          if (l.dueDate === today) dueToday = true;
          if (!nextDue || l.dueDate < nextDue) nextDue = l.dueDate;
        }
      }
      // A plan past its final date with balance left but no unpaid line (e.g. penalties) is still overdue.
      if (isBad && !lines.some((l) => l.outstandingPoisha > 0 && l.dueDate < today)) {
        overdueAmount += p.outstandingPoisha;
        if (!oldestOverdue || fdd! < oldestOverdue) oldestOverdue = fdd!;
      }
    }
    planDerived.push({ erpPlanId: p.erpPlanId, finalDueDate: fdd, badSuggested: isBad, lines });
  }
  return {
    totalOutstandingPoisha: active.reduce((s, p) => s + Math.max(0, p.outstandingPoisha), 0),
    overdue: !!oldestOverdue,
    daysOverdue: oldestOverdue ? diffDays(oldestOverdue, today) : 0,
    nextDueDate: nextDue,
    dueToday,
    badSuggested: !!bad,
    badReason: bad,
    overdueAmountPoisha: overdueAmount,
    plans: planDerived,
  };
}

export type CustomerStatus = 'overdue' | 'due_today' | 'promised_today' | 'paid_up' | 'current' | 'bad_suggested' | 'tagged_bad';

/** Badges for list items and the map colour key, worst first. */
export function badges(d: { overdue: boolean; dueToday: boolean; badSuggested: boolean; totalOutstandingPoisha: number }, opts: { promisedToday: boolean; tagged: boolean }): CustomerStatus[] {
  const out: CustomerStatus[] = [];
  if (opts.tagged) out.push('tagged_bad');
  if (d.badSuggested) out.push('bad_suggested');
  if (d.overdue) out.push('overdue');
  if (d.dueToday) out.push('due_today');
  if (opts.promisedToday) out.push('promised_today');
  if (!out.length) out.push(d.totalOutstandingPoisha === 0 ? 'paid_up' : 'current');
  return out;
}

const SEVERITY: CustomerStatus[] = ['tagged_bad', 'bad_suggested', 'overdue', 'due_today', 'promised_today', 'current', 'paid_up'];
export const worstStatus = (a: CustomerStatus[]): CustomerStatus => SEVERITY.find((s) => a.includes(s)) ?? 'current';
