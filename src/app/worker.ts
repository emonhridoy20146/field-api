import { dispatchOutbox } from '../core/events/outbox.js';
import { JobScheduler } from '../core/jobs/index.js';
import type { AppContext } from '../core/context/index.js';

/** Worker process: scheduled jobs + outbox dispatcher (ADR-008, ADR-011). */
export function startWorker(ctx: AppContext): { stop: () => void; scheduler: JobScheduler } {
  const scheduler = new JobScheduler(ctx.manifests.flatMap((m) => m.jobs ?? []));
  scheduler.start(20_000);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    dispatchOutbox(50)
      .catch((err) => ctx.logger.error({ err }, 'outbox dispatch failed'))
      .finally(() => (running = false));
  }, 5_000);
  ctx.logger.info({ jobs: ctx.manifests.flatMap((m) => (m.jobs ?? []).map((j) => j.name)) }, 'worker started');
  return {
    scheduler,
    stop: () => {
      clearInterval(timer);
      scheduler.stop();
    },
  };
}
