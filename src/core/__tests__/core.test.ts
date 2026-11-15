import { describe, expect, it } from 'vitest';
import { decimalToPoisha, formatBdt, poishaToDecimal } from '../money/index.js';
import { classifyCoords, encodePolyline, haversineM, simplify } from '../geo/index.js';
import { addDays, businessDate, dhakaInstant, diffDays, weekday } from '../time/index.js';
import { cronMatches } from '../jobs/cron.js';
import { canonicalJson, payloadHash } from '../idempotency/index.js';
import { compareVersions, parseClientHeader, parseIfMatch } from '../http/index.js';
import { normalizeBdPhone } from '../security/crypto.js';
import { CircuitBreaker } from '../../modules/erp-gateway/index.js';

describe('money', () => {
  it('converts decimal strings without floating point drift', () => {
    expect(decimalToPoisha('8500.00')).toBe(850000);
    expect(decimalToPoisha('0.01')).toBe(1);
    expect(decimalToPoisha('9667')).toBe(966700);
    expect(decimalToPoisha('1.5')).toBe(150);
    expect(decimalToPoisha(59500.1)).toBe(5950010);
    expect(decimalToPoisha(null)).toBe(0);
    expect(() => decimalToPoisha('12,000')).toThrow();
  });
  it('round-trips and formats BDT with South-Asian grouping', () => {
    expect(poishaToDecimal(850000)).toBe('8500.00');
    expect(poishaToDecimal(1)).toBe('0.01');
    expect(formatBdt(12345678900)).toBe('৳12,34,56,789');
    expect(formatBdt(850000, 'bn')).toBe('৳৮,৫০০');
    expect(formatBdt(150)).toBe('৳1.50');
  });
});

describe('geo', () => {
  it('classifies ERP coordinates (FR-CUS-004)', () => {
    expect(classifyCoords(22.7105, 90.3702)).toBe('ok');
    expect(classifyCoords(null, null)).toBe('missing');
    expect(classifyCoords(0, 0)).toBe('missing');
    expect(classifyCoords(90.37, 22.71)).toBe('suspect_swapped');
    expect(classifyCoords(51.5, -0.12)).toBe('invalid');
    expect(classifyCoords(22.7, 0)).toBe('invalid');
  });
  it('measures distance and simplifies lines', () => {
    expect(Math.round(haversineM({ lat: 22.7101, lng: 90.3705 }, { lat: 22.7105, lng: 90.3702 }))).toBeGreaterThan(40);
    const line = [0, 1, 2, 3, 4].map((i) => ({ lat: 22.7, lng: 90.3 + i * 0.001 }));
    expect(simplify(line, 10)).toHaveLength(2);
    expect(encodePolyline([{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }])).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });
});

describe('time (Asia/Dhaka)', () => {
  it('rolls the business date at 18:00 UTC (Dhaka midnight)', () => {
    expect(businessDate(new Date('2026-11-14T17:59:59Z'))).toBe('2026-11-14');
    expect(businessDate(new Date('2026-11-14T18:00:00Z'))).toBe('2026-11-15');
    expect(businessDate(new Date('2026-11-14T18:30:00Z'))).toBe('2026-11-15');
  });
  it('date helpers', () => {
    expect(dhakaInstant('2026-11-15', '09:00').toISOString()).toBe('2026-11-15T03:00:00.000Z');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-10-10', '2026-11-15')).toBe(36);
    expect(weekday('2026-11-20')).toBe(5); // Friday
  });
});

describe('cron (Dhaka)', () => {
  it('matches schedules in Dhaka time', () => {
    expect(cronMatches('0 2 * * *', new Date('2026-11-14T20:00:00Z'))).toBe(true); // 02:00 Dhaka
    expect(cronMatches('0 2 * * *', new Date('2026-11-15T02:00:00Z'))).toBe(false);
    expect(cronMatches('*/5 * * * *', new Date('2026-11-15T02:10:00Z'))).toBe(true);
    expect(cronMatches('*/5 * * * *', new Date('2026-11-15T02:11:00Z'))).toBe(false);
    expect(cronMatches('5 0 * * 0-4', new Date('2026-11-14T18:05:00Z'))).toBe(true); // Sun 00:05
  });
});

describe('idempotency hash', () => {
  it('is order independent and ignores fields not selected', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    const f = ['amount', 'plan'];
    expect(payloadHash({ amount: 1, plan: 'x', note: 'a' }, f)).toBe(payloadHash({ plan: 'x', amount: 1, note: 'b' }, f));
    expect(payloadHash({ amount: 1, plan: 'x' }, f)).not.toBe(payloadHash({ amount: 2, plan: 'x' }, f));
  });
});

describe('http helpers', () => {
  it('parses headers', () => {
    expect(compareVersions('1.4.2', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
    expect(parseClientHeader('staff-app/1.4.2 (android 10; Redmi 9A)')).toEqual({ app: 'staff-app', version: '1.4.2' });
    expect(parseIfMatch('W/"7"')).toBe(7);
    expect(parseIfMatch(undefined)).toBeNull();
  });
  it('normalises BD phone numbers', () => {
    expect(normalizeBdPhone('01712345678')).toBe('+8801712345678');
    expect(normalizeBdPhone('+880 1712-345678')).toBe('+8801712345678');
    expect(normalizeBdPhone('8801712345678')).toBe('+8801712345678');
    expect(normalizeBdPhone('01212345678')).toBeNull();
  });
});

describe('circuit breaker (FR-ERP-001)', () => {
  it('opens after 5 failures and half-opens after 60 s', () => {
    let t = 0;
    const b = new CircuitBreaker(5, 60_000, () => t);
    for (let i = 0; i < 4; i++) b.failure();
    expect(b.state).toBe('closed');
    b.failure();
    expect(b.state).toBe('open');
    expect(b.canRequest()).toBe(false);
    t = 60_000;
    expect(b.state).toBe('half_open');
    b.failure();
    expect(b.state).toBe('open');
    t = 120_000;
    b.success();
    expect(b.state).toBe('closed');
  });
});
