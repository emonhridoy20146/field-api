import type { ZodType, ZodTypeDef } from 'zod';
import { AppError } from '../errors/index.js';

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', {
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    });
  }
  return r.data;
}

/** Opaque cursor: base64url(JSON). Callers decide what goes inside (sort key + id). */
export function encodeCursor(v: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(s: string | undefined): T | null {
  if (!s) return null;
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (typeof v !== 'object' || v === null) throw new Error('bad');
    return v as T;
  } catch {
    throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'cursor', message: 'Invalid cursor' }] });
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Keyset pagination helper over (sortField desc, _id desc). */
export function pageOf<T extends { _id: unknown }>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => Record<string, unknown>,
): { rows: T[]; nextCursor: string | null } {
  const has = rows.length > limit;
  const slice = has ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return { rows: slice, nextCursor: has && last ? encodeCursor(keyOf(last)) : null };
}

export const csv = (s: string | undefined): string[] =>
  s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];

/** Parse "W/\"7\"" or "7" into a version number. */
export function parseIfMatch(h: string | undefined): number | null {
  if (!h) return null;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(h.trim());
  return m ? Number(m[1]) : null;
}

export const etag = (version: number) => `W/"${version}"`;

/** Compare semantic versions "1.2.3"; returns -1, 0, 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** "staff-app/1.4.2 (android 10; Redmi 9A)" → { app: 'staff-app', version: '1.4.2' } */
export function parseClientHeader(h: string | undefined): { app: string; version: string } | null {
  if (!h) return null;
  const m = /^([a-z-]+)\/(\d+(?:\.\d+){0,3})/i.exec(h.trim());
  return m ? { app: m[1]!.toLowerCase(), version: m[2]! } : null;
}
