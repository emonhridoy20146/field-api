// Vercel function for every API route (test deployment only, ADR-034).
// `pnpm build` compiles src/ to dist/ first; vercel.json rewrites all paths here.
import { handleHttp } from '../dist/src/app/serverless.js';

export default async function handler(req, res) {
  try {
    await handleHttp(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/problem+json');
      res.end(JSON.stringify({ type: 'about:blank', title: 'Service unavailable', status: 503, code: 'INTERNAL' }));
    }
  }
}
