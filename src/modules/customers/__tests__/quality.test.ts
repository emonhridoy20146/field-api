import { describe, expect, it } from 'vitest';
import { findIssues, normalizeBdMobile, sharedPhones, type QualityInput } from '../domain/quality.js';

const base: QualityInput = { id: 'c1', code: 'C-1', branchId: 'b1', locationStatus: 'ok', location: { lat: 22.71, lng: 90.37 }, erpLocation: { lat: 22.71, lng: 90.37 }, phones: ['01712345678'], assigneeId: 'u1', plans: [{ erpPlanId: 'P1', status: 'active', outstandingPoisha: 100, scheduleLines: 12 }] };
const branch = { lat: 22.7, lng: 90.36 };
const issues = (over: Partial<QualityInput>, km = 30) => findIssues({ ...base, ...over }, branch, km).map((f) => f.issue);

describe('data quality (FR-CUS-009)', () => {
  it('a clean customer has no issues', () => {
    expect(findIssues(base, branch, 30)).toEqual([]);
    expect(findIssues(base, null, 30)).toEqual([]);
  });

  it('flags location problems', () => {
    expect(issues({ locationStatus: 'missing', location: null, erpLocation: null })).toEqual(['no_location']);
    const inv = findIssues({ ...base, locationStatus: 'invalid', location: null, erpLocation: { lat: 0, lng: 0 } }, branch, 30);
    expect(inv).toEqual([{ issue: 'invalid_location', detail: 'Coordinates 0,0 are 0,0 or outside Bangladesh' }]);
    expect(issues({ locationStatus: 'invalid', location: null, erpLocation: null })).toEqual(['invalid_location']);
    expect(issues({ locationStatus: 'suspect_swapped', location: null, erpLocation: { lat: 90.37, lng: 22.71 } })).toEqual(['suspect_swapped']);
    expect(issues({ locationStatus: 'suspect_swapped', location: null, erpLocation: null })).toEqual(['suspect_swapped']);
    const far = findIssues({ ...base, location: { lat: 23.81, lng: 90.41 } }, branch, 30);
    expect(far[0]!.issue).toBe('far_from_branch');
    expect(far[0]!.detail).toMatch(/^12\d\.\d km from the branch$/);
    expect(issues({ location: { lat: 22.9, lng: 90.36 }, locationStatus: 'overridden' }, 10)).toEqual(['far_from_branch']);
  });

  it('flags phone, plan and assignment problems', () => {
    expect(issues({ phones: [] })).toEqual(['missing_phone']);
    expect(issues({ phones: ['  '] })).toEqual(['missing_phone']);
    const bad = findIssues({ ...base, phones: ['01712345678', '12345'] }, branch, 30);
    expect(bad).toEqual([{ issue: 'invalid_phone', detail: 'Not a Bangladesh mobile number: 12345' }]);
    expect(issues({ plans: [{ erpPlanId: 'P9', status: 'active', outstandingPoisha: 5, scheduleLines: 0 }] })).toEqual(['plan_without_schedule']);
    expect(issues({ plans: [{ erpPlanId: 'P9', status: 'completed', outstandingPoisha: 0, scheduleLines: 0 }] })).toEqual([]);
    expect(issues({ assigneeId: null })).toEqual(['unassigned']);
  });

  it('normalizes Bangladesh mobile numbers', () => {
    expect(normalizeBdMobile('+8801712345678')).toBe('01712345678');
    expect(normalizeBdMobile('8801712345678')).toBe('01712345678');
    expect(normalizeBdMobile('017-1234-5678')).toBe('01712345678');
    expect(normalizeBdMobile('01212345678')).toBeNull();
    expect(normalizeBdMobile('0171234567')).toBeNull();
  });

  it('finds numbers shared inside a branch only', () => {
    const m = sharedPhones([
      { id: 'a', code: 'A', branchId: 'b1', phones: ['01712345678'] },
      { id: 'b', code: 'B', branchId: 'b1', phones: ['+8801712345678', '01812345678'] },
      { id: 'c', code: 'C', branchId: 'b2', phones: ['01712345678'] },
      { id: 'd', code: 'D', branchId: 'b1', phones: ['01712345678', 'bad'] },
    ]);
    expect(m.get('a')).toEqual(['B', 'D']);
    expect(m.get('b')).toEqual(['A', 'D']);
    expect(m.has('c')).toBe(false);
  });
});
