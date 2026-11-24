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

describe('neverFor (ADR-065: area manager)', () => {
  const userManage: PermissionDef = { key: 'user.manage', description: { en: '', bn: '' }, defaults: { super_admin: true }, neverFor: ['area_manager'] };
  const am = { id: 'am1', role: 'area_manager' as const, branchIds: ['A'] };
  it('a key closed to the role is never granted, whatever the user or branch overrides say', () => {
    const ov: Override[] = [
      { level: 'user', userId: 'am1', key: 'user.manage', effect: 'allow' },
      { level: 'branch', branchId: 'A', role: 'area_manager', key: 'user.manage', effect: 'allow' },
    ];
    expect(evaluate(am, userManage, ov)).toEqual({ allowed: false, source: 'role' });
  });
  it('other roles still follow overrides and the super admin keeps it', () => {
    expect(evaluate({ ...fs, role: 'branch_manager' }, userManage, [{ level: 'user', userId: 'u1', key: 'user.manage', effect: 'allow' }])).toEqual({ allowed: true, source: 'user' });
    expect(evaluate({ ...am, role: 'super_admin' }, userManage, [])).toEqual({ allowed: true, source: 'super_admin' });
  });
  it('the area manager follows its own defaults column and overrides elsewhere', () => {
    const view: PermissionDef = { key: 'customer.view', description: { en: '', bn: '' }, defaults: { super_admin: true, area_manager: true } };
    expect(evaluate(am, view, [])).toEqual({ allowed: true, source: 'role' });
    expect(evaluate(am, view, [{ level: 'user', userId: 'am1', key: 'customer.view', effect: 'deny' }])).toEqual({ allowed: false, source: 'user' });
  });
});
