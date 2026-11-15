import { describe, expect, it } from 'vitest';
import { evaluate, type Override } from '../domain/evaluate.js';
import type { PermissionDef } from '../../../core/module/types.js';

const tagSet: PermissionDef = { key: 'tag.set', description: { en: '', bn: '' }, defaults: { super_admin: true, branch_manager: true, field_staff: true } };
const reserved: PermissionDef = { key: 'microfinance.view', description: { en: '', bn: '' }, defaults: {}, reserved: true };
const fs = { id: 'u1', role: 'field_staff' as const, branchIds: ['A', 'B'] };

describe('rbac evaluate (02-requirements §3.3)', () => {
  it('uses the role default', () => {
    expect(evaluate(fs, tagSet, [])).toEqual({ allowed: true, source: 'role' });
    expect(evaluate({ ...fs, role: 'viewer' }, tagSet, [])).toEqual({ allowed: false, source: 'role' });
  });
  it('user deny beats branch allow', () => {
    const ov: Override[] = [
      { level: 'branch', branchId: 'A', role: 'field_staff', key: 'tag.set', effect: 'allow' },
      { level: 'user', userId: 'u1', key: 'tag.set', effect: 'deny' },
    ];
    expect(evaluate(fs, tagSet, ov)).toEqual({ allowed: false, source: 'user' });
  });
  it('branch deny wins when the user is in several branches that disagree', () => {
    const ov: Override[] = [
      { level: 'branch', branchId: 'A', role: 'field_staff', key: 'tag.set', effect: 'allow' },
      { level: 'branch', branchId: 'B', role: 'field_staff', key: 'tag.set', effect: 'deny' },
    ];
    expect(evaluate(fs, tagSet, ov)).toEqual({ allowed: false, source: 'branch' });
  });
  it('ignores branch overrides for another role or branch', () => {
    const ov: Override[] = [
      { level: 'branch', branchId: 'A', role: 'branch_manager', key: 'tag.set', effect: 'deny' },
      { level: 'branch', branchId: 'Z', role: 'field_staff', key: 'tag.set', effect: 'deny' },
    ];
    expect(evaluate(fs, tagSet, ov).allowed).toBe(true);
  });
  it('super admin allows everything except reserved keys; reserved never granted', () => {
    expect(evaluate({ ...fs, role: 'super_admin' }, tagSet, []).source).toBe('super_admin');
    expect(evaluate({ ...fs, role: 'super_admin' }, reserved, []).allowed).toBe(false);
    expect(evaluate(fs, reserved, [{ level: 'user', userId: 'u1', key: 'microfinance.view', effect: 'allow' }])).toEqual({ allowed: false, source: 'reserved' });
  });
});
