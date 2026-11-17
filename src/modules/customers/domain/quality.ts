/** FR-CUS-009 data-quality rules. Pure: no database, no clock. */
import { haversineM, type LatLng } from '../../../core/geo/index.js';

export const QUALITY_ISSUES = ['no_location', 'invalid_location', 'suspect_swapped', 'far_from_branch', 'missing_phone', 'invalid_phone', 'shared_phone', 'plan_without_schedule', 'unassigned'] as const;
export type QualityIssue = (typeof QUALITY_ISSUES)[number];

export interface QualityInput {
  id: string;
  code: string;
  branchId: string;
  locationStatus: string;
  location: LatLng | null;
  erpLocation: { lat: number | null; lng: number | null } | null;
  phones: string[];
  assigneeId: string | null;
  plans: { erpPlanId: string; status: string; outstandingPoisha: number; scheduleLines: number }[];
}

export interface Finding {
  issue: QualityIssue;
  detail: string;
}

/** Bangladesh mobile numbers in their 11-digit local form, or null when it is not one. */
export function normalizeBdMobile(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('880')) d = d.slice(2);
  else if (d.startsWith('88') && d.length === 13) d = d.slice(2);
  return /^01[3-9]\d{8}$/.test(d) ? d : null;
}

const OPEN_PLAN = new Set(['active', 'defaulted']);

/** Everything wrong with one customer except shared phones, which need the whole branch (see sharedPhones). */
export function findIssues(c: QualityInput, branch: LatLng | null, maxBranchKm: number): Finding[] {
  const out: Finding[] = [];
  const raw = c.erpLocation && c.erpLocation.lat !== null && c.erpLocation.lng !== null ? `${c.erpLocation.lat},${c.erpLocation.lng}` : '';
  if (c.locationStatus === 'missing') out.push({ issue: 'no_location', detail: 'No coordinates' });
  else if (c.locationStatus === 'invalid') out.push({ issue: 'invalid_location', detail: raw ? `Coordinates ${raw} are 0,0 or outside Bangladesh` : 'Invalid coordinates' });
  else if (c.locationStatus === 'suspect_swapped') out.push({ issue: 'suspect_swapped', detail: raw ? `Coordinates ${raw} look like latitude and longitude are swapped` : 'Latitude and longitude look swapped' });
  if (c.location && branch && (c.locationStatus === 'ok' || c.locationStatus === 'overridden')) {
    const km = haversineM(c.location, branch) / 1000;
    if (km > maxBranchKm) out.push({ issue: 'far_from_branch', detail: `${Math.round(km * 10) / 10} km from the branch` });
  }
  const phones = c.phones.map((p) => p.trim()).filter(Boolean);
  if (!phones.length) out.push({ issue: 'missing_phone', detail: 'No phone number' });
  const bad = phones.filter((p) => !normalizeBdMobile(p));
  if (bad.length) out.push({ issue: 'invalid_phone', detail: `Not a Bangladesh mobile number: ${bad.join(', ')}` });
  const noSchedule = c.plans.filter((p) => OPEN_PLAN.has(p.status) && p.outstandingPoisha > 0 && p.scheduleLines === 0);
  if (noSchedule.length) out.push({ issue: 'plan_without_schedule', detail: `Open plan without installment schedule: ${noSchedule.map((p) => p.erpPlanId).join(', ')}` });
  if (!c.assigneeId) out.push({ issue: 'unassigned', detail: 'No field staff assigned' });
  return out;
}

/** Numbers used by more than one customer of the same branch: customer id → the other customers' codes. */
export function sharedPhones(customers: Pick<QualityInput, 'id' | 'code' | 'branchId' | 'phones'>[]): Map<string, string[]> {
  const byNumber = new Map<string, { id: string; code: string }[]>();
  for (const c of customers)
    for (const n of new Set(c.phones.map(normalizeBdMobile).filter((x): x is string => !!x))) {
      const k = `${c.branchId}:${n}`;
      byNumber.set(k, [...(byNumber.get(k) ?? []), { id: c.id, code: c.code }]);
    }
  const out = new Map<string, string[]>();
  for (const group of byNumber.values()) {
    if (group.length < 2) continue;
    for (const c of group) out.set(c.id, [...new Set([...(out.get(c.id) ?? []), ...group.filter((o) => o.id !== c.id).map((o) => o.code)])]);
  }
  return out;
}
