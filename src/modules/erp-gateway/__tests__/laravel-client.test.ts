import { describe, expect, it } from 'vitest';
import { LaravelErpClient } from '../client/laravel-client.js';

/** A fake ERP: answers each request through `answer`, records the URLs. */
function fakeErp(answer: (url: URL) => { status: number; body: unknown }) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const a = answer(url);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const warnings: Record<string, unknown>[] = [];
  const client = new LaravelErpClient({ baseUrl: 'https://erp.test/api/field/v1', token: 't', timeoutMs: 1000, fetchImpl, onWarn: (d) => void warnings.push(d) });
  return { client, urls, warnings };
}
const page = { data: [], meta: { next_cursor: null, server_time: '2026-11-23T06:00:00+06:00' } };
const refused = { status: 422, body: { code: 'VALIDATION_FAILED', message: 'The selected invoices is invalid.' } };

describe('LaravelErpClient customer scope (1.44.0, ADR-057)', () => {
  it('all → scope=all&invoices=all; receivables → the old query', async () => {
    const { client, urls } = fakeErp(() => ({ status: 200, body: page }));
    await client.listCustomers({ scope: 'all' });
    await client.listCustomers({});
    expect(urls[0]!.searchParams.get('scope')).toBe('all');
    expect(urls[0]!.searchParams.get('invoices')).toBe('all');
    expect(urls[1]!.searchParams.get('scope')).toBe('receivables');
    expect(urls[1]!.searchParams.has('invoices')).toBe(false);
  });

  it('an ERP without `invoices` (422) falls back to scope=all, remembers it and warns once', async () => {
    const { client, urls, warnings } = fakeErp((u) => (u.searchParams.has('invoices') ? refused : { status: 200, body: page }));
    await client.listCustomers({ scope: 'all' });
    await client.listCustomers({ scope: 'all' });
    expect(urls.map((u) => [u.searchParams.get('scope'), u.searchParams.get('invoices')])).toEqual([
      ['all', 'all'],
      ['all', null],
      ['all', null],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ refused: 'invoices=all', fallback: 'customers' });
    // the single-customer read does not try invoices=all again
    await client.getCustomer('5').catch(() => null);
    expect(urls[urls.length - 1]!.search).toBe('');
  });

  it('an ERP refusing scope=all too falls back to the old receivables pull', async () => {
    const { client, urls } = fakeErp((u) => (u.searchParams.get('scope') === 'all' ? refused : { status: 200, body: page }));
    const p = await client.listCustomers({ scope: 'all' });
    expect(p.items).toEqual([]);
    expect(urls.map((u) => u.searchParams.get('scope'))).toEqual(['all', 'all', 'receivables']);
  });

  it('getCustomer with scope all asks for invoices=all and falls back on 422', async () => {
    const one = { data: { id: 5, name: 'A', invoices: [] } };
    const ok = fakeErp(() => ({ status: 200, body: one }));
    expect((await ok.client.getCustomer('5', { scope: 'all' }))!.erpCustomerId).toBe('5');
    expect(ok.urls[0]!.searchParams.get('invoices')).toBe('all');
    const old = fakeErp((u) => (u.searchParams.has('invoices') ? refused : { status: 200, body: one }));
    expect((await old.client.getCustomer('5', { scope: 'all' }))!.erpCustomerId).toBe('5');
    expect(old.urls.map((u) => u.search)).toEqual(['?invoices=all', '']);
    expect(old.warnings).toHaveLength(1);
  });
});
