import { describe, expect, it } from 'vitest';
import { ALL_BRANCH_ROLES, OFFICE_ADMIN_ROLES, ROLES, branchFilter, branchQuery, canSeeBranch, hasAllBranches, sharesBranch, type AuthUser, type Role } from '../security/types.js';

const user = (role: Role, branchIds: string[]): AuthUser => ({ id: 'u', role, branchIds, name: {}, employeeCode: 'X', sessionId: 's', deviceId: null, client: 'web', mustChangePassword: false, locale: 'en' });

describe('branch scope by role (ADR-065)', () => {
  it('super admin and area manager see every branch, including ones not in branchIds', () => {
    expect([...ALL_BRANCH_ROLES]).toEqual(['super_admin', 'area_manager']);
    for (const role of ALL_BRANCH_ROLES) {
      const u = user(role, ['A']);
      expect(hasAllBranches(u)).toBe(true);
      expect(branchFilter(u)).toEqual({});
      expect(canSeeBranch(u, 'Z')).toBe(true);
      expect(branchQuery(u, 'Z')).toEqual({ branchId: 'Z' });
      expect(branchQuery(u, undefined)).toEqual({});
      expect(sharesBranch(u, { branchIds: ['Z'] })).toBe(true);
    }
  });
  it('the other roles stay in their branches', () => {
    for (const role of ROLES.filter((r) => !ALL_BRANCH_ROLES.includes(r))) {
      const u = user(role, ['A']);
      expect(hasAllBranches(u)).toBe(false);
      expect(branchFilter(u)).toEqual({ branchId: { $in: ['A'] } });
      expect(canSeeBranch(u, 'Z')).toBe(false);
      expect(branchQuery(u, 'Z')).toEqual({ branchId: { $in: [] } });
      expect(sharesBranch(u, { branchIds: ['Z'] })).toBe(false);
      expect(sharesBranch(u, { branchIds: ['Z', 'A'] })).toBe(true);
    }
  });
  it('only a super admin manages the office admin roles', () => {
    expect([...OFFICE_ADMIN_ROLES].sort()).toEqual(['area_manager', 'branch_manager', 'super_admin']);
  });
});
