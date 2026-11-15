import type { Logger } from '../logger/index.js';

export type EventHandler = (payload: Record<string, unknown>) => Promise<void> | void;

/**
 * In-process event bus. Handlers run sequentially after the emitter's transaction commits.
 * Durable side effects (ERP posting, push) must go through the outbox instead.
 */
export class EventBus {
  private handlers = new Map<string, EventHandler[]>();
  constructor(private readonly logger: Logger) {}

  on(name: string, handler: EventHandler): void {
    const list = this.handlers.get(name) ?? [];
    list.push(handler);
    this.handlers.set(name, list);
  }

  async emit(name: string, payload: Record<string, unknown>): Promise<void> {
    for (const h of this.handlers.get(name) ?? []) {
      try {
        await h(payload);
      } catch (err) {
        // A failing consumer must never break the producer's request.
        this.logger.error({ err, event: name }, 'event handler failed');
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
