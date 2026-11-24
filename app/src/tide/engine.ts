/**
 * Tide engine.
 *
 * The water level is computed from harmonic constituents:
 *     h(t) = offset + Σ aᵢ · cos(ωᵢ·T − gᵢ)      T = hours since 1900-01-01T00:00Z
 *
 * Two data sources are used:
 *  1. Live official predictions from NOAA CO-OPS (free, CORS enabled) — the
 *     authoritative source, used whenever the browser can reach the API.
 *  2. Bundled harmonic constants derived from those same official predictions
 *     by least-squares fitting, so the app keeps working offline and can
 *     interpolate a tide field between stations.
 */
import type {Constituent, Station, StationFile, TidePoint} from './types';

export const EPOCH_MS = Date.UTC(1900, 0, 1, 0, 0, 0);
const NOAA_API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const NOAA_APP = 'TideAtlasWeb';

/** hours since the 1900 epoch */
export function hoursSinceEpoch(t: number): number {
  return (t - EPOCH_MS) / 3_600_000;
}

/** water level in metres for a station at a given time */
export function tideAt(station: Station, t: number): number {
  const T = hoursSinceEpoch(t);
  let h = station.offset || 0;
  for (const c of station.const) {
    h += c.a * Math.cos((c.w * T - c.g) * (Math.PI / 180));
  }
  return h;
}

/** same, but for a free-form set of constituents */
export function tideFromConstants(consts: Constituent[], offset: number, t: number): number {
  const T = hoursSinceEpoch(t);
  let h = offset;
  for (const c of consts) {
    h += c.a * Math.cos((c.w * T - c.g) * (Math.PI / 180));
  }
  return h;
}

/** local maxima / minima of a sampled curve */
export function findExtrema(points: TidePoint[]): TidePoint[] {
  const out: TidePoint[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1].v;
    const b = points[i].v;
    const c = points[i + 1].v;
    if ((b > a && b >= c) || (b < a && b <= c)) {
      out.push({t: points[i].t, v: b, type: b > a ? 'H' : 'L'});
    }
  }
  return out;
}

/** sample the model over a window */
export function sampleCurve(station: Station, from: number, to: number, stepMin = 30): TidePoint[] {
  const out: TidePoint[] = [];
  const step = stepMin * 60_000;
  for (let t = from; t <= to; t += step) {
    out.push({t, v: tideAt(station, t)});
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* live NOAA data                                                      */
/* ------------------------------------------------------------------ */

export interface NoaaResult {
  points: TidePoint[];
  ok: boolean;
  error?: string;
}

function noaaDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** official hourly predictions for a station, in metres relative to MSL */
export async function fetchNoaaPredictions(
  stationId: string,
  from: Date,
  to: Date,
  signal?: AbortSignal,
): Promise<NoaaResult> {
  const timeout = AbortSignal.timeout(20000);
  const url =
    `${NOAA_API}?product=predictions&application=${NOAA_APP}` +
    `&begin_date=${noaaDate(from)}&end_date=${noaaDate(to)}` +
    `&datum=MSL&station=${stationId}&time_zone=gmt&interval=h&units=metric&format=json`;
  try {
    const res = await fetch(url, {signal: signal ?? timeout});
    if (!res.ok) return {points: [], ok: false, error: `HTTP ${res.status}`};
    const json = await res.json();
    if (json.error) return {points: [], ok: false, error: json.error.message};
    const points: TidePoint[] = (json.predictions ?? []).map((p: any) => ({
      t: Date.parse(p.t.replace(' ', 'T') + 'Z'),
      v: parseFloat(p.v),
    }));
    return {points, ok: true};
  } catch (e) {
    return {points: [], ok: false, error: String(e)};
  }
}

/** official high/low water events for a station */
export async function fetchNoaaHighLow(stationId: string, from: Date, to: Date): Promise<TidePoint[]> {
  const timeout = AbortSignal.timeout(20000);
  const url =
    `${NOAA_API}?product=high_low&application=${NOAA_APP}` +
    `&begin_date=${noaaDate(from)}&end_date=${noaaDate(to)}` +
    `&datum=MSL&station=${stationId}&time_zone=gmt&interval=h&units=metric&format=json`;
  try {
    const res = await fetch(url, {signal: timeout});
    if (!res.ok) return [];
    const json = await res.json();
    if (json.error) return [];
    return (json.predictions ?? []).map((p: any) => ({
      t: Date.parse(p.t.replace(' ', 'T') + 'Z'),
      v: parseFloat(p.v),
      type: p.type === 'H' ? ('H' as const) : ('L' as const),
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* station selection & interpolation                                   */
/* ------------------------------------------------------------------ */

function haversineKm(a: {lat: number; lng: number}, b: {lat: number; lng: number}): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function nearestStations(stations: Station[], lat: number, lng: number, count = 4): Station[] {
  return [...stations]
    .map((s) => ({s, d: haversineKm(s, {lat, lng})}))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((x) => x.s);
}

export function nearestStation(stations: Station[], lat: number, lng: number): Station | undefined {
  return nearestStations(stations, lat, lng, 1)[0];
}

/**
 * Interpolate a tide field at an arbitrary point from the surrounding
 * stations: the harmonic constants are averaged in the complex plane, which
 * keeps amplitudes and phases physically meaningful.
 */
export function interpolateField(stations: Station[], lat: number, lng: number, t: number): number {
  const near = nearestStations(stations, lat, lng, 5);
  if (!near.length) return 0;
  const names = new Set<string>();
  for (const s of near) for (const c of s.const) names.add(c.n);
  const T = hoursSinceEpoch(t);
  let h = 0;
  for (const name of names) {
    let re = 0;
    let im = 0;
    let wsum = 0;
    let speed = 0;
    for (const s of near) {
      const d = haversineKm(s, {lat, lng});
      const weight = 1 / Math.pow(Math.max(d, 5), 2);
      const k = s.const.find((x) => x.n === name);
      if (!k) continue;
      const rad = (k.g * Math.PI) / 180;
      re += weight * k.a * Math.cos(rad);
      im += weight * k.a * Math.sin(rad);
      wsum += weight;
      speed = k.w;
    }
    if (!wsum) continue;
    const a = Math.hypot(re, im) / wsum;
    const g = Math.atan2(im, re);
    h += a * Math.cos((speed * T - g) * (Math.PI / 180));
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* geocoding                                                           */
/* ------------------------------------------------------------------ */

export interface GeoResult {
  name: string;
  lat: number;
  lng: number;
  kind: 'place' | 'station';
}

/** بحث عن الأماكن عبر Nominatim (مجاني، بلا مفتاح) */
export async function geocode(query: string, lang: string): Promise<GeoResult[]> {
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}` +
    `&accept-language=${lang}`;
  try {
    const res = await fetch(url, {signal: AbortSignal.timeout(12000)});
    if (!res.ok) return [];
    const json = await res.json();
    return (json ?? []).map((r: any) => ({
      name: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      kind: 'place' as const,
    }));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

export async function loadStations(url = 'data/stations.json'): Promise<StationFile> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot load ${url}: HTTP ${res.status}`);
  return (await res.json()) as StationFile;
}
