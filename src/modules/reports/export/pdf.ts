import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { Cell } from './csv.js';
import type * as Harfbuzz from 'harfbuzzjs';

/**
 * FR-REP-003/004: table exports as PDF with the fonts embedded. Bangla needs a real shaping engine
 * (conjuncts, reph, vowel signs that move before the consonant), so every text run is shaped by
 * HarfBuzz and drawn glyph by glyph; fontkit (used by the common PDF libraries) breaks words such
 * as দ্ধ. Fonts: Noto Sans Bengali and a Latin-1 subset of Noto Sans (SIL OFL, assets/fonts).
 */

type HB = typeof Harfbuzz;
type Weight = 'regular' | 'bold';
type Script = 'beng' | 'latn';

interface FontFace {
  key: string;
  pdfName: string;
  data: Buffer;
  font: InstanceType<HB['Font']>;
  upem: number;
  ascender: number;
  descender: number;
  bbox: [number, number, number, number];
  unicodes: Set<number>;
}

interface Engine {
  hb: HB;
  fonts: Record<`${Script}-${Weight}`, FontFace>;
  buffer: InstanceType<HB['Buffer']>;
  cache: Map<string, Shaped>;
}

interface Glyph {
  gid: number;
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}
interface Shaped {
  glyphs: Glyph[];
  width: number; // font units
}

const FILES: Record<`${Script}-${Weight}`, [string, string]> = {
  'beng-regular': ['NotoSansBengali-Regular.ttf', 'NotoSansBengali-Regular'],
  'beng-bold': ['NotoSansBengali-Bold.ttf', 'NotoSansBengali-Bold'],
  'latn-regular': ['NotoSansLatin-Regular.ttf', 'NotoSans-Regular'],
  'latn-bold': ['NotoSansLatin-Bold.ttf', 'NotoSans-Bold'],
};

let engine: Promise<Engine> | null = null;

/** harfbuzzjs instantiates its WebAssembly on import, so it is loaded only when a PDF is built. */
function loadEngine(): Promise<Engine> {
  engine ??= (async () => {
    const hb = await import('harfbuzzjs');
    const dir = process.env.FONTS_DIR ?? path.resolve(process.cwd(), 'assets/fonts');
    const fonts = {} as Engine['fonts'];
    for (const [key, [file, pdfName]] of Object.entries(FILES) as [keyof Engine['fonts'], [string, string]][]) {
      const data = readFileSync(path.join(dir, file));
      const face = new hb.Face(new hb.Blob(new Uint8Array(data)));
      const font = new hb.Font(face);
      const head = face.referenceTable('head');
      const v = head ? new DataView(head.buffer, head.byteOffset, head.byteLength) : null;
      const ext = font.hExtents();
      fonts[key] = {
        key,
        pdfName,
        data,
        font,
        upem: face.upem,
        ascender: ext.ascender,
        descender: ext.descender,
        bbox: v ? [v.getInt16(36), v.getInt16(38), v.getInt16(40), v.getInt16(42)] : [-500, -300, 1500, 1100],
        unicodes: new Set(face.collectUnicodes()),
      };
    }
    return { hb, fonts, buffer: new hb.Buffer(), cache: new Map() };
  })();
  return engine;
}

const isBengali = (cp: number) => (cp >= 0x0980 && cp <= 0x09ff) || cp === 0x0964 || cp === 0x0965 || cp === 0x200c || cp === 0x200d || cp === 0x25cc;
const isSpace = (cp: number) => cp === 0x20 || cp === 0xa0;

/** Split text into script runs; spaces stay with the run they are in. Characters no font has become "?". */
export function runsOf(text: string, latin: Set<number>): { script: Script; text: string }[] {
  const out: { script: Script; text: string }[] = [];
  for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
    const cp = ch.codePointAt(0)!;
    const last = out[out.length - 1];
    const script: Script = isBengali(cp) ? 'beng' : isSpace(cp) && last ? last.script : 'latn';
    const c = script === 'latn' && !latin.has(cp) ? '?' : ch;
    if (last && last.script === script) last.text += c;
    else out.push({ script, text: c });
  }
  return out;
}

function shape(e: Engine, f: FontFace, text: string): Shaped {
  const k = `${f.key}\u0000${text}`;
  const hit = e.cache.get(k);
  if (hit) return hit;
  const b = e.buffer;
  b.reset();
  b.addText(text);
  b.guessSegmentProperties();
  e.hb.shape(f.font, b);
  const infos = b.getGlyphInfos();
  const pos = b.getGlyphPositions();
  const glyphs = infos.map((g, i) => ({ gid: g.codepoint, xAdvance: pos[i]!.xAdvance, xOffset: pos[i]!.xOffset, yOffset: pos[i]!.yOffset }));
  const shaped = { glyphs, width: glyphs.reduce((s, g) => s + g.xAdvance, 0) };
  if (e.cache.size > 50_000) e.cache.clear();
  e.cache.set(k, shaped);
  return shaped;
}

class Measure {
  constructor(private readonly e: Engine) {}
  width(text: string, w: Weight, size: number): number {
    let total = 0;
    for (const r of runsOf(text, this.e.fonts[`latn-${w}`].unicodes)) {
      const f = this.e.fonts[`${r.script}-${w}`];
      total += (shape(this.e, f, r.text).width * size) / f.upem;
    }
    return total;
  }
}

const segmenter = new Intl.Segmenter('bn', { granularity: 'grapheme' });

/** Greedy word wrap; a word wider than the column is broken between grapheme clusters, never inside one. */
export function wrap(m: { width(t: string, w: Weight, s: number): number }, text: string, max: number, w: Weight, size: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let line = '';
  const push = (word: string) => {
    if (m.width(word, w, size) <= max) return void (line = word);
    let part = '';
    for (const { segment } of segmenter.segment(word)) {
      if (part && m.width(part + segment, w, size) > max) {
        lines.push(part);
        part = segment;
      } else part += segment;
    }
    line = part;
  };
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (!line) push(word);
    else if (m.width(next, w, size) <= max) line = next;
    else {
      lines.push(line);
      push(word);
    }
  }
  lines.push(line);
  return lines;
}

// ---------------- page layout ----------------

export interface PdfTable {
  title: string;
  subtitle: string;
  header: string[];
  rows: Cell[][];
  /** Footer text for page `page` of `pages`. */
  footer: (page: number, pages: number) => string;
}

const PAGE_W = 841.89; // A4 landscape
const PAGE_H = 595.28;
const MARGIN = 28;
const PAD_X = 3;
const PAD_Y = 2.5;
const SIZES = [8, 7.5, 7, 6.5, 6];
const SAMPLE_ROWS = 2000; // column widths come from the first rows; later rows wrap inside them

const cellText = (c: Cell) => (c === null || c === undefined ? '' : String(c));

interface DrawText {
  text: string;
  x: number;
  y: number;
  size: number;
  weight: Weight;
}
interface PageOps {
  rects: { x: number; y: number; w: number; h: number; gray: number }[];
  lines: { x1: number; y1: number; x2: number; y2: number }[];
  texts: DrawText[];
}

function layout(m: Measure, t: PdfTable): PageOps[] {
  const avail = PAGE_W - 2 * MARGIN;
  const cols = t.header.length;
  const sample = t.rows.slice(0, SAMPLE_ROWS);
  let size = SIZES[SIZES.length - 1]!;
  let minW: number[] = [];
  let prefW: number[] = [];
  for (const s of SIZES) {
    minW = [];
    prefW = [];
    for (let c = 0; c < cols; c++) {
      const head = t.header[c] ?? '';
      let min = Math.max(...head.split(/\s+/).map((wd) => m.width(wd, 'bold', s)), 0);
      let pref = m.width(head, 'bold', s);
      for (const r of sample) {
        const v = cellText(r[c] ?? null);
        if (!v) continue;
        pref = Math.max(pref, m.width(v, 'regular', s));
        for (const wd of v.split(/\s+/)) min = Math.max(min, m.width(wd, 'regular', s));
      }
      // A very long single word must not starve the other columns; it wraps by grapheme instead.
      minW.push(Math.min(min, avail / 4) + 2 * PAD_X);
      prefW.push(pref + 2 * PAD_X);
    }
    size = s;
    if (minW.reduce((a, b) => a + b, 0) <= avail) break;
  }
  const sumMin = minW.reduce((a, b) => a + b, 0);
  const sumPref = prefW.reduce((a, b) => a + b, 0);
  let widths: number[];
  if (sumPref <= avail) widths = prefW.map((p) => (p * avail) / sumPref);
  else if (sumMin >= avail) widths = minW.map((p) => (p * avail) / sumMin);
  else {
    const extra = prefW.map((p, i) => p - minW[i]!);
    const sumExtra = extra.reduce((a, b) => a + b, 0) || 1;
    widths = minW.map((mn, i) => mn + ((avail - sumMin) * extra[i]!) / sumExtra);
  }
  const xs = widths.reduce<number[]>((acc, w, i) => (acc.push(i === 0 ? MARGIN : acc[i - 1]! + widths[i - 1]!), acc), []);
  const lineH = size * 1.5;
  const numeric = t.header.map((_, c) => sample.length > 0 && sample.every((r) => r[c] === null || r[c] === undefined || typeof r[c] === 'number'));

  const pages: PageOps[] = [];
  let page: PageOps;
  let y = 0;
  const top = PAGE_H - MARGIN;
  const bottom = MARGIN + 14;

  const cellLines = (row: Cell[], weight: Weight) => row.map((v, c) => wrap(m, cellText(v), widths[c]! - 2 * PAD_X, weight, size));
  const drawRow = (lines: string[][], weight: Weight, shade: number | null) => {
    const h = Math.max(...lines.map((l) => l.length)) * lineH + 2 * PAD_Y;
    if (shade !== null) page.rects.push({ x: MARGIN, y: y - h, w: avail, h, gray: shade });
    lines.forEach((ls, c) => {
      ls.forEach((text, i) => {
        const tw = m.width(text, weight, size);
        const x = numeric[c] && weight === 'regular' ? xs[c]! + widths[c]! - PAD_X - tw : xs[c]! + PAD_X;
        page.texts.push({ text, x, y: y - PAD_Y - size * 1.12 - i * lineH, size, weight });
      });
    });
    page.lines.push({ x1: MARGIN, y1: y - h, x2: MARGIN + avail, y2: y - h });
    for (const x of [...xs, MARGIN + avail]) page.lines.push({ x1: x, y1: y, x2: x, y2: y - h });
    y -= h;
  };
  const headerLines = cellLines(t.header, 'bold');
  const headerH = Math.max(...headerLines.map((l) => l.length)) * lineH + 2 * PAD_Y;
  const newPage = () => {
    page = { rects: [], lines: [], texts: [] };
    pages.push(page);
    y = top;
    if (pages.length === 1) {
      page.texts.push({ text: t.title, x: MARGIN, y: y - 13, size: 13, weight: 'bold' });
      y -= 13 * 1.6;
      for (const sub of wrap(m, t.subtitle, avail, 'regular', 8.5)) {
        page.texts.push({ text: sub, x: MARGIN, y: y - 8.5, size: 8.5, weight: 'regular' });
        y -= 8.5 * 1.5;
      }
      y -= 6;
    }
    page.lines.push({ x1: MARGIN, y1: y, x2: MARGIN + avail, y2: y });
    drawRow(headerLines, 'bold', 0.9);
  };
  newPage();
  t.rows.forEach((row, i) => {
    const ls = cellLines(row, 'regular');
    const h = Math.max(...ls.map((l) => l.length)) * lineH + 2 * PAD_Y;
    if (y - h < bottom && y < top - headerH - 1) newPage();
    drawRow(ls, 'regular', i % 2 === 1 ? 0.965 : null);
  });
  return pages;
}

// ---------------- PDF objects ----------------

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const hex4 = (n: number) => n.toString(16).padStart(4, '0');
function utf16Hex(s: string): string {
  let out = 'FEFF';
  for (let i = 0; i < s.length; i++) out += hex4(s.charCodeAt(i)).toUpperCase();
  return `<${out}>`;
}

class Writer {
  private chunks: Buffer[] = [];
  private offsets: number[] = [];
  private length = 0;
  private count = 0;

  reserve(): number {
    return ++this.count;
  }
  private push(b: Buffer) {
    this.chunks.push(b);
    this.length += b.length;
  }
  header() {
    this.push(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'));
  }
  obj(id: number, body: string) {
    this.offsets[id] = this.length;
    this.push(Buffer.from(`${id} 0 obj\n${body}\nendobj\n`, 'latin1'));
  }
  stream(id: number, dict: string, data: Buffer) {
    this.offsets[id] = this.length;
    this.push(Buffer.from(`${id} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'));
    this.push(data);
    this.push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
  }
  finish(root: number, info: number): Uint8Array {
    const xref = this.length;
    let s = `xref\n0 ${this.count + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= this.count; i++) s += `${String(this.offsets[i] ?? 0).padStart(10, '0')} 00000 n \n`;
    s += `trailer\n<< /Size ${this.count + 1} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    this.push(Buffer.from(s, 'latin1'));
    return new Uint8Array(Buffer.concat(this.chunks));
  }
}

/** Build the PDF. Fonts are embedded whole (they are already subset to the scripts in use). */
export async function toPdf(t: PdfTable): Promise<Uint8Array> {
  const e = await loadEngine();
  const m = new Measure(e);
  const pages = layout(m, t);
  const used = new Map<string, Map<number, number>>(); // font key → gid → advance
  const resName = (k: string) => `F${Object.keys(FILES).indexOf(k) + 1}`;

  const content = (p: PageOps, index: number): string => {
    const out: string[] = ['0.4 w 0.7 G'];
    for (const r of p.rects) out.push(`${r.gray} g ${num(r.x)} ${num(r.y)} ${num(r.w)} ${num(r.h)} re f`);
    out.push('0 g');
    for (const l of p.lines) out.push(`${num(l.x1)} ${num(l.y1)} m ${num(l.x2)} ${num(l.y2)} l S`);
    const footer: DrawText = { text: t.footer(index + 1, pages.length), x: MARGIN, y: MARGIN - 6, size: 7, weight: 'regular' };
    for (const d of [...p.texts, footer]) {
      // ActualText keeps copy and search working: shaped glyphs alone do not map back to Bangla text.
      out.push(`/Span << /ActualText ${utf16Hex(d.text)} >> BDC BT`);
      let x = d.x;
      for (const r of runsOf(d.text, e.fonts[`latn-${d.weight}`].unicodes)) {
        const f = e.fonts[`${r.script}-${d.weight}`];
        const u = used.get(f.key) ?? used.set(f.key, new Map()).get(f.key)!;
        const k = d.size / f.upem;
        out.push(`/${resName(f.key)} ${num(d.size)} Tf`);
        for (const g of shape(e, f, r.text).glyphs) {
          u.set(g.gid, e.fonts[f.key as keyof Engine['fonts']].font.glyphHAdvance(g.gid));
          out.push(`1 0 0 1 ${num(x + g.xOffset * k)} ${num(d.y + g.yOffset * k)} Tm <${hex4(g.gid)}> Tj`);
          x += g.xAdvance * k;
        }
      }
      out.push('ET EMC');
    }
    return out.join('\n');
  };
  const streams = pages.map((p, i) => content(p, i));

  const w = new Writer();
  w.header();
  const catalog = w.reserve();
  const pagesId = w.reserve();
  const info = w.reserve();
  const fontIds = new Map<string, number>();
  for (const key of used.keys()) {
    const f = e.fonts[key as keyof Engine['fonts']];
    const type0 = w.reserve();
    const cid = w.reserve();
    const desc = w.reserve();
    const file = w.reserve();
    fontIds.set(key, type0);
    const s = 1000 / f.upem;
    const widths = [...used.get(key)!.entries()].sort((a, b) => a[0] - b[0]).map(([g, adv]) => `${g} [${Math.round(adv * s)}]`).join(' ');
    w.obj(type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${f.pdfName} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] >>`);
    w.obj(cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${f.pdfName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`);
    w.obj(
      desc,
      `<< /Type /FontDescriptor /FontName /${f.pdfName} /Flags 4 /FontBBox [${f.bbox.map((v) => Math.round(v * s)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(f.ascender * s)} /Descent ${Math.round(f.descender * s)} /CapHeight ${Math.round(f.ascender * s * 0.7)} /StemV 80 /FontFile2 ${file} 0 R >>`,
    );
    w.stream(file, `/Filter /FlateDecode /Length1 ${f.data.length}`, deflateSync(f.data));
  }
  const fontRes = [...fontIds.entries()].map(([k, id]) => `/${resName(k)} ${id} 0 R`).join(' ');
  const pageIds: number[] = [];
  for (const body of streams) {
    const pageId = w.reserve();
    const contentId = w.reserve();
    pageIds.push(pageId);
    w.obj(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << ${fontRes} >> >> /Contents ${contentId} 0 R >>`);
    w.stream(contentId, '/Filter /FlateDecode', deflateSync(Buffer.from(body, 'latin1')));
  }
  w.obj(pagesId, `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  w.obj(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R /MarkInfo << /Marked true >> >>`);
  w.obj(info, `<< /Title ${utf16Hex(t.title)} /Producer (Howlader FOS field-api) >>`);
  return w.finish(catalog, info);
}
