import { ctx } from '../../core/context/index.js';
import { AppError } from '../../core/errors/index.js';
import { outboxCounts, setOutboxPaused, type OutboxResult } from '../../core/events/outbox.js';
import { getSetting } from '../settings/index.js';
import { LaravelErpClient } from './client/laravel-client.js';
import { MockErpClient } from './client/mock-client.js';
import { ErpSyncStateModel } from './models/sync-state.model.js';
import { ErpUnavailableError, type ErpClient, type ErpCustomer, type PostPaymentInput } from './types.js';

let client: ErpClient | null = null;

export function createClientFromConfig(): ErpClient {
  const c = ctx().config;
  if (c.ERP_MODE === 'mock') return new MockErpClient();
  return new LaravelErpClient({
    baseUrl: c.ERP_BASE_URL!,
    token: c.ERP_API_TOKEN!,
    nextToken: c.ERP_API_TOKEN_NEXT,
    timeoutMs: c.ERP_TIMEOUT_MS,
  });
}

export function erpClient(): ErpClient {
  if (!client) client = createClientFromConfig();
  return client;
}

/** Test/dev hook: replace the ERP client (e.g. a seeded MockErpClient). */
export function setErpClient(c: ErpClient): void {
  client = c;
}

export async function isRecordOnly(): Promise<boolean> {
  return ctx().config.ERP_MODE === 'record_only' || (await getSetting<boolean>('erp.recordOnly'));
}

async function markSuccess(id: string, cursor: string | null) {
  const now = ctx().clock.now();
  await ErpSyncStateModel.updateOne(
    { _id: id },
    { $set: { lastSuccessAt: now, consecutiveFailures: 0, lastError: null, lagSec: 0, ...(cursor ? { cursor } : {}) } },
    { upsert: true },
  );
}

async function markFailure(id: string, err: unknown) {
  await ErpSyncStateModel.updateOne(
    { _id: id },
    {
      $set: { lastErrorAt: ctx().clock.now(), lastError: err instanceof Error ? err.message : String(err) },
      $inc: { consecutiveFailures: 1 },
    },
    { upsert: true },
  );
}

export async function syncBranches(): Promise<number> {
  try {
    const branches = await erpClient().listBranches();
    await ctx().bus.emit('erp.branches.synced', { branches });
    await markSuccess('branches', null);
    return branches.length;
  } catch (e) {
    await markFailure('branches', e);
    throw e;
  }
}

/** Emit one customer to consumers (customers module upserts the read model). */
export async function publishCustomer(customer: ErpCustomer, opts: { reconcile?: boolean } = {}): Promise<void> {
  await ctx().bus.emit('erp.customer.synced', { customer, fetchedAt: ctx().clock.now(), reconcile: !!opts.reconcile });
}

/**
 * FR-ERP-002 delta sync: per ERP branch, customers changed since the watermark (60 s overlap
 * for clock skew / offset pagination, de-duplicated downstream by erpCustomerId).
 *
 * 1.17.0: `budgetMs` stops after the page that crosses the budget and remembers where it was (`resume` on the
 * branch's sync state), so a host with a short request limit (the manual "Sync from ERP" button on Vercel, 60 s)
 * finishes a first, full pull over several calls. The next run, manual or scheduled, continues from there and only
 * then moves the watermark. Without a budget the behaviour is as before.
 */
export async function deltaSync(opts: { budgetMs?: number } = {}): Promise<{ customers: number; branches: number; partial: boolean }> {
  const startedAtMs = ctx().clock.now().getTime();
  const overBudget = () => opts.budgetMs !== undefined && ctx().clock.now().getTime() - startedAtMs >= opts.budgetMs;
  const branches = await erpClient().listBranches();
  await ctx().bus.emit('erp.branches.synced', { branches });
  let total = 0;
  let pages = 0;
  let partial = false;
  for (const b of branches) {
    // always make progress: a run does at least one page, so a tiny budget cannot starve the sync
    if (pages > 0 && overBudget()) {
      partial = true;
      break;
    }
    const id = `customers:branch:${b.erpBranchId}`;
    const state = await ErpSyncStateModel.findById(id).lean();
    const resume = (state?.resume ?? null) as { cursor: string; since: string | null; serverTime: string | null } | null;
    const since = resume
      ? resume.since
      : state?.cursor
        ? new Date(new Date(state.cursor).getTime() - 60_000).toISOString()
        : null;
    const startedAt = ctx().clock.now();
    try {
      let cursor: string | null = resume?.cursor ?? null;
      let serverTime: string | null = resume?.serverTime ?? null;
      do {
        const page = await erpClient().listCustomers({
          erpBranchId: b.erpBranchId,
          updatedSince: since,
          cursor,
          pageSize: 100,
        });
        for (const c of page.items) await publishCustomer(c);
        total += page.items.length;
        pages += 1;
        cursor = page.nextCursor;
        // Watermark = server time of the FIRST page: rows changed while we paged are picked up next run.
        serverTime ??= page.serverTime;
        if (cursor && overBudget()) {
          await ErpSyncStateModel.updateOne({ _id: id }, { $set: { resume: { cursor, since, serverTime } } }, { upsert: true });
          partial = true;
          break;
        }
      } while (cursor);
      if (partial) break;
      await markSuccess(id, serverTime ?? startedAt.toISOString());
      if (resume) await ErpSyncStateModel.updateOne({ _id: id }, { $set: { resume: null } });
    } catch (e) {
      await markFailure(id, e);
      ctx().logger.warn({ err: e, erpBranchId: b.erpBranchId }, 'erp delta sync failed');
    }
  }
  return { customers: total, branches: branches.length, partial };
}

/**
 * 1.17.0 (owner request 2026-11-18): the admin panel's "Sync from ERP" button. One run at a time (a Mongo lock, so it
 * also holds across serverless instances); a run is cut at `budgetMs` and the answer says `partial: true`, so the
 * button calls again until it is false. ERP unreachable → `ERP_UNAVAILABLE`.
 */
export async function manualSync(budgetMs: number) {
  const now = ctx().clock.now();
  const lockUntil = new Date(now.getTime() + budgetMs + 20_000);
  try {
    const got = await ErpSyncStateModel.findOneAndUpdate(
      { _id: 'manual-sync', $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { $set: { lockedUntil: lockUntil } },
      { upsert: true, new: true },
    ).lean();
    if (!got) throw new AppError('RATE_LIMITED', { reason: 'SYNC_RUNNING', retryAfterSec: 10 });
  } catch (e) {
    // upsert collides with the existing locked document (duplicate _id) → somebody else is syncing
    if (e instanceof AppError) throw e;
    throw new AppError('RATE_LIMITED', { reason: 'SYNC_RUNNING', retryAfterSec: 10 });
  }
  const t0 = ctx().clock.now().getTime();
  try {
    const out = await deltaSync({ budgetMs });
    return { ...out, durationMs: ctx().clock.now().getTime() - t0, finishedAt: ctx().clock.now().toISOString() };
  } catch (e) {
    throw new AppError('ERP_UNAVAILABLE', { reason: e instanceof Error ? e.message.slice(0, 120) : 'unknown' });
  } finally {
    await ErpSyncStateModel.updateOne({ _id: 'manual-sync' }, { $set: { lockedUntil: null } });
  }
}

/** Nightly full reconcile: catches missed deltas and marks ERP-missing customers (never deletes). */
export async function reconcile(): Promise<number> {
  const branches = await erpClient().listBranches();
  let total = 0;
  for (const b of branches) {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await erpClient().listCustomers({ erpBranchId: b.erpBranchId, cursor, pageSize: 200 });
      for (const c of page.items) {
        await publishCustomer(c, { reconcile: true });
        seen.push(c.erpCustomerId);
      }
      cursor = page.nextCursor;
    } while (cursor);
    total += seen.length;
    await ctx().bus.emit('erp.reconcile.completed', { erpBranchId: b.erpBranchId, seenErpCustomerIds: seen });
  }
  await markSuccess('reconcile', null);
  return total;
}

/** ERP employees for linking FOS staff (users.erpEmployeeId). Read-through, nothing cached. */
export async function listErpEmployees() {
  const rows = await erpClient().listEmployees();
  return { items: rows.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)) };
}

export async function refreshCustomer(erpCustomerId: string): Promise<ErpCustomer | null> {
  const c = await erpClient().getCustomer(erpCustomerId);
  if (c) await publishCustomer(c);
  return c;
}

// ---------- payment posting (outbox handler) ----------

export interface PostPaymentJob {
  collectionId: string;
  input: Omit<PostPaymentInput, 'collectedAt'> & { collectedAt: string };
}

export async function handlePostPayment(payload: Record<string, unknown>, attempt: number): Promise<OutboxResult> {
  const job = payload as unknown as PostPaymentJob;
  const bus = ctx().bus;
  if (await isRecordOnly()) {
    await bus.emit('erp.payment.deferred', { collectionId: job.collectionId, reason: 'record_only' });
    return { status: 'done' };
  }
  const c = erpClient();
  if (c instanceof LaravelErpClient && !c.breaker.canRequest())
    return { status: 'retry', error: 'circuit open', delaySec: 60 };
  await bus.emit('erp.payment.posting', { collectionId: job.collectionId, attempt });
  try {
    // After an ambiguous failure, ask Laravel first so a stored payment is never posted twice.
    if (attempt > 1) {
      const found = await c.getPaymentByKey(job.input.idempotencyKey);
      if (found) {
        await bus.emit('erp.payment.posted', { collectionId: job.collectionId, result: found });
        return { status: 'done' };
      }
    }
  } catch (e) {
    if (e instanceof ErpUnavailableError) {
      await bus.emit('erp.payment.retrying', { collectionId: job.collectionId, error: e.message, attempt });
      return { status: 'retry', error: e.message };
    }
    throw e;
  }
  const res = await c.postPayment({ ...job.input, collectedAt: new Date(job.input.collectedAt) });
  switch (res.kind) {
    case 'posted':
      await bus.emit('erp.payment.posted', { collectionId: job.collectionId, result: res });
      return { status: 'done' };
    case 'business_error':
      await bus.emit('erp.payment.rejected', {
        collectionId: job.collectionId,
        code: res.code,
        message: res.message,
        details: res.details,
      });
      return { status: 'done' };
    case 'transient':
      await bus.emit('erp.payment.retrying', { collectionId: job.collectionId, error: res.error, attempt });
      return { status: 'retry', error: res.error, ...(res.retryAfterSec ? { delaySec: res.retryAfterSec } : {}) };
    case 'fatal':
      if (res.code === 'AUTH') {
        // Token/ability problem: pause posting so items are not burnt; ops alert via inbox.
        await setOutboxPaused('erp.post_payment', true);
        await bus.emit('erp.auth_failed', { error: res.error });
        return { status: 'retry', error: res.error, delaySec: 300 };
      }
      await bus.emit('erp.payment.failed', { collectionId: job.collectionId, code: res.code, error: res.error });
      return { status: 'failed', error: res.error };
  }
}

export async function onPostPaymentGaveUp(payload: Record<string, unknown>, error: string): Promise<void> {
  await ctx().bus.emit('erp.payment.failed', {
    collectionId: (payload as unknown as PostPaymentJob).collectionId,
    code: 'GAVE_UP',
    error,
  });
}

export async function resumePosting(): Promise<void> {
  await setOutboxPaused('erp.post_payment', false);
}

export async function status() {
  const states = await ErpSyncStateModel.find({ _id: { $regex: '^customers:branch:' } }).lean();
  const lastSuccess =
    states
      .map((s) => s.lastSuccessAt)
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const now = ctx().clock.now();
  const c = erpClient();
  const out = await outboxCounts('erp.post_payment');
  return {
    mode: (await isRecordOnly()) ? 'record_only' : c.mode,
    lastSuccessAt: lastSuccess ? lastSuccess.toISOString() : '',
    lagSec: lastSuccess ? Math.round((now.getTime() - lastSuccess.getTime()) / 1000) : -1,
    consecutiveFailures: Math.max(0, ...states.map((s) => s.consecutiveFailures ?? 0)),
    circuit: c instanceof LaravelErpClient ? c.breaker.state : 'closed',
    outboxPending: out.pending,
    outboxFailed: out.failed,
  } as const;
}
