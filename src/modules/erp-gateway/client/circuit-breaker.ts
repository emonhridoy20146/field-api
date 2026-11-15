/** FR-ERP-001: open after 5 consecutive failures, half-open after 60 s. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  constructor(
    private readonly threshold = 5,
    private readonly coolDownMs = 60_000,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  get state(): 'closed' | 'open' | 'half_open' {
    if (this.openedAt === null) return 'closed';
    return this.nowMs() - this.openedAt >= this.coolDownMs ? 'half_open' : 'open';
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  canRequest(): boolean {
    return this.state !== 'open';
  }

  success(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  failure(): void {
    this.failures++;
    if (this.state === 'half_open' || this.failures >= this.threshold) this.openedAt = this.nowMs();
  }
}
