import { timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../core/config/index.js';
import { connectMongo, mongoose } from '../core/db/index.js';
import { dispatchOutbox, type DispatchStats } from '../core/events/outbox.js';
import { JobScheduler } from '../core/jobs/index.js';
import type { AppContext } from '../core/context/index.js';
import { buildApp } from './build-app.js';

/**
 * Serverless adapter for a **test** deployment on Vercel (ADR-034). Production stays on the
 * long-running api + worker processes of ADR-011. A function instance is reused between requests,
 * so the Mongo connection and the built app are cached in module scope; concurrent cold requests
 * share one boot promise instead of booting twice.
 */
let booting: Promise<{ app: FastifyInstance; ctx: AppContext }> | null = null;

async function boot(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const config = loadConfig();
  // Ephemeral keys would differ per instance, so a token signed by one instance fails on another.
  if (!config.JWT_PRIVATE_KEY || !config.JWT_PUBLIC_KEY) throw new Error('Serverless needs JWT_PRIVATE_KEY and JWT_PUBLIC_KEY (pnpm keys:jwt)');
  if (mongoose.connection.readyState === 0) await connectMongo(config.MONGODB_URI, config.MONGODB_DB_NAME);
  const built = await buildApp({ config });
  await built.app.ready();
  return built;
}

function getApp(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  if (!booting) {
    booting = boot().catch((err: unknown) => {
      booting = null; // let the next request retry instead of caching the failure
      throw err;
    });
  }
  return booting;
}

/**
 * A reused function instance can lose its Mongo connection (the instance is frozen between requests, Atlas
 * closes idle sockets); the app was cached, so nothing connected again and health stayed `mongo: down` while
 * every write (photos included) failed. Reconnect before handling the request. Never throws: if Mongo is
 * really unreachable the request still runs and health reports it.
 */
export async function ensureMongo(
  conn: { readyState: number; asPromise: () => Promise<unknown> },
  connect: () => Promise<unknown>,
  warn: (msg: string) => void,
): Promise<void> {
  try {
    if (conn.readyState === 1) return;
    if (conn.readyState === 2) await conn.asPromise(); // already connecting
    else if (conn.readyState === 0) await connect();
  } catch (err) {
    warn(`mongo reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Vercel function body for every API route. */
export async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { app, ctx } = await getApp();
  await ensureMongo(mongoose.connection, () => connectMongo(ctx.config.MONGODB_URI, ctx.config.MONGODB_DB_NAME), (m) => ctx.logger.warn(m));
  app.server.emit('request', req, res);
}

/** Constant-time check of `Authorization: Bearer <CRON_SECRET>` (the header Vercel Cron sends). */
export function cronAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header?.startsWith('Bearer ')) return false;
  const a = createHash('sha256').update(header.slice(7)).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export interface CronResult {
  ran: string[];
  outbox: DispatchStats;
}

/**
 * One worker "tick" inside a function call: the jobs whose schedule matches this minute (or the
 * one named job), then the outbox until it is empty or the time budget is spent. Jobs are leased
 * in Mongo (ADR-008), so overlapping calls never run a job twice in the same minute.
 */
export async function runCron(opts: { job?: string; budgetMs?: number } = {}): Promise<CronResult> {
  // The budget counts from the start of the call, jobs included: the function is stopped at 60 s
  // (vercel.json maxDuration), so slow jobs leave less time for the outbox, never more.
  const deadline = performance.now() + (opts.budgetMs ?? 40_000);
  const { ctx } = await getApp();
  await ensureMongo(mongoose.connection, () => connectMongo(ctx.config.MONGODB_URI, ctx.config.MONGODB_DB_NAME), (m) => ctx.logger.warn(m));
  const scheduler = new JobScheduler(ctx.manifests.flatMap((m) => m.jobs ?? []));
  let ran: string[];
  if (opts.job) {
    await scheduler.runNow(opts.job);
    ran = [opts.job];
  } else {
    ran = await scheduler.tick();
  }
  return { ran, outbox: await drainOutbox(deadline) };
}

/**
 * Runs outbox batches until the outbox is empty or `deadline` (a performance.now() value) has
 * passed. Batches are small so the deadline is checked often: one ERP post can take up to
 * ERP_TIMEOUT_MS. An item cut off by the 60 s stop keeps its lease and is retried later with
 * the same idempotency key, so this only bounds delay, not correctness.
 */
export async function drainOutbox(
  deadline: number,
  dispatch: (limit: number) => Promise<DispatchStats> = dispatchOutbox,
  now: () => number = () => performance.now(),
): Promise<DispatchStats> {
  const outbox: DispatchStats = { done: 0, retried: 0, failed: 0 };
  while (now() < deadline) {
    const s = await dispatch(5);
    outbox.done += s.done;
    outbox.retried += s.retried;
    outbox.failed += s.failed;
    if (s.done + s.retried + s.failed === 0) break;
  }
  return outbox;
}

export function knownJobs(ctx: AppContext): string[] {
  return ctx.manifests.flatMap((m) => (m.jobs ?? []).map((j) => j.name));
}

export async function listJobs(): Promise<string[]> {
  const { ctx } = await getApp();
  return knownJobs(ctx);
}
