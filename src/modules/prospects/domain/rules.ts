/** Pure business rules for prospects (FR-PRO-001): no database, no clock. */

export const PROSPECT_STATUSES = ['new', 'contacted', 'converted', 'dropped'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
/** Statuses PATCH may set; `converted` only comes from /convert. */
export const EDITABLE_STATUSES = ['new', 'contacted', 'dropped'] as const;
export type EditableStatus = (typeof EDITABLE_STATUSES)[number];
/** Still being worked on (dashboard `openNow`, bootstrap keeps them whatever their age). */
export const OPEN_STATUSES: readonly ProspectStatus[] = ['new', 'contacted'];
export const MAX_PHONES = 5;
/** Bootstrap window for closed prospects, in Dhaka days. */
export const SNAPSHOT_DAYS = 90;

export const isOpen = (s: ProspectStatus): boolean => OPEN_STATUSES.includes(s);

export type RuleResult = { ok: true } | { ok: false; reason: 'PROSPECT_CONVERTED' | 'PROSPECT_OPEN' };

/** PATCH status change: anything between new/contacted/dropped; a converted prospect only leaves through /reopen. */
export function checkStatusChange(from: ProspectStatus, to: EditableStatus): RuleResult {
  if (from === to) return { ok: true };
  if (from === 'converted') return { ok: false, reason: 'PROSPECT_CONVERTED' };
  return { ok: true };
}

/** /convert: once only; reopen first to convert again. */
export function checkConvert(from: ProspectStatus): RuleResult {
  return from === 'converted' ? { ok: false, reason: 'PROSPECT_CONVERTED' } : { ok: true };
}

/** /reopen: only a closed prospect (converted or dropped) goes back to `new`. */
export function checkReopen(from: ProspectStatus): RuleResult {
  return from === 'converted' || from === 'dropped' ? { ok: true } : { ok: false, reason: 'PROSPECT_OPEN' };
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const BD_MOBILE = /^01[3-9]\d{8}$/;

/**
 * One Bangladeshi mobile number as `+8801XXXXXXXXX`, or null. Accepts Bangla digits, spaces, dashes, brackets, dots,
 * `+880…`, `880…`, `01…` and ten digits without the leading zero (same leniency as customer phones, FR-CUS-016).
 */
export function normalizeBdMobile(input: string): string | null {
  let d = '';
  for (const ch of input.trim()) {
    const bn = BN_DIGITS.indexOf(ch);
    if (bn >= 0) d += String(bn);
    else if (ch >= '0' && ch <= '9') d += ch;
    else if (!' -()+.'.includes(ch)) return null; // letters or other text: not a number
  }
  if (d.length === 13 && d.startsWith('880')) d = d.slice(2);
  else if (d.length === 10 && /^1[3-9]/.test(d)) d = `0${d}`;
  return BD_MOBILE.test(d) ? `+88${d}` : null;
}

export interface PhoneIn {
  number: string;
  label?: string | null | undefined;
}
export interface Phone {
  number: string;
  label: string | null;
}

/** Normalises every number; a repeated number keeps its first label. `invalid` holds the indexes that are not BD mobiles. */
export function normalizePhones(input: PhoneIn[]): { phones: Phone[]; invalid: number[] } {
  const phones: Phone[] = [];
  const invalid: number[] = [];
  input.forEach((p, i) => {
    const number = normalizeBdMobile(p.number);
    if (!number) invalid.push(i);
    else if (!phones.some((x) => x.number === number)) phones.push({ number, label: p.label?.trim() || null });
  });
  return { phones, invalid };
}

/** Text typed into a search box, safe inside a Mongo `$regex`. */
export const escapeRegex = (q: string): string => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Digits to look for in stored `+8801…` numbers, or null when the text is not number-like enough (under 3 digits).
 * A typed leading zero (`0171…`) still matches because stored numbers carry it after `+88`.
 */
export function phoneDigits(q: string): string | null {
  let d = '';
  for (const ch of q) {
    const bn = BN_DIGITS.indexOf(ch);
    if (bn >= 0) d += String(bn);
    else if (ch >= '0' && ch <= '9') d += ch;
  }
  return d.length >= 3 ? d : null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface Details {
  name: string;
  phones: Phone[];
  address: string | null;
  note: string | null;
  location: { lat: number; lng: number; accuracyM: number | null } | null;
}

/** The detail fields that really change (an offline retry or the same values typed again change nothing). */
export function changedDetails(current: Details, next: Partial<Details>): Partial<Details> {
  const out: Partial<Details> = {};
  for (const k of ['name', 'phones', 'address', 'note', 'location'] as const) {
    if (next[k] === undefined) continue;
    if (!same(current[k], next[k])) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}
