/** FR-REP-005 ranking rules. Pure. */

export interface Candidate {
  userId: string;
  name: string;
  value: number | null;
  eligible: boolean;
}

/**
 * Competition ranking: equal values share a rank and the next rank skips (1, 2, 2, 4). Only eligible
 * people with a value are ranked; the rest follow with rank null. Ties and the unranked are ordered by name.
 */
export function rank<T extends Candidate>(rows: T[]): (T & { rank: number | null })[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const ranked = rows.filter((r) => r.eligible && r.value !== null).sort((a, b) => b.value! - a.value! || byName(a, b));
  const rest = rows.filter((r) => !(r.eligible && r.value !== null)).sort(byName);
  const out: (T & { rank: number | null })[] = [];
  ranked.forEach((r, i) => {
    const prev = out[i - 1];
    out.push({ ...r, rank: prev && prev.value === r.value ? prev.rank : i + 1 });
  });
  for (const r of rest) out.push({ ...r, rank: null });
  return out;
}
