/**
 * FR-ASG-002: exactly one primary assignee per customer; a direct (customer) assignment overrides an area one.
 * Pure function so the rule is unit-tested without Mongo.
 */
export interface ActiveAssignment {
  id: string;
  userId: string;
  type: 'area' | 'customer';
  areaId?: string | null;
  customerId?: string | null;
  effectiveFrom: Date;
}

export interface Primary {
  assigneeId: string | null;
  areaId: string | null;
}

/**
 * @param areaOf customerId → areaId it falls in (first matching area by code), if any
 * @param active active assignments of the branch
 */
export function computePrimary(customerIds: string[], areaOf: Map<string, string>, active: ActiveAssignment[]): Map<string, Primary> {
  // The newest assignment wins when (due to a race) two are active for the same target.
  const newestFirst = [...active].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.id.localeCompare(a.id));
  const direct = new Map<string, string>();
  const byArea = new Map<string, string>();
  for (const a of newestFirst) {
    if (a.type === 'customer' && a.customerId && !direct.has(a.customerId)) direct.set(a.customerId, a.userId);
    if (a.type === 'area' && a.areaId && !byArea.has(a.areaId)) byArea.set(a.areaId, a.userId);
  }
  const out = new Map<string, Primary>();
  for (const id of customerIds) {
    const areaId = areaOf.get(id) ?? null;
    out.set(id, { assigneeId: direct.get(id) ?? (areaId ? (byArea.get(areaId) ?? null) : null), areaId });
  }
  return out;
}
