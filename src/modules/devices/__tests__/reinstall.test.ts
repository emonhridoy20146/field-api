import { describe, expect, it } from 'vitest';
import { isLikelyReinstall } from '../service.js';

const now = new Date('2026-11-24T06:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000);
const phone = { model: 'Redmi 9A', androidVersion: 'android 10' };

describe('isLikelyReinstall (FR-AUTH-007 hint, 1.47.0)', () => {
  it('is off when the setting is 0', () => {
    expect(isLikelyReinstall(phone, [{ ...phone, lastSeenAt: daysAgo(30) }], 0, now)).toBe(false);
  });
  it('same model and Android version, old device idle long enough → true (case and spaces ignored)', () => {
    expect(isLikelyReinstall({ model: ' redmi 9a ', androidVersion: 'Android 10' }, [{ ...phone, lastSeenAt: daysAgo(3) }], 3, now)).toBe(true);
  });
  it('old device seen recently → false', () => {
    expect(isLikelyReinstall(phone, [{ ...phone, lastSeenAt: daysAgo(2.9) }], 3, now)).toBe(false);
  });
  it('old device never seen counts as idle', () => {
    expect(isLikelyReinstall(phone, [{ ...phone, lastSeenAt: null }], 3, now)).toBe(true);
  });
  it('different model or Android version, or unknown model → false', () => {
    expect(isLikelyReinstall({ ...phone, model: 'Redmi 10' }, [{ ...phone, lastSeenAt: daysAgo(9) }], 3, now)).toBe(false);
    expect(isLikelyReinstall({ ...phone, androidVersion: 'android 11' }, [{ ...phone, lastSeenAt: daysAgo(9) }], 3, now)).toBe(false);
    expect(isLikelyReinstall({ model: '', androidVersion: '' }, [{ model: '', androidVersion: '', lastSeenAt: daysAgo(9) }], 3, now)).toBe(false);
  });
  it('needs exactly one active device', () => {
    expect(isLikelyReinstall(phone, [], 3, now)).toBe(false);
    expect(isLikelyReinstall(phone, [{ ...phone, lastSeenAt: daysAgo(9) }, { ...phone, lastSeenAt: daysAgo(9) }], 3, now)).toBe(false);
  });
});
