import { z } from 'zod';
import { DateTime } from 'luxon';
import { ctx } from '../../core/context/index.js';
import { AppError, businessRule, notFound } from '../../core/errors/index.js';
import { isOid, withTransaction, type LeanDoc } from '../../core/db/index.js';
import type { RequestMeta } from '../../core/http/router.js';
import { storage } from '../../core/storage/index.js';
import { BUSINESS_TZ, businessDate } from '../../core/time/index.js';
import { poishaToDecimal } from '../../core/money/index.js';
import { branchQuery, type AuthUser } from '../../core/security/types.js';
import * as audit from '../audit/index.js';
import { getUsers, loadAuthUser } from '../users/index.js';
import { getBranches } from '../branches/index.js';
import { getCustomerRefs, overdueRows, scopeFilter as customerScope } from '../customers/index.js';
import { collectionRows } from '../collections/index.js';
import { attendanceDays } from '../attendance/index.js';
import { cashPositions } from '../cash/index.js';
import { reportRange, validRange } from './domain/period.js';
import { toCsv, type Cell } from './export/csv.js';
import { toXlsx } from './export/xlsx.js';
import { ExportModel } from './models/report.model.js';
import { branchInScope, performanceQuery, staffPerformance } from './trends.js';

const now = () => ctx().clock.now();
const today = () => businessDate(now());
const KEEP_DAYS = 7; // FR-REP-004
export const MAX_ROWS = 50_000;

export const exportSchema = z.object({
  type: z.enum(['staff_performance', 'collections', 'attendance', 'overdue_customers', 'cash_positions', 'audit']),
  format: z.enum(['csv', 'xlsx', 'pdf']),
  params: z.record(z.unknown()).default({}),
  locale: z.enum(['bn', 'en']).optional(),
});
type ExportType = z.infer<typeof exportSchema>['type'];

interface Table {
  header: string[];
  rows: Cell[][];
}
type L = 'bn' | 'en';
const h = (l: L, pairs: [string, string][]) => pairs.map(([bn, en]) => (l === 'bn' ? bn : en));
/** Money goes out as a plain taka number so a spreadsheet can sum it. */
const taka = (poisha: number) => Number(poishaToDecimal(poisha));
const dhaka = (d: Date | string | null, fmt = 'yyyy-MM-dd HH:mm') => (d ? DateTime.fromJSDate(typeof d === 'string' ? new Date(d) : d, { zone: BUSINESS_TZ }).toFormat(fmt) : null);
const nm = (n: { bn?: string; en?: string } | undefined, l: L) => (n ? (l === 'bn' ? n.bn || n.en : n.en || n.bn) || '' : '');

const rangeParams = z.object({ branchId: z.string().max(64).optional(), from: z.string().max(10), to: z.string().max(10) });
const branchParams = z.object({ branchId: z.string().max(64).optional() });

function parseParams<T extends z.ZodTypeAny>(schema: T, params: unknown): z.infer<T> {
  const r = schema.safeParse(params);
  if (!r.success) throw new AppError('VALIDATION_FAILED', { fields: r.error.issues.map((i) => ({ path: ['params', ...i.path].join('.'), message: i.message })) });
  return r.data;
}
function checkRange(p: { from: string; to: string }, maxDays: number) {
  if (!validRange(p.from, p.to, today(), maxDays)) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'params.to', message: `from..to must end today or earlier and span at most ${maxDays} days` }] });
}

/** Each dataset validates its own params (also at request time, so a bad request never becomes a failed job). */
const DATASETS: Partial<Record<ExportType, { check(user: AuthUser, params: unknown): void; build(user: AuthUser, params: unknown, l: L): Promise<Table> }>> = {
  staff_performance: {
    check(user, params) {
      const p = parseParams(performanceQuery, params);
      if (!reportRange(p.period, p.date, today())) throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'params.date', message: 'today or earlier' }] });
      branchInScope(user, p.branchId);
    },
    async build(user, params, l) {
      const rows = await staffPerformance(user, parseParams(performanceQuery, params));
      const sum = (r: (typeof rows)[number], ms: string[]) => ms.reduce((s, m) => s + (r.collectedPoisha[m] ?? 0), 0);
      const total = (r: (typeof rows)[number]) => Object.values(r.collectedPoisha).reduce((s, v) => s + v, 0);
      return {
        header: h(l, [['কর্মী', 'Staff'], ['সময়কাল', 'Period'], ['ভিজিট', 'Visits'], ['গ্রাহক', 'Customers visited'], ['কালেকশন সংখ্যা', 'Collections'], ['মোট আদায় (টাকা)', 'Collected (BDT)'], ['নগদ (টাকা)', 'Cash (BDT)'], ['মোবাইল ব্যাংকিং (টাকা)', 'Mobile banking (BDT)'], ['প্রতিশ্রুতি (নির্ধারিত)', 'Promises due'], ['প্রতিশ্রুতি (রক্ষিত)', 'Promises kept'], ['রক্ষার হার', 'Fulfilment rate'], ['উপস্থিত দিন', 'Present days'], ['দেরির দিন', 'Late days'], ['দেরি (মিনিট)', 'Late (min)'], ['বিরতি (মিনিট)', 'Break (min)'], ['মাঠে সময় (মিনিট)', 'Field time (min)'], ['দূরত্ব (কিমি)', 'Distance (km)']]),
        rows: rows.map((r) => [r.name, r.period, r.visits, r.uniqueCustomers, r.collectionsCount, taka(total(r)), taka(sum(r, ['cash'])), taka(sum(r, ['bkash', 'nagad', 'rocket', 'other_mobile'])), r.promisesDue, r.promisesKept, r.promiseFulfilmentRate, r.presentDays, r.lateDays, r.lateMin, r.breakMin, r.fieldMin, r.distanceKm]),
      };
    },
  },
  collections: {
    check(user, params) {
      const p = parseParams(rangeParams, params);
      checkRange(p, 92);
      branchInScope(user, p.branchId);
    },
    async build(user, params, l) {
      const p = parseParams(rangeParams, params);
      const rows = await collectionRows(user, branchInScope(user, p.branchId), p.from, p.to, MAX_ROWS);
      const customers = await getCustomerRefs(rows.map((r) => r.customerId));
      const users = await getUsers(rows.map((r) => r.collectorId));
      const branches = await getBranches([...new Set(rows.map((r) => r.branchId))]);
      return {
        header: h(l, [['রশিদ নং', 'Receipt no'], ['তারিখ', 'Date'], ['সময়', 'Time'], ['শাখা', 'Branch'], ['গ্রাহক কোড', 'Customer code'], ['গ্রাহক', 'Customer'], ['আদায়কারী', 'Collector'], ['পরিমাণ (টাকা)', 'Amount (BDT)'], ['মাধ্যম', 'Method'], ['অবস্থা', 'Status'], ['ERP রশিদ', 'ERP receipt']]),
        rows: rows.map((r) => [r.receiptNo, r.businessDate, dhaka(r.recordedAt, 'HH:mm'), branches.get(r.branchId)?.code ?? '', customers.get(r.customerId)?.code ?? '', nm(customers.get(r.customerId)?.name, l), nm(users.get(r.collectorId)?.name, l), taka(r.amountPoisha), r.method, r.status, r.erpReceiptNo]),
      };
    },
  },
  attendance: {
    check(user, params) {
      const p = parseParams(rangeParams, params);
      checkRange(p, 62);
      branchInScope(user, p.branchId);
    },
    async build(user, params, l) {
      const p = parseParams(rangeParams, params);
      const days = await attendanceDays(user, { branchId: branchInScope(user, p.branchId), from: p.from, to: p.to });
      const users = await getUsers(days.map((d) => d.userId));
      return {
        header: h(l, [['কর্মী', 'Staff'], ['কোড', 'Code'], ['তারিখ', 'Date'], ['অবস্থা', 'Status'], ['প্রথম প্রবেশ', 'First in'], ['শেষ প্রস্থান', 'Last out'], ['দেরি (মিনিট)', 'Late (min)'], ['বিরতি (মিনিট)', 'Break (min)'], ['ডিউটি (মিনিট)', 'Duty (min)'], ['চিহ্ন', 'Flags']]),
        rows: days.map((d) => [nm(users.get(d.userId)?.name, l), users.get(d.userId)?.employeeCode ?? '', d.businessDate, d.status, dhaka(d.firstIn, 'HH:mm'), dhaka(d.lastOut, 'HH:mm'), d.lateMin, d.breakMin, d.dutyMin, (d.flags as string[]).join(' ')]),
      };
    },
  },
  overdue_customers: {
    check(user, params) {
      branchInScope(user, parseParams(branchParams, params).branchId);
    },
    async build(user, params, l) {
      const branchId = branchInScope(user, parseParams(branchParams, params).branchId);
      const rows = await overdueRows({ ...customerScope(user), ...(branchId ? branchQuery(user, branchId) : {}) }, MAX_ROWS);
      const users = await getUsers(rows.map((r) => r.assigneeId ?? ''));
      const branches = await getBranches([...new Set(rows.map((r) => r.branchId))]);
      return {
        // Cached ERP figures: the last column says how old each one is (CLAUDE.md §2.1).
        header: h(l, [['গ্রাহক কোড', 'Customer code'], ['গ্রাহক', 'Customer'], ['শাখা', 'Branch'], ['দায়িত্বপ্রাপ্ত', 'Assigned to'], ['বকেয়া দিন', 'Days overdue'], ['বকেয়া (টাকা)', 'Overdue (BDT)'], ['পরবর্তী কিস্তির তারিখ', 'Next due date'], ['ট্যাগ', 'Tag'], ['ERP থেকে আনা হয়েছে', 'Fetched from ERP at']]),
        rows: rows.map((r) => [r.code, nm(r.name, l), branches.get(r.branchId)?.code ?? '', nm(users.get(r.assigneeId ?? '')?.name, l), r.daysOverdue, taka(r.overdueAmountPoisha), r.nextDueDate, r.tag, dhaka(r.erpFetchedAt)]),
      };
    },
  },
  cash_positions: {
    check(user, params) {
      branchInScope(user, parseParams(branchParams, params).branchId);
    },
    async build(user, params, l) {
      const rows = await cashPositions(user, branchInScope(user, parseParams(branchParams, params).branchId));
      return {
        header: h(l, [['কর্মী', 'Staff'], ['হাতে নগদ (টাকা)', 'Cash on hand (BDT)'], ['সীমা (টাকা)', 'Limit (BDT)'], ['অবস্থা', 'State'], ['সবচেয়ে পুরনো জমা-না-দেওয়া', 'Oldest undeposited'], ['অপেক্ষমাণ জমা (টাকা)', 'Pending deposits (BDT)'], ['আজ নগদ (টাকা)', 'Cash today (BDT)'], ['আজ মোবাইল (টাকা)', 'Mobile today (BDT)']]),
        rows: rows.map((r) => [r.userName, taka(r.onHandPoisha), taka(r.limitPoisha), r.state, dhaka(r.oldestUndepositedAt), taka(r.pendingDepositsPoisha), taka(r.todayCashPoisha), taka(r.todayMobilePoisha)]),
      };
    },
  },
};

const MIME = { csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } as const;

/** FR-REP-004: queue an export. The request is audited in the same transaction that stores it. */
export async function createExport(user: AuthUser, input: z.infer<typeof exportSchema>, meta: RequestMeta) {
  // PDF needs a Bangla shaping engine (OD-26); the audit dataset waits for its own review of what may leave the system.
  if (input.format === 'pdf') throw businessRule('export_format_unavailable', { format: 'pdf' });
  const ds = DATASETS[input.type];
  if (!ds) throw businessRule('export_type_unavailable', { type: input.type });
  ds.check(user, input.params);
  const at = now();
  const id = await withTransaction(async (session) => {
    const [doc] = await ExportModel.create([{ requestedBy: user.id, type: input.type, format: input.format, params: input.params, locale: input.locale ?? user.locale, status: 'queued', createdAt: at, expiresAt: new Date(at.getTime() + KEEP_DAYS * 86_400_000) }], { session });
    const exportId = doc!._id.toHexString();
    await audit.record({ actor: user, action: 'report.export.requested', entity: 'export', entityId: exportId, branchId: typeof input.params.branchId === 'string' ? input.params.branchId : null, after: { type: input.type, format: input.format, params: input.params }, meta }, session);
    return exportId;
  });
  return { id, status: 'queued' as const };
}

/** Only the person who asked can see an export; anyone else gets 404. The link lives 5 minutes. */
export async function getExport(user: AuthUser, id: string) {
  const e = isOid(id) ? ((await ExportModel.findOne({ _id: id, requestedBy: user.id }).lean()) as LeanDoc | null) : null;
  if (!e || e.expiresAt <= now()) throw notFound('export');
  return { id, status: e.status as string, ...(e.status === 'ready' && e.storageKey ? { downloadUrl: await storage().presignGet(e.storageKey) } : {}) };
}

/**
 * Worker job: build queued exports one at a time, with the requester's current scope and permissions
 * (someone deactivated or moved since asking gets nothing).
 */
export async function processExports(max = 5): Promise<number> {
  let done = 0;
  for (; done < max; done++) {
    const e = (await ExportModel.findOneAndUpdate({ status: 'queued' }, { $set: { status: 'running' } }, { sort: { createdAt: 1 }, new: true }).lean()) as LeanDoc | null;
    if (!e) break;
    const id = e._id.toHexString();
    try {
      const user = await loadAuthUser(e.requestedBy, 'export', 'web', null);
      const ds = DATASETS[e.type as ExportType];
      if (!user || !ds) throw new Error('requester or dataset no longer available');
      const l: L = e.locale === 'en' ? 'en' : 'bn';
      const table = await ds.build(user, e.params ?? {}, l); // an empty params object is not stored
      const format = e.format as keyof typeof MIME;
      const body = format === 'xlsx' ? toXlsx(e.type, table.header, table.rows) : toCsv(table.header, table.rows);
      const key = `exports/${id}/${e.type}-${today()}.${format}`;
      await storage().put(key, body, MIME[format]);
      await ExportModel.updateOne({ _id: e._id }, { $set: { status: 'ready', storageKey: key, rows: table.rows.length, finishedAt: now() } });
    } catch (err) {
      ctx().logger.warn({ exportId: id, err: err instanceof Error ? err.message : String(err) }, 'export failed');
      await ExportModel.updateOne({ _id: e._id }, { $set: { status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 300), finishedAt: now() } });
    }
  }
  return done;
}
