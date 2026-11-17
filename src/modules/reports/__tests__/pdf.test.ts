import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { runsOf, toPdf, wrap } from '../export/pdf.js';

const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()).join('');
const ascii = new Set([...Array(95).keys()].map((i) => i + 32));

/** Every stream of the file, inflated, so the page content can be read. */
function contentStreams(pdf: Buffer): string[] {
  const out: string[] = [];
  const raw = pdf.toString('latin1');
  const re = /<< \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) out.push(inflateSync(pdf.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]))).toString('latin1'));
  return out;
}

describe('pdf text runs', () => {
  it('splits Bangla from Latin, keeps spaces in the run they follow, and replaces what no font has', () => {
    expect(runsOf('মোঃ করিম 1500 টাকা', ascii)).toEqual([
      { script: 'beng', text: 'মোঃ করিম ' },
      { script: 'latn', text: '1500 ' },
      { script: 'beng', text: 'টাকা' },
    ]);
    expect(runsOf('a中b\nc', ascii)).toEqual([{ script: 'latn', text: 'a?b c' }]);
    expect(runsOf('', ascii)).toEqual([]);
  });

  it('wraps on words and breaks a long word between grapheme clusters only', () => {
    const m = { width: (t: string) => [...new Intl.Segmenter('bn', { granularity: 'grapheme' }).segment(t)].length };
    expect(wrap(m, 'one two three', 7, 'regular', 8)).toEqual(['one two', 'three']);
    expect(wrap(m, '', 5, 'regular', 8)).toEqual(['']);
    // "ক্ষ" and "স্ট্রি" are one cluster each and must stay whole.
    const lines = wrap(m, 'ক্ষস্ট্রিকাজ', 2, 'regular', 8);
    expect(lines.join('')).toBe('ক্ষস্ট্রিকাজ');
    expect(lines[0]).toBe('ক্ষস্ট্রি');
  });
});

describe('toPdf', () => {
  it('writes a valid file with embedded fonts, searchable text and one footer per page', async () => {
    const footers: string[] = [];
    const rows = Array.from({ length: 120 }, (_, i) => [`কর্মী ${i + 1}`, `FS${String(i).padStart(3, '0')}`, 1500 + i, 'শ্রী বৌদ্ধ স্ট্রিট']);
    const pdf = Buffer.from(
      await toPdf({
        title: 'কর্মীর পারফরম্যান্স',
        subtitle: 'শাখা BRL01 · 2026-11-15',
        header: ['নাম', 'Code', 'টাকা', 'ঠিকানা'],
        rows,
        footer: (p, n) => {
          const f = `পৃষ্ঠা ${p} / ${n}`;
          footers.push(f);
          return f;
        },
      }),
    );
    const raw = pdf.toString('latin1');
    expect(raw.startsWith('%PDF-1.7\n')).toBe(true);
    expect(raw.endsWith('%%EOF\n')).toBe(true);

    // The cross-reference table points at every object.
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(raw)![1]);
    expect(raw.slice(start, start + 5)).toBe('xref\n');
    const [, count] = /^xref\n0 (\d+)\n/.exec(raw.slice(start))!;
    const entries = raw.slice(start).split('\n').slice(3, 2 + Number(count));
    entries.forEach((e, i) => expect(raw.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + String(i + 1).length + 6)).toBe(`${i + 1} 0 obj`));

    const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(raw)![1]);
    expect(pages).toBeGreaterThan(1);
    expect(raw.match(/\/Type \/Page /g)).toHaveLength(pages);
    expect(footers).toEqual(Array.from({ length: pages }, (_, i) => `পৃষ্ঠা ${i + 1} / ${pages}`));
    expect(raw).toContain('/MediaBox [0 0 841.89 595.28]');
    // Bangla and Latin, regular and bold: every font used is embedded, none referenced by name only.
    expect(raw.match(/\/FontFile2 /g)).toHaveLength(4);
    expect(raw.match(/\/Subtype \/Type0 /g)).toHaveLength(4);
    expect(raw).toContain('/CIDToGIDMap /Identity');

    const text = contentStreams(pdf).filter((s) => s.includes('BDC')).join('\n');
    expect(text.match(/BDC BT/g)!.length).toBe(text.match(/ET EMC/g)!.length);
    expect(text).toContain(hex('শ্রী বৌদ্ধ স্ট্রিট')); // ActualText keeps copy and search working
    expect(text).toContain(hex('কর্মী 120'));
    // The header row is repeated on every page.
    expect(text.split(`<FEFF${hex('ঠিকানা')}>`).length - 1).toBe(pages);
    expect(raw).toContain(`/Title <FEFF${hex('কর্মীর পারফরম্যান্স')}>`);
  });

  it('an empty table is still one page with the header', async () => {
    const pdf = Buffer.from(await toPdf({ title: 'Empty', subtitle: '', header: ['A', 'B'], rows: [], footer: () => 'p 1' }));
    expect(pdf.toString('latin1')).toMatch(/\/Count 1 >>/);
  });
});
