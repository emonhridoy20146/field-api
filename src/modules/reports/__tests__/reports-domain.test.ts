import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { bucketOf, buckets, monthEnd, reportRange, validRange, weekStart } from '../domain/period.js';
import { reconcileDay, type ErpRow, type FosRow } from '../domain/reconcile.js';
import { toCsv } from '../export/csv.js';
import { toXlsx } from '../export/xlsx.js';

describe('report periods', () => {
  it('daily and monthly ranges stop at today and refuse the future', () => {
    expect(reportRange('daily', '2026-11-15', '2026-11-15')).toEqual({ from: '2026-11-15', to: '2026-11-15' });
    expect(reportRange('daily', '2026-11-16', '2026-11-15')).toBeNull();
    expect(reportRange('daily', '2026-11', '2026-11-15')).toBeNull();
    expect(reportRange('monthly', '2026-11', '2026-11-15')).toEqual({ from: '2026-11-01', to: '2026-11-15' });
    expect(reportRange('monthly', '2026-10', '2026-11-15')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(reportRange('monthly', '2026-12', '2026-11-15')).toBeNull();
    expect(reportRange('monthly', '2026-13', '2026-11-15')).toBeNull();
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(monthEnd('2026-12')).toBe('2026-12-31');
  });

  it('weeks start on Saturday; buckets list every period once, in order', () => {
    expect(weekStart('2026-11-14')).toBe('2026-11-14'); // a Saturday
    expect(weekStart('2026-11-13')).toBe('2026-11-07'); // Friday belongs to the week before
    expect(bucketOf('2026-11-15', 'month')).toBe('2026-11');
    expect(buckets('2026-11-09', '2026-11-15', 'week')).toEqual(['2026-11-07', '2026-11-14']);
    expect(buckets('2026-10-30', '2026-11-02', 'month')).toEqual(['2026-10', '2026-11']);
    expect(buckets('2026-11-14', '2026-11-15', 'day')).toEqual(['2026-11-14', '2026-11-15']);
    expect(validRange('2026-11-01', '2026-11-15', '2026-11-15', 30)).toBe(true);
    expect(validRange('2026-11-15', '2026-11-01', '2026-11-15', 30)).toBe(false);
    expect(validRange('2026-11-01', '2026-11-16', '2026-11-15', 30)).toBe(false);
    expect(validRange('2025-11-01', '2026-11-15', '2026-11-15', 366)).toBe(false);
    expect(validRange('2026-11-1', '2026-11-15', '2026-11-15', 30)).toBe(false);
  });
});

describe('reconciliation matching (FR-COL-014)', () => {
  const fos = (over: Partial<FosRow>): FosRow => ({ id: 'c1', receiptNo: 'R1', amountPoisha: 1000, status: 'posted', erpKey: 'k1', erpPaymentId: 'p1', ...over });
  const erp = (over: Partial<ErpRow>): ErpRow => ({ erpPaymentId: 'p1', idempotencyKey: 'k1', receiptNo: 'E1', amountPoisha: 1000, reversed: false, ...over });

  it('balanced when every posted collection has the same ERP payment', () => {
    const r = reconcileDay([fos({}), fos({ id: 'c2', erpKey: 'k2', erpPaymentId: null, amountPoisha: 500 })], [erp({}), erp({ erpPaymentId: 'p2', idempotencyKey: 'k2', amountPoisha: 500 })]);
    expect(r.balanced).toBe(true);
    expect(r.totals).toMatchObject({ fosPostedCount: 2, fosPostedPoisha: 1500, erpCount: 2, erpPoisha: 1500, matchedCount: 2 });
  });

  it('names each kind of mismatch', () => {
    const r = reconcileDay(
      [
        fos({ id: 'a', erpKey: 'ka', erpPaymentId: 'pa' }), // ERP does not show it
        fos({ id: 'b', erpKey: 'kb', erpPaymentId: 'pb', amountPoisha: 900 }), // ERP has another amount
        fos({ id: 'c', erpKey: 'kc', erpPaymentId: 'pc' }), // reversed in ERP
        fos({ id: 'd', erpKey: 'kd', erpPaymentId: null, status: 'conflict' }),
        fos({ id: 'e', erpKey: 'ke', erpPaymentId: 'pe', status: 'voided' }), // voided here, alive there
        fos({ id: 'f', erpKey: 'kf', erpPaymentId: null, status: 'voided' }), // voided and never posted: fine
      ],
      [erp({ erpPaymentId: 'pb', idempotencyKey: 'kb' }), erp({ erpPaymentId: 'pc', idempotencyKey: 'kc', reversed: true }), erp({ erpPaymentId: 'pe', idempotencyKey: 'ke' }), erp({ erpPaymentId: 'px', idempotencyKey: null, amountPoisha: 700 })],
    );
    expect(r.balanced).toBe(false);
    expect(r.mismatches.map((m) => [m.kind, m.collectionId, m.erpPaymentId])).toEqual([
      ['missing_in_erp', 'a', 'pa'],
      ['amount_differs', 'b', 'pb'],
      ['reversed_in_erp', 'c', 'pc'],
      ['not_posted', 'd', null],
      ['voided_in_fos', 'e', 'pe'],
      ['missing_in_fos', null, 'px'],
    ]);
    expect(r.totals).toMatchObject({ fosPostedCount: 3, fosWaitingCount: 1, erpCount: 3, erpPoisha: 2700, matchedCount: 0 });
  });
});

describe('export writers', () => {
  it('CSV: BOM, quoting, Bangla, formula cells neutralised', () => {
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(toCsv(['নাম', 'Amount'], [['করিম, "মিয়া"', 1500.5], ['=HYPERLINK("http://x")', null], ['-5 as text', -5]]));
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe('নাম,Amount\r\n"করিম, ""মিয়া""",1500.5\r\n"\'=HYPERLINK(""http://x"")",\r\n\'-5 as text,-5\r\n');
  });

  it('XLSX: a readable zip with the sheet, escaped text and numeric cells; same input gives same bytes', () => {
    const bytes = Buffer.from(toXlsx('collections', ['গ্রাহক', 'Amount'], [['A & B <c>', 12.5], [null, 3]]));
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(Buffer.from(toXlsx('collections', ['গ্রাহক', 'Amount'], [['A & B <c>', 12.5], [null, 3]])).equals(bytes)).toBe(true);
    // Walk the central directory and inflate every entry.
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = bytes.readUInt16LE(end + 10);
    let at = bytes.readUInt32LE(end + 16);
    const files = new Map<string, string>();
    for (let i = 0; i < count; i++) {
      expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
      const size = bytes.readUInt32LE(at + 20);
      const nameLen = bytes.readUInt16LE(at + 28);
      const local = bytes.readUInt32LE(at + 42);
      const name = bytes.subarray(at + 46, at + 46 + nameLen).toString();
      const dataAt = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      files.set(name, inflateRawSync(bytes.subarray(dataAt, dataAt + size)).toString());
      at += 46 + nameLen;
    }
    expect([...files.keys()]).toContain('xl/worksheets/sheet1.xml');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<t xml:space="preserve">গ্রাহক</t>');
    expect(sheet).toContain('A &amp; B &lt;c&gt;');
    expect(sheet).toContain('<c r="B2" s="0"><v>12.5</v></c>');
    expect(sheet).not.toContain('r="A3"'); // empty cell is simply absent
    expect(files.get('xl/workbook.xml')).toContain('name="collections"');
  });
});

describe('leaderboard ranking (FR-REP-005)', () => {
  it('shares ranks on ties, skips after them, and lists the unranked last', async () => {
    const { rank } = await import('../domain/leaderboard.js');
    const out = rank([
      { userId: 'e', name: 'Eva', value: 10, eligible: true },
      { userId: 'a', name: 'Anis', value: 30, eligible: true },
      { userId: 'c', name: 'Chumki', value: 20, eligible: true },
      { userId: 'b', name: 'Babu', value: 20, eligible: true },
      { userId: 'x', name: 'Xavier', value: 99, eligible: false },
      { userId: 'n', name: 'Nobody', value: null, eligible: true },
    ]);
    expect(out.map((r) => [r.userId, r.rank])).toEqual([['a', 1], ['b', 2], ['c', 2], ['e', 4], ['n', null], ['x', null]]);
    expect(rank([])).toEqual([]);
  });
});
