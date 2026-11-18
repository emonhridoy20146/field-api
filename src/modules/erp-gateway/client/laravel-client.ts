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
  }) {
    const p = new URLSearchParams();
    if (q.erpBranchId) p.set('branch_id', q.erpBranchId);
    if (q.updatedSince) p.set('updated_since', q.updatedSince);
    if (q.cursor) p.set('page[cursor]', q.cursor);
    p.set('page[size]', String(q.pageSize ?? 100));
    p.set('scope', 'receivables');
    return mapCustomerPage(this.ok(await this.get(`/customers?${p.toString()}`), 'customers'));
  }

  async getCustomer(id: string) {
    const r = await this.get(`/customers/${encodeURIComponent(id)}`);
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
    // The ERP requires a collector employee (findings §2.5); say so instead of sending a request that must fail.
    if (!input.employeeId)
      return {
        kind: 'business_error',
        code: 'COLLECTOR_NOT_LINKED',
        message: 'Collector has no ERP employee id',
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
