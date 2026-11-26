import { describe, expect, it } from 'vitest';
import { isDeviceBound } from '../service.js';

describe('isDeviceBound (FR-AUTH-007, 1.51.0, ADR-069)', () => {
  it('every role except the multi-device roles is bound', () => {
    const multi = ['super_admin'];
    expect(isDeviceBound('super_admin', multi)).toBe(false);
    for (const r of ['area_manager', 'branch_manager', 'field_staff', 'viewer']) expect(isDeviceBound(r, multi)).toBe(true);
  });
  it('a role added later is bound without editing the setting', () => {
    expect(isDeviceBound('collector_trainee', ['super_admin'])).toBe(true);
  });
  it('an empty list binds everyone, including the super admin', () => {
    expect(isDeviceBound('super_admin', [])).toBe(true);
  });
});
