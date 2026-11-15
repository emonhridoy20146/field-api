import { describe, expect, it } from 'vitest';
import { checkReceipt, checkTxnRef, choosePlan, computeFlags, DEFAULT_TXN_PATTERNS, formatReceipt, normalizeTxnRef } from '../domain/rules.js';

const t = (s: string) => new Date(s);
const base = { distanceToPinM: 40, geofenceM: 300, mock: false, recordedAt: t('2026-11-15T05:00:00Z'), deviceTime: t('2026-11-15T05:00:10Z'), receivedAt: t('2026-11-15T05:10:00Z'), duplicateTxnRef: false, collectorIsAssignee: true };

describe('collection rules', () => {
  it('txn refs: required for mobile, pattern checked after normalizing', () => {
    expect(checkTxnRef('cash', null, DEFAULT_TXN_PATTERNS)).toBeNull();
    expect(checkTxnRef('bkash', null, DEFAULT_TXN_PATTERNS)).toMatch(/required/);
    expect(checkTxnRef('bkash', normalizeTxnRef(' ab12cd34ef '), DEFAULT_TXN_PATTERNS)).toBeNull();
    expect(checkTxnRef('bkash', 'AB12', DEFAULT_TXN_PATTERNS)).toMatch(/format/);
  });
  it('receipt format and prefix', () => {
    expect(formatReceipt('BRL01-FS014', '261115', 7)).toBe('BRL01-FS014-261115-0007');
    expect(checkReceipt('BRL01-FS014-261115-0007', 'BRL01-FS014')).toBeNull();
    expect(checkReceipt('BRL01-FS015-261115-0007', 'BRL01-FS014')).toMatch(/prefix/);
    expect(checkReceipt('junk', 'BRL01-FS014')).toMatch(/look like/);
  });
  it('flags', () => {
    expect(computeFlags(base)).toEqual([]);
    expect(computeFlags({ ...base, distanceToPinM: 450, mock: true })).toEqual(['far_from_pin', 'mock_location']);
    expect(computeFlags({ ...base, deviceTime: t('2026-11-15T04:50:00Z') })).toEqual(['clock_skew']);
    expect(computeFlags({ ...base, receivedAt: t('2026-11-15T18:00:00Z') })).toEqual(['late_sync']);
    expect(computeFlags({ ...base, duplicateTxnRef: true, collectorIsAssignee: false })).toEqual(['duplicate_txn_ref', 'not_in_scope_at_record_time']);
    expect(computeFlags({ ...base, distanceToPinM: null })).toEqual([]);
  });
  it('plan choice', () => {
    expect(choosePlan([{ erpPlanId: 'a', status: 'active' }, { erpPlanId: 'b', status: 'completed' }], undefined)).toEqual({ ok: true, erpPlanId: 'a' });
    expect(choosePlan([{ erpPlanId: 'a', status: 'active' }, { erpPlanId: 'b', status: 'active' }], undefined).ok).toBe(false);
    expect(choosePlan([], 'x')).toEqual({ ok: true, erpPlanId: 'x' });
  });
});
