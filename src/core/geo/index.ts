export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number]; // [lng, lat]
}

export const toPoint = (p: LatLng): GeoPoint => ({ type: 'Point', coordinates: [p.lng, p.lat] });
export const fromPoint = (p: GeoPoint): LatLng => ({ lat: p.coordinates[1], lng: p.coordinates[0] });

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Generous Bangladesh bounding box (lat 20.3–26.8, lng 87.9–92.8). */
export const BD_BOUNDS = { minLat: 20.3, maxLat: 26.8, minLng: 87.9, maxLng: 92.8 };

export function inBangladesh(p: LatLng): boolean {
  return p.lat >= BD_BOUNDS.minLat && p.lat <= BD_BOUNDS.maxLat && p.lng >= BD_BOUNDS.minLng && p.lng <= BD_BOUNDS.maxLng;
}

export type CoordStatus = 'ok' | 'missing' | 'invalid' | 'suspect_swapped';

/** FR-CUS-004: classify raw ERP coordinates. Never show a wrong pin. */
export function classifyCoords(lat: number | null | undefined, lng: number | null | undefined): CoordStatus {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return 'missing';
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'invalid';
  if (lat === 0 && lng === 0) return 'missing';
  if (lat === 0 || lng === 0) return 'invalid';
  if (inBangladesh({ lat, lng })) return 'ok';
  if (inBangladesh({ lat: lng, lng: lat })) return 'suspect_swapped';
  return 'invalid';
}

export function parseBbox(s: string): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  const parts = s.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLng, minLat, maxLng, maxLat] = parts as [number, number, number, number];
  if (minLng >= maxLng || minLat >= maxLat) return null;
  return { minLng, minLat, maxLng, maxLat };
}

export function parseLatLng(s: string): LatLng | null {
  const parts = s.split(',').map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lat, lng] = parts as [number, number];
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Douglas–Peucker simplification with tolerance in metres (equirectangular approximation). */
export function simplify(points: LatLng[], toleranceM: number): LatLng[] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDistanceM(points[i]!, points[s]!, points[e]!);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > toleranceM) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function perpDistanceM(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos(rad((a.lat + b.lat) / 2));
  const ax = a.lng * k, ay = a.lat, bx = b.lng * k, by = b.lat, px = p.lng * k, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const deg = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  return (deg * Math.PI * R) / 180;
}

/** Google encoded polyline, precision 5. */
export function encodePolyline(points: LatLng[]): string {
  let out = '';
  let pLat = 0, pLng = 0;
  const enc = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (x >= 0x20) {
      s += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    return s + String.fromCharCode(x + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5), lng = Math.round(p.lng * 1e5);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}
