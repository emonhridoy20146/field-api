/** Money is integer poisha (ADR-013). 1 BDT = 100 poisha. */

/** Convert an ERP decimal string ("8500.00", "8500", "8500.5") or integer to poisha without floating point. */
export function decimalToPoisha(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Invalid money value: ${v}`);
    // Numbers are only accepted as whole taka with up to 2 decimals; go through string to avoid FP drift.
    return decimalToPoisha(v.toFixed(2));
  }
  const s = v.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2})\d*)?$/.exec(s);
  if (!m) throw new Error(`Invalid money value: ${v}`);
  const sign = m[1] ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? '').padEnd(2, '0'));
  return sign * (whole * 100 + frac);
}

export function poishaToDecimal(p: number): string {
  if (!Number.isInteger(p)) throw new Error('poisha must be integer');
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBanglaDigits(s: string): string {
  return s.replace(/\d/g, (d) => BN_DIGITS[Number(d)]!);
}

/** "৳8,500" (Latin digits) or "৳৮,৫০০" (Bangla digits); paisa shown only when non-zero. */
export function formatBdt(p: number, digits: 'bn' | 'latin' = 'latin'): string {
  const taka = Math.trunc(p / 100);
  const paisa = Math.abs(p % 100);
  // South-Asian grouping: last 3, then groups of 2.
  const abs = String(Math.abs(taka));
  const last3 = abs.slice(-3);
  const rest = abs.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  let out = `${p < 0 ? '-' : ''}৳${rest ? `${rest},` : ''}${last3}`;
  if (paisa) out += `.${String(paisa).padStart(2, '0')}`;
  return digits === 'bn' ? toBanglaDigits(out) : out;
}
