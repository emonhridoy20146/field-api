import { Schema, model } from 'mongoose';
import { ctx } from '../context/index.js';
import { latestSlot } from './cron.js';

export interface JobRunOptions {
  /** Time this run may take (ms). Set when a serverless cron call runs the job (ADR-034); a long job stops early. */
  budgetMs?: number;
}

export interface JobDef {
  name: string;
  schedule: string; // cron, Asia/Dhaka
  handler: (opts?: JobRunOptions) => Promise<void>;
  /**
   * 1.45.0: how late (minutes) a missed slot is still run. On Vercel jobs only run when /api/cron is called (every
   * 1–5 minutes, sometimes late), so a slot passed between two calls must still run once. Default 360 (6 h); a job
   * that must not run late (e.g. a snapshot before midnight) sets a small value.
   */
  catchUpMin?: number;
  /** Runs after the other due jobs of a cron call, so a long job cannot starve the quick ones (1.45.0). */
  heavy?: boolean;
}

export const DEFAULT_CATCH_UP_MIN = 360;

const jobSchema = new Schema(
  {
    _id: { type: String },
    lastRunKey: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    lastStartedAt: Date,
    lastFinishedAt: Date,
    lastError: { type: String, default: null },
    runs: { type: Number, default: 0 },
  },
  { collection: 'jobs', versionKey: false },
);
export const JobModel = model('Job', jobSchema);

const minuteKey = (d: Date) => d.toISOString().slice(0, 16);

export interface TickOptions {
  /** performance.now()-style deadline: no job starts after it, and each job gets the time left as its budget. */
  deadline?: number;
  now?: () => number;
  /** Keep this much of the time left for the outbox (ms); a job's budget is the time left minus this. */
  reserveMs?: number;
}

/**
 * Mongo-leased job runner (ADR-008). Each job runs at most once per schedule slot across workers.
 * 1.45.0: a slot is identified by its own minute (not the minute of the tick), and the latest slot within the job's
 * catch-up window runs if it has not run yet, so a tick that misses the exact minute (serverless cron called every
 * few minutes) still runs it once. ISO minute keys compare in time order, so an older slot never runs after a newer one.
 */
export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly jobs: JobDef[]) {}

  /** Jobs whose latest slot is due at `at`, quick ones first, with that slot. */
  due(at: Date): { job: JobDef; slot: Date }[] {
    const out: { job: JobDef; slot: Date }[] = [];
    for (const job of this.jobs) {
      const slot = latestSlot(job.schedule, at, job.catchUpMin ?? DEFAULT_CATCH_UP_MIN);
      if (slot) out.push({ job, slot });
    }
    return out.sort((a, b) => Number(!!a.job.heavy) - Number(!!b.job.heavy));
  }

  async tick(at: Date = ctx().clock.now(), opts: TickOptions = {}): Promise<string[]> {
    const ran: string[] = [];
    const now = opts.now ?? (() => performance.now());
    for (const { job, slot } of this.due(at)) {
      let budgetMs: number | undefined;
      if (opts.deadline !== undefined) {
        const left = opts.deadline - now() - (opts.reserveMs ?? 0);
        // Not started: its slot stays unclaimed and the next call runs it.
        if (left < 2_000) break;
        budgetMs = left;
      }
      if (await this.runIfFree(job, minuteKey(slot), budgetMs)) ran.push(job.name);
    }
    return ran;
  }

  /** Run a job now regardless of schedule (admin/test). */
  async runNow(name: string, opts: JobRunOptions = {}): Promise<void> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`Unknown job ${name}`);
    await job.handler(opts);
  }

  private async runIfFree(job: JobDef, key: string, budgetMs?: number): Promise<boolean> {
    const now = ctx().clock.now();
    await JobModel.updateOne({ _id: job.name }, { $setOnInsert: { lastRunKey: null } }, { upsert: true });
    const claimed = await JobModel.findOneAndUpdate(
      {
        _id: job.name,
        $and: [{ $or: [{ lastRunKey: null }, { lastRunKey: { $lt: key } }] }, { $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] }],
      },
      { $set: { lastRunKey: key, lockedUntil: new Date(now.getTime() + 15 * 60_000), lastStartedAt: now } },
    );
    if (!claimed) return false;
    try {
      await job.handler(budgetMs !== undefined ? { budgetMs } : {});
      await JobModel.updateOne({ _id: job.name }, { $set: { lockedUntil: null, lastFinishedAt: ctx().clock.now(), lastError: null }, $inc: { runs: 1 } });
    } catch (err) {
      ctx().logger.error({ err, job: job.name }, 'job failed');
      await JobModel.updateOne({ _id: job.name }, { $set: { lockedUntil: null, lastError: String(err) } });
    }
    return true;
  }

  start(intervalMs = 20_000): void {
    this.timer = setInterval(() => void this.tick().catch((err) => ctx().logger.error({ err }, 'tick failed')), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

