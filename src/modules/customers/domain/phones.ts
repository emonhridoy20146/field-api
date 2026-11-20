/**
 * Customer phone numbers (FR-CUS-016, ADR-042). The ERP owns the numbers it sends; field staff and
 * managers may add more in FOS. The added ones live in the overlay (`fos.extraPhones`), are never
 * written to the ERP and are never touched by the ERP sync. Pure rules, no I/O.
 */

/** A number added in FOS, as stored in the overlay. */
export interface ExtraPhone {
  number: string;
  label?: string | null;
  addedBy: string;
  addedByName?: string | null;
  addedAt: Date | string;
}

export interface PhoneDetail {
  number: string;
  /** `erp` = sent by the office system; `field` = added in the app or the admin panel. */
  source: 'erp' | 'field';
  /** The first ERP number: the one the office uses. */
  primary: boolean;
  label?: string;
  addedBy?: { id: string; name: string };
  addedAt?: string;
}

/** Most numbers a customer may have added in FOS. */
export const MAX_EXTRA_PHONES = 5;

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const BD_MOBILE = /^01[3-9]\d{8}$/;

/**
 * One Bangladeshi mobile number as `01XXXXXXXXX`, or null. Accepts Bangla digits, spaces, dashes,
 * brackets, `+880…`, `880…`, and ten digits without the leading zero.
 */
export function normalizeMobile(input: string): string | null {
  let d = '';
  for (const ch of input.trim()) {
    const bn = BN_DIGITS.indexOf(ch);
    if (bn >= 0) d += String(bn);
    else if (ch >= '0' && ch <= '9') d += ch;
    else if (!' -()+.'.includes(ch)) return null; // letters or other text: not a number
  }
  if (d.length === 13 && d.startsWith('880')) d = d.slice(2);
  else if (d.length === 10 && /^1[3-9]/.test(d)) d = `0${d}`;
  return BD_MOBILE.test(d) ? d : null;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : v);

/**
 * The customer's numbers for display and calling: ERP numbers first in the ERP's order (so an index
 * into the list keeps meaning the same ERP number), then the added ones, oldest first. An added
 * number the ERP later sends too is shown once, as the ERP's.
 */
export function mergePhones(erp: readonly string[] | null | undefined, extra: readonly ExtraPhone[] | null | undefined): PhoneDetail[] {
  const out: PhoneDetail[] = [];
  const seen = new Set<string>();
  for (const number of erp ?? []) {
    if (!number || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, source: 'erp', primary: out.length === 0 });
  }
  for (const e of extra ?? []) {
    if (!e?.number || seen.has(e.number)) continue;
    seen.add(e.number);
    out.push({
      number: e.number,
      source: 'field',
      primary: false,
      ...(e.label ? { label: e.label } : {}),
      addedBy: { id: e.addedBy, name: e.addedByName ?? '' },
      addedAt: iso(e.addedAt),
    });
  }
  return out;
}

export interface PhoneInput {
  number: string;
  label?: string | null;
}

export interface AddPlan {
  add: { number: string; label: string | null }[];
  skipped: { number: string; reason: 'duplicate' | 'limit' }[];
  invalid: { index: number; value: string }[];
}

/** Decide what a request to add numbers does. Nothing is added when any number is invalid. */
export function planAdd(erp: readonly string[], extra: readonly ExtraPhone[], input: readonly PhoneInput[]): AddPlan {
  const have = new Set<string>([...erp, ...extra.map((e) => e.number)]);
  const plan: AddPlan = { add: [], skipped: [], invalid: [] };
  let room = MAX_EXTRA_PHONES - extra.length;
  input.forEach((p, index) => {
    const number = normalizeMobile(p.number);
    if (!number) return void plan.invalid.push({ index, value: p.number });
    if (have.has(number)) return void plan.skipped.push({ number, reason: 'duplicate' });
    if (room <= 0) return void plan.skipped.push({ number, reason: 'limit' });
    have.add(number);
    room--;
    plan.add.push({ number, label: p.label?.trim() || null });
  });
  return plan;
}
