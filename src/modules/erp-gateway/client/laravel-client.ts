import { randomUUID } from 'node:crypto';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  mapBranch,
  mapCustomer,
  mapCustomerPage,
  mapEmployee,
  mapPayment,
  mapPaymentError,
  mapPosted,
  toPaymentRequest,
} from '../mappers/laravel-v1.js';
import { ErpUnavailableError, type ErpClient, type PostPaymentInput, type PostPaymentResult } from '../types.js';

export interface LaravelClientOptions {
  baseUrl: string; // e.g. https://erp.example.com/api/field/v1
  token: string;
  nextToken?: string | undefined;
  timeoutMs: number;
  breaker?: CircuitBreaker;
  fetchImpl?: typeof fetch;
  /** 1.44.0: told when the ERP refuses a newer query parameter and the client falls back. */
  onWarn?: (data: Record<string, unknown>, msg: string) => void;
}

interface RawResponse {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTTP client for the ERP field integration API v1 (erp-integration-spec v2, docs/erp-findings.md). */
export class LaravelErpClient implements ErpClient {
  readonly mode = 'live' as const;
  readonly breaker: CircuitBreaker;
  private token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: LaravelClientOptions) {
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async raw(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<RawResponse> {
    if (!this.breaker.canRequest()) throw new ErpUnavailableError('circuit open');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs);
    try {
      const send = (tok: string) =>
        this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
          method,
          signal: ac.signal,
          headers: {
            Authorization: `Bearer ${tok}`,
            Accept: 'application/json',
            'X-Request-Id': randomUUID(),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      let res = await send(this.token);
      // Token rotation overlap (erp-integration-spec v2 §2): try the next token once.
      if (res.status === 401 && this.opts.nextToken && this.opts.nextToken !== this.token) {
        res = await send(this.opts.nextToken);
        if (res.status !== 401) this.token = this.opts.nextToken;
      }
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { message: text.slice(0, 200) };
      }
      if (res.status >= 500 || res.status === 429) this.breaker.failure();
      else this.breaker.success();
      return { status: res.status, body: parsed, retryAfter: res.headers.get('retry-after') };
    } catch (e) {
      this.breaker.failure();
      throw new ErpUnavailableError(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET with retries + jitter for 5xx/429/network only. */
  private async get(path: string): Promise<RawResponse> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.raw('GET', path);
        if (r.status < 500 && r.status !== 429) return r;
        last = new ErpUnavailableError(`ERP ${r.status}`);
      } catch (e) {
        last = e;
        if (!this.breaker.canRequest()) break;
      }
      await sleep(200 * 2 ** attempt + Math.random() * 200);
    }
    throw last instanceof Error ? last : new ErpUnavailableError(String(last));
  }

  private ok(r: RawResponse, what: string): unknown {
    if (r.status >= 200 && r.status < 300) return r.body;
    throw new ErpUnavailableError(`${what}: ERP ${r.status}`);
  }

  async health() {
    try {
      const r = await this.raw('GET', '/health');
      const b = (r.body ?? {}) as { status?: string; time?: string };
      return { ok: r.status === 200 && b.status === 'ok', time: b.time ?? null };
    } catch {
      return { ok: false, time: null };
    }
  }

  async listBranches() {
    // type=all: some receivable invoices sit on warehouse locations; those customers must not be skipped.
    const b = this.ok(await this.get('/branches?type=all'), 'branches') as { data: unknown[] };
    return b.data.map(mapBranch);
  }

  async listEmployees() {
    const b = this.ok(await this.get('/employees'), 'employees') as { data: unknown[] };
    return b.data.map(mapEmployee);
  }

  async listCustomers(q: {
    erpBranchId?: string;
    updatedSince?: string | null;
    cursor?: string | null;
    pageSize?: number;
    /** 1.44.0: `receivables` (default) = customers with an installment or credit invoice; `all` = every ERP customer. */
    scope?: 'receivables' | 'all';
  }) {
    const p = new URLSearchParams();
    if (q.erpBranchId) p.set('branch_id', q.erpBranchId);
    if (q.updatedSince) p.set('updated_since', q.updatedSince);
    if (q.cursor) p.set('page[cursor]', q.cursor);
    p.set('page[size]', String(q.pageSize ?? 100));
    // 1.44.0 (ADR-057): `all` asks for every customer and every invoice, cash sales included. An ERP without the
    // `invoices` parameter answers 422: then every customer without cash invoices, then the old receivables pull.
    const wanted = q.scope ?? 'receivables';
    for (const level of this.levelsFrom(wanted)) {
      const params = new URLSearchParams(p);
      params.set('scope', level === 'receivables' ? 'receivables' : 'all');
      if (level === 'all') params.set('invoices', 'all');
      const r = await this.get(`/customers?${params.toString()}`);
      if (r.status === 422 && level !== 'receivables') {
        this.downgrade(level, r);
        continue;
      }
      return mapCustomerPage(this.ok(r, 'customers'));
    }
    throw new ErpUnavailableError('customers: no scope accepted');
  }

  /**
   * What the ERP accepts, learnt per process (1.44.0): `all` = scope=all&invoices=all; `customers` = scope=all
   * without the invoices parameter (an ERP before howlader-ERP PR #5); `receivables` = the pull before 1.44.0.
   */
  private accepted: 'all' | 'customers' | 'receivables' = 'all';

  private levelsFrom(wanted: 'receivables' | 'all'): ('all' | 'customers' | 'receivables')[] {
    if (wanted === 'receivables') return ['receivables'];
    const order = ['all', 'customers', 'receivables'] as const;
    return order.slice(order.indexOf(this.accepted));
  }

  private downgrade(level: 'all' | 'customers', r: RawResponse) {
    const next = level === 'all' ? 'customers' : 'receivables';
    if (this.accepted === level) this.accepted = next;
    const msg = (r.body as { message?: string } | null)?.message ?? '';
    this.opts.onWarn?.({ refused: level === 'all' ? 'invoices=all' : 'scope=all', fallback: next, erpMessage: msg.slice(0, 120) }, 'ERP refused a customer query parameter (older ERP); falling back');
  }

  async getCustomer(id: string, opts: { scope?: 'receivables' | 'all' } = {}) {
    const base = `/customers/${encodeURIComponent(id)}`;
    let r = await this.get(opts.scope === 'all' && this.accepted === 'all' ? `${base}?invoices=all` : base);
    if (r.status === 422 && opts.scope === 'all' && this.accepted === 'all') {
      this.downgrade('all', r);
      r = await this.get(base);
    }
    if (r.status === 404) return null;
    const b = this.ok(r, 'customer') as { data: unknown };
    return mapCustomer(b.data);
  }

  async listPayments(id: string) {
    const b = this.ok(await this.get(`/customers/${encodeURIComponent(id)}/payments?page[size]=200`), 'payments') as {
      data: unknown[];
    };
    return b.data.map(mapPayment);
  }

  async getPaymentByKey(key: string) {
    const r = await this.get(`/payments/by-idempotency-key/${encodeURIComponent(key)}`);
    if (r.status === 404) return null;
    return mapPosted(this.ok(r, 'payment-by-key'));
  }

  async postPayment(input: PostPaymentInput): Promise<PostPaymentResult> {
    // 1.35.0 (ADR-049): a collector with no ERP employee is posted by name; the ERP leaves the referrer empty.
    if (!input.employeeId && !input.collectorName?.trim())
      return {
        kind: 'business_error',
        code: 'COLLECTOR_NOT_LINKED',
        message: 'Collector has no ERP employee id and no name',
        details: {},
      };
    let r: RawResponse;
    try {
      r = await this.raw('POST', '/payments', toPaymentRequest(input), { 'Idempotency-Key': input.idempotencyKey });
    } catch (e) {
      return { kind: 'transient', error: e instanceof Error ? e.message : String(e) };
    }
    if (r.status === 200 || r.status === 201) return mapPosted(r.body);
    return mapPaymentError(r.status, r.body, r.retryAfter);
  }
}
