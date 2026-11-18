/**
 * HTTP mock of the Howlader ERP field API v1 (docs/erp-integration-spec.md v2 §4) for local
 * development and contract tests. It replays the recorded fixtures under test/fixtures/erp/v1 and
 * knows Laravel field names only through mock-server.json there.
 *
 * It is deliberately dumb: it does not compute balances. A posted payment answers with the
 * recorded "posted" fixture, re-labelled with the request's ids and amount. Money truth is Laravel.
 *
 *   pnpm mock:erp            # listens on MOCK_ERP_PORT (default 4100)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Json = Record<string, unknown>;
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/erp/v1/${name}`, import.meta.url), 'utf8')) as Json;

export interface MockErpServer {
  server: Server;
  url: string;
  /** Number of payments accepted (replays not counted). */
  posted: () => number;
  close: () => Promise<void>;
}

export async function startMockErp(
  opts: { port?: number; token?: string; host?: string } = {},
): Promise<MockErpServer> {
  const cfg = fixture('mock-server.json') as { prefix: string; fields: Record<string, string> };
  const f = cfg.fields;
  const branches = fixture('branches.ok.json') as { data: Json[] };
  const employees = fixture('employees.ok.json') as { data: Json[] };
  const customers = fixture('customers.ok.json') as { data: Json[] } & Json;
  const postedTpl = fixture('payment.posted.json') as { data: Json } & Json;
  const validationError = fixture('payment.error.validation.json');
  const payments = new Map<string, { body: Json; fingerprint: string }>();
  let seq = 78_000;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: IncomingMessage): Promise<Json> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 1_000_000) throw new Error('body too large');
      chunks.push(c as Buffer);
    }
    return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json) : {};
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://mock-erp');
    if (!url.pathname.startsWith(cfg.prefix)) return send(res, 404, { message: 'Not found' });
    const path = url.pathname.slice(cfg.prefix.length) || '/';
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`)
      return send(res, 401, { message: 'Unauthenticated.', error: { code: 'UNAUTHENTICATED' } });
    if (path === '/health')
      return send(res, 200, {
        status: 'ok',
        time: new Date().toISOString(),
        version: 'field-v1',
        timezone: 'Asia/Dhaka',
      });
    if (req.method === 'GET' && path === '/branches') {
      const all = url.searchParams.get(f.queryType!) === 'all';
      return send(res, 200, { data: branches.data.filter((b) => all || (b[f.branchType!] ?? 'branch') === 'branch') });
    }
    if (req.method === 'GET' && path === '/employees') return send(res, 200, employees);

    if (req.method === 'GET' && path === '/customers') {
      const branch = url.searchParams.get(f.queryBranch!);
      const since = url.searchParams.get(f.queryUpdatedSince!);
      const size = Math.min(200, Number(url.searchParams.get(f.querySize!) ?? 100) || 100);
      const start = Number(url.searchParams.get(f.queryCursor!) ?? 0) || 0;
      const all = customers.data
        .filter((c) => !branch || String(c[f.branchId!]) === branch)
        .filter((c) => !since || new Date(String(c[f.updatedAt!])).getTime() >= new Date(since).getTime());
      const page = all.slice(start, start + size);
      return send(res, 200, {
        data: page,
        [f.meta!]: {
          [f.nextCursor!]: start + size < all.length ? String(start + size) : null,
          [f.serverTime!]: new Date().toISOString(),
        },
      });
    }

    const one = /^\/customers\/([^/]+)(\/payments)?$/.exec(path);
    if (req.method === 'GET' && one) {
      const c = customers.data.find((x) => String(x[f.id!]) === decodeURIComponent(one[1]!));
      if (!c) return send(res, 404, { message: 'Customer not found.', error: { code: 'CUSTOMER_NOT_FOUND' } });
      return one[2]
        ? send(res, 200, { data: c[f.payments!] ?? [], meta: { [f.nextCursor!]: null } })
        : send(res, 200, { data: c });
    }

    const byKey = /^\/payments\/by-idempotency-key\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && byKey) {
      const hit = payments.get(decodeURIComponent(byKey[1]!));
      return hit
        ? send(res, 200, { ...hit.body, [f.idempotentReplay!]: true })
        : send(res, 404, { message: 'No payment for this key.', error: { code: 'NOT_FOUND' } });
    }

    if (req.method === 'POST' && path === '/payments') {
      const key = req.headers['idempotency-key'];
      const body = await readBody(req);
      if (typeof key !== 'string' || !key) return send(res, 422, validationError);
      const fingerprint = JSON.stringify([body[f.requestCustomerId!], body[f.requestPlanId!], body[f.requestAmount!]]);
      const prior = payments.get(key);
      if (prior) {
        // Same key, different money → refuse; same key, same money → replay (spec §4.8).
        if (prior.fingerprint !== fingerprint)
          return send(res, 422, {
            message: 'This Idempotency-Key was used with a different payment.',
            error: { code: 'IDEMPOTENCY_MISMATCH' },
          });
        return send(res, 200, { ...prior.body, [f.idempotentReplay!]: true });
      }
      if (body[f.requestCollector!] === null || body[f.requestCollector!] === undefined)
        return send(res, 422, validationError);
      if (!customers.data.some((c) => String(c[f.id!]) === String(body[f.requestCustomerId!])))
        return send(res, 404, {
          message: 'Invoice not found for this customer.',
          error: { code: 'PLAN_NOT_FOUND', details: {} },
        });
      seq += 1;
      const out: Json = {
        ...postedTpl,
        data: {
          ...postedTpl.data,
          [f.postedId!]: seq,
          [f.postedReceiptNo!]: `PAY-20261115-${String(seq).padStart(5, '0')}`,
          [f.postedCustomerId!]: body[f.requestCustomerId!],
          [f.postedPlanId!]: body[f.requestPlanId!],
          [f.postedAmount!]: body[f.requestAmount!],
          [f.postedAt!]: new Date().toISOString(),
        },
        [f.idempotentReplay!]: false,
      };
      payments.set(key, { body: out, fingerprint });
      return send(res, 201, out);
    }
    return send(res, 404, { message: 'Not found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { message: 'Server Error' }));
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
  return {
    server,
    url: `http://127.0.0.1:${port}${cfg.prefix}`,
    posted: () => payments.size,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const m = await startMockErp({
    port: Number(process.env.MOCK_ERP_PORT ?? 4100),
    host: process.env.MOCK_ERP_HOST ?? '127.0.0.1',
    ...(process.env.MOCK_ERP_TOKEN ? { token: process.env.MOCK_ERP_TOKEN } : {}),
  });
  console.log(`mock ERP listening on ${m.url}`);
}
