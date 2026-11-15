import { Schema, model } from 'mongoose';
import { ctx } from '../context/index.js';
import { cronMatches } from './cron.js';

export interface JobDef {
  name: string;
  schedule: string; // cron, Asia/Dhaka
  handler: () => Promise<void>;
}

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

/** Mongo-leased job runner (ADR-008). Each job runs at most once per matching minute across workers. */
export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly jobs: JobDef[]) {}

  async tick(at: Date = ctx().clock.now()): Promise<string[]> {
    const ran: string[] = [];
    for (const job of this.jobs) {
      if (!cronMatches(job.schedule, at)) continue;
      if (await this.runIfFree(job, minuteKey(at))) ran.push(job.name);
    }
    return ran;
  }

  /** Run a job now regardless of schedule (admin/test). */
  async runNow(name: string): Promise<void> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`Unknown job ${name}`);
    await job.handler();
  }

  private async runIfFree(job: JobDef, key: string): Promise<boolean> {
    const now = ctx().clock.now();
    await JobModel.updateOne({ _id: job.name }, { $setOnInsert: { lastRunKey: null } }, { upsert: true });
    const claimed = await JobModel.findOneAndUpdate(
      {
        _id: job.name,
        lastRunKey: { $ne: key },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
      { $set: { lastRunKey: key, lockedUntil: new Date(now.getTime() + 15 * 60_000), lastStartedAt: now } },
    );
    if (!claimed) return false;
    try {
      await job.handler();
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
