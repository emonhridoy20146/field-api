export type Cell = string | number | null;

function field(v: Cell): string {
  if (v === null) return '';
  let s = String(v);
  // A cell starting with = + - @ would run as a formula in Excel; neutralise text cells (numbers stay numbers).
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel shows Bangla correctly. */
export function toCsv(header: string[], rows: Cell[][]): Uint8Array {
  const lines = [header, ...rows].map((r) => r.map(field).join(','));
  return new TextEncoder().encode('﻿' + lines.join('\r\n') + '\r\n');
}
