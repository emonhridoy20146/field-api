import { describe, expect, it } from 'vitest';
import { changedDetails, checkConvert, checkReopen, checkStatusChange, escapeRegex, isOpen, normalizeBdMobile, normalizePhones, phoneDigits, type Details } from '../domain/rules.js';

describe('prospect status rules (FR-PRO-001)', () => {
  it('PATCH moves freely between new, contacted and dropped; a converted prospect only leaves through /reopen', () => {
    expect(checkStatusChange('new', 'contacted')).toEqual({ ok: true });
    expect(checkStatusChange('contacted', 'dropped')).toEqual({ ok: true });
    expect(checkStatusChange('dropped', 'new')).toEqual({ ok: true });
    expect(checkStatusChange('converted', 'contacted')).toEqual({ ok: false, reason: 'PROSPECT_CONVERTED' });
    // The same status is not a change (an edit of the details of a converted prospect is fine).
    expect(checkStatusChange('new', 'new')).toEqual({ ok: true });
  });

  it('converts once; re-opens only converted or dropped prospects', () => {
    expect(checkConvert('new')).toEqual({ ok: true });
    expect(checkConvert('contacted')).toEqual({ ok: true });
    expect(checkConvert('dropped')).toEqual({ ok: true });
    expect(checkConvert('converted')).toEqual({ ok: false, reason: 'PROSPECT_CONVERTED' });
    expect(checkReopen('converted')).toEqual({ ok: true });
    expect(checkReopen('dropped')).toEqual({ ok: true });
    expect(checkReopen('new')).toEqual({ ok: false, reason: 'PROSPECT_OPEN' });
    expect(checkReopen('contacted')).toEqual({ ok: false, reason: 'PROSPECT_OPEN' });
  });

  it('new and contacted are open', () => {
    expect([isOpen('new'), isOpen('contacted'), isOpen('converted'), isOpen('dropped')]).toEqual([true, true, false, false]);
  });
});

describe('phone numbers', () => {
  it('normalises Bangladesh mobiles to +8801XXXXXXXXX', () => {
    expect(normalizeBdMobile('01712345678')).toBe('+8801712345678');
    expect(normalizeBdMobile('+8801712345678')).toBe('+8801712345678');
    expect(normalizeBdMobile('8801712345678')).toBe('+8801712345678');
    expect(normalizeBdMobile(' 017-1234 5678 ')).toBe('+8801712345678');
    expect(normalizeBdMobile('(017) 1234.5678')).toBe('+8801712345678');
    expect(normalizeBdMobile('1712345678')).toBe('+8801712345678');
    expect(normalizeBdMobile('০১৭১২৩৪৫৬৭৮')).toBe('+8801712345678');
  });

  it('refuses what is not a BD mobile', () => {
    expect(normalizeBdMobile('01212345678')).toBeNull(); // no such operator
    expect(normalizeBdMobile('0171234567')).toBeNull(); // too short
    expect(normalizeBdMobile('017123456789')).toBeNull(); // too long
    expect(normalizeBdMobile('01712abc678')).toBeNull();
    expect(normalizeBdMobile('')).toBeNull();
    expect(normalizeBdMobile('+447911123456')).toBeNull();
  });

  it('normalises a list: drops repeats (first label wins), trims labels, reports invalid indexes', () => {
    expect(normalizePhones([{ number: '01712345678', label: ' Wife ' }, { number: '+8801712345678', label: 'Other' }, { number: '01812345678' }, { number: 'nope' }, { number: '01912345678', label: '  ' }])).toEqual({
      phones: [
        { number: '+8801712345678', label: 'Wife' },
        { number: '+8801812345678', label: null },
        { number: '+8801912345678', label: null },
      ],
      invalid: [3],
    });
    expect(normalizePhones([])).toEqual({ phones: [], invalid: [] });
  });
});

describe('search helpers', () => {
  it('escapes regex characters', () => {
    expect(escapeRegex('a.b*(c)')).toBe('a\\.b\\*\\(c\\)');
    expect(new RegExp(escapeRegex('[x]+?')).test('[x]+?')).toBe(true);
  });

  it('phone digits need at least three digits; Bangla digits count', () => {
    expect(phoneDigits('017-12')).toBe('01712');
    expect(phoneDigits('০১৭')).toBe('017');
    expect(phoneDigits('Karim 12')).toBeNull();
    expect(phoneDigits('Karim')).toBeNull();
  });
});

describe('changedDetails', () => {
  const cur: Details = { name: 'Karim', phones: [{ number: '+8801712345678', label: null }], address: 'Bazaar road', note: null, location: { lat: 22.7, lng: 90.37, accuracyM: null } };

  it('keeps only fields whose value really changes', () => {
    expect(changedDetails(cur, {})).toEqual({});
    expect(changedDetails(cur, { name: 'Karim', phones: [{ number: '+8801712345678', label: null }], note: null, location: { lat: 22.7, lng: 90.37, accuracyM: null } })).toEqual({});
    expect(changedDetails(cur, { name: 'Karim Mia', address: null, location: null })).toEqual({ name: 'Karim Mia', address: null, location: null });
    expect(changedDetails(cur, { note: 'Call after Asr', phones: [] })).toEqual({ note: 'Call after Asr', phones: [] });
  });
});
