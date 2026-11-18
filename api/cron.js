// Worker tick as a function (test deployment only, ADR-034): scheduled jobs + outbox.
// Call with `Authorization: Bearer $CRON_SECRET`; `?job=<name>` runs one job now.
import { cronAuthorized, listJobs, runCron } from '../dist/src/app/serverless.js';

export default async function handler(req, res) {
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  if (!cronAuthorized(req.headers.authorization, process.env.CRON_SECRET)) return send(401, { code: 'UNAUTHENTICATED' });
  const job = new URL(req.url ?? '/', 'http://x').searchParams.get('job') ?? undefined;
  try {
    if (job && !(await listJobs()).includes(job)) return send(404, { code: 'NOT_FOUND', jobs: await listJobs() });
    send(200, await runCron({ job }));
  } catch (err) {
    console.error(err);
    send(500, { code: 'INTERNAL' });
  }
}
