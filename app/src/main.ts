import * as maplibregl from 'maplibre-gl';
import type {Map as RasterMap} from 'leaflet';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import {TideDemLayer} from './map/dem-layer';
import {IslandManager} from './map/islands';
import {TideChart} from './ui/chart';
import {fmt, fmtTime, getLang, setLang, t} from './ui/i18n';
import {
  fetchNoaaHighLow,
  fetchNoaaPredictions,
  findExtrema,
  geocode,
  loadStations,
  nearestStations,
  sampleCurve,
  tideAt,
} from './tide/engine';
import type {Station, TidePoint} from './tide/types';

// 'liberty' أقرب ما يكون إلى خرائط Google
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OSM_MAX_ZOOM = 19;
const DEFAULT_CENTER: [number, number] = [-122.4, 37.8];
// بديل يعمل إن تعذّر تحميل النمط المتجهي (بلا مفتاح API)
const RASTER_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [OSM_TILES],
      tileSize: 256,
      maxzoom: OSM_MAX_ZOOM,
      attribution: OSM_ATTRIBUTION,
    },
  },
  layers: [{id: 'osm', type: 'raster', source: 'osm'}],
};
// MapLibre derives the worker URL from its own module URL; serve the worker explicitly.
maplibregl.setWorkerUrl(`${import.meta.env.BASE_URL}maplibre-gl-worker.mjs`);
const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{id: 'bg', type: 'background', paint: {'background-color': '#0b1622'}}],
};

function hideBoot() {
  document.querySelector('#boot')?.classList.add('hidden');
}

const WINDOW_MS = 48 * 3600_000;

interface State {
  stations: Station[];
  station: Station | null;
  time: number;
  playing: boolean;
  speed: number; // simulated minutes per real second
  live: boolean;
  livePoints: TidePoint[];
  extrema: TidePoint[];
  exaggeration: number;
  bias: number;
  opacity: number;
  islandMode: boolean;
  islandElevation: number;
  styleSource: 'loading' | 'openfreemap' | 'osm' | 'background';
  demError: boolean;
  demVisible: boolean;
  placeMarker: {remove(): unknown} | null;
}

const state: State = {
  stations: [],
  station: null,
  time: Date.now(),
  playing: false,
  speed: 120,
  live: false,
  livePoints: [],
  extrema: [],
  exaggeration: 4,
  bias: 0,
  opacity: 1,
  islandMode: false,
  islandElevation: 5,
  styleSource: 'loading',
  demError: false,
  demVisible: true,
  placeMarker: null,
};

let map: maplibregl.Map | undefined;
let rasterMap: RasterMap | undefined;
let rasterMarker: typeof import('leaflet').marker | undefined;
let demLayer: TideDemLayer | undefined;
let islands: IslandManager | undefined;
let chart: TideChart;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function currentLevel(): number {
  if (!state.station) return 0;
  return tideAt(state.station, state.time);
}

function interpLevel(points: TidePoint[], t: number): number | null {
  if (points.length < 2) return null;
  if (t < points[0].t || t > points[points.length - 1].t) return null;
  for (let i = 1; i < points.length; i++) {
    if (points[i].t >= t) {
      const f = (t - points[i - 1].t) / (points[i].t - points[i - 1].t || 1);
      return points[i - 1].v + f * (points[i].v - points[i - 1].v);
    }
  }
  return null;
}

/** level used for the map: live official data when available, model otherwise */
function effectiveLevel(): number {
  const live = interpLevel(state.livePoints, state.time);
  if (live !== null) return live;
  return currentLevel();
}

/* ------------------------------------------------------------------ */
/* map                                                                 */
/* ------------------------------------------------------------------ */

function tryBasemap(target: maplibregl.Map, style: string | maplibregl.StyleSpecification): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (loaded: boolean) => {
      clearTimeout(timer);
      target.off('sourcedata', onTile);
      target.off('idle', onIdle);
      resolve(loaded);
    };
    const onTile = (event: maplibregl.MapSourceDataEvent) => {
      if (event.tile?.state === 'loaded') finish(true);
    };
    const onIdle = () => finish(false);
    const timer = setTimeout(onIdle, 8000);
    target.on('sourcedata', onTile);
    target.on('idle', onIdle);
    try {
      target.setStyle(style, {diff: false});
    } catch (error) {
      console.warn('[style]', error);
      finish(false);
    }
  });
}

async function initRasterMap() {
  const [leaflet] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
  rasterMarker = leaflet.marker;
  rasterMap = leaflet.map('map', {zoomControl: false})
    .setView([DEFAULT_CENTER[1], DEFAULT_CENTER[0]], 7);
  leaflet.control.zoom({position: 'bottomright'}).addTo(rasterMap);
  const tiles = leaflet.tileLayer(OSM_TILES, {attribution: OSM_ATTRIBUTION, maxZoom: OSM_MAX_ZOOM});
  state.styleSource = 'loading';
  const reportUnavailable = () => {
    if (state.styleSource !== 'loading') return;
    state.styleSource = 'background';
    renderMapStatus();
  };
  const timer = setTimeout(reportUnavailable, 8000);
  tiles.on('tileload', () => {
    if (state.styleSource === 'osm') return;
    clearTimeout(timer);
    state.styleSource = 'osm';
    renderMapStatus();
  });
  tiles.on('load', () => {
    clearTimeout(timer);
    reportUnavailable();
  });
  tiles.addTo(rasterMap);
  rasterMap.on('moveend', refreshStationList);
}

async function initMap() {
  let target: maplibregl.Map;
  try {
    target = new maplibregl.Map({
      container: 'map',
      center: DEFAULT_CENTER,
      zoom: 7,
      maxPitch: 60,
      attributionControl: false,
      canvasContextAttributes: {preserveDrawingBuffer: true, antialias: true},
    });
  } catch (error) {
    console.warn('[map] WebGL initialization failed', error);
    state.styleSource = 'background';
    await initRasterMap();
    return;
  }
  map = target;
  demLayer = new TideDemLayer({});

  map.addControl(
    new maplibregl.NavigationControl({showCompass: true, visualizePitch: true}),
    'bottom-right',
  );
  map.addControl(new maplibregl.FullscreenControl(), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({maxWidth: 120, unit: 'metric'}), 'bottom-right');
  map.addControl(
    new maplibregl.AttributionControl({
      customAttribution:
        'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> · ' +
        'Tide: <a href="https://tidesandcurrents.noaa.gov/">NOAA CO-OPS</a>',
    }),
    'bottom-right',
  );

  map.on('error', (e) => {
    // أخطاء البلاطات لا تُفشل الخريطة كلها
    console.warn('[map]', (e as any)?.error?.message ?? e);
  });

  if (await tryBasemap(map, STYLE_URL)) {
    state.styleSource = 'openfreemap';
  } else if (await tryBasemap(map, RASTER_STYLE)) {
    state.styleSource = 'osm';
  } else {
    state.styleSource = 'background';
    const ready = map.once('style.load');
    map.setStyle(FALLBACK_STYLE, {diff: false});
    await ready;
  }

  try {
    map.addLayer(demLayer, firstSymbolLayerId());
  } catch (e) {
    console.error('[dem]', e);
    state.demError = true;
  }
  const islandManager = new IslandManager(map);
  islands = islandManager;

  map.on('click', (e) => {
    if (!state.islandMode) return;
    islandManager.add(e.lngLat.lng, e.lngLat.lat, state.islandElevation, 6);
    islandManager.updateTide(effectiveLevel());
    render();
  });
  map.on('moveend', () => {
    refreshStationList();
  });
}

function firstSymbolLayerId(): string | undefined {
  for (const l of safeLayers()) {
    if (l.type === 'symbol') return l.id;
  }
  return undefined;
}

/**
 * MapLibre's getStyle() throws while the style is still loading
 * ("Style is not done loading.") — which used to crash the whole app.
 * This wrapper never throws.
 */
function safeLayers(): maplibregl.LayerSpecification[] {
  try {
    return map?.getStyle()?.layers ?? [];
  } catch {
    return [];
  }
}

function moveTo(lng: number, lat: number, zoom: number, duration = 0) {
  map?.flyTo({center: [lng, lat], zoom, duration, essential: false});
  rasterMap?.setView([lat, lng], zoom, {animate: duration > 0});
}

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */

async function loadData() {
  const file = await loadStations('data/stations.json');
  state.stations = file.stations;
  const params = new URLSearchParams(location.search);
  const wanted = params.get('station');
  if (wanted) {
    state.station = state.stations.find((s) => s.id === wanted) ?? null;
  }
  if (!state.station) {
    // start at the station with the largest tidal range that is easy to see
    state.station =
      state.stations.find((s) => s.id === '9414290') ??
      [...state.stations].sort((a, b) => (b.meanRange ?? 0) - (a.meanRange ?? 0))[0];
  }
  if (state.station) moveTo(state.station.lng, state.station.lat, 8);
  updateChart();
  render();
  refreshStationList();
  void refreshTideData().then(render);
}

async function refreshTideData() {
  if (!state.station) return;
  const from = new Date(state.time - WINDOW_MS);
  const to = new Date(state.time + WINDOW_MS);
  const res = await fetchNoaaPredictions(state.station.id, from, to);
  if (res.ok && res.points.length > 3) {
    state.live = true;
    state.livePoints = res.points;
    // NOAA's high/low product is not offered for every station — derive the
    // turning points from the official hourly series instead.
    const hl = await fetchNoaaHighLow(state.station.id, from, to);
    state.extrema = hl.length ? hl : findExtrema(res.points);
  } else {
    state.live = false;
    state.livePoints = [];
    state.extrema = findExtrema(sampleCurve(state.station, from.getTime(), to.getTime(), 6));
  }
  updateChart();
}

function updateChart() {
  if (!state.station) return;
  const from = state.time - WINDOW_MS;
  const to = state.time + WINDOW_MS;
  const points = state.livePoints.length
    ? state.livePoints.filter((p) => p.t >= from && p.t <= to)
    : sampleCurve(state.station, from, to, 30);
  chart.setData(points);
  chart.setCursor(state.time);
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  if (!state.station) return;
  try {
    renderInner();
  } catch (e) {
    console.error('[render]', e);
  }
}

function renderInner() {
  const level = effectiveLevel();
  demLayer?.setTide(level, state.exaggeration, state.bias);
  demLayer?.setOpacity(state.opacity);
  islands?.updateTide(level);

  // readouts
  const levelEl = $('#level-value');
  levelEl.textContent = `${fmt(level, 2)} م`;
  const dir = state.live
    ? trendFromLive()
    : trendFromModel();
  $('#trend').textContent = dir > 0 ? t('rising') : dir < 0 ? t('falling') : '—';
  $('#trend').className = 'trend ' + (dir > 0 ? 'up' : dir < 0 ? 'down' : '');

  const max = Math.max(...state.livePoints.map((p) => p.v), 0);
  const min = Math.min(...state.livePoints.map((p) => p.v), 0);
  const range = state.live && state.livePoints.length ? max - min : (state.station.meanRange ?? 0);
  $('#range-value').textContent = `${fmt(range, 2)} م`;

  const acc = state.station.accuracy;
  $('#accuracy-value').textContent = acc ? `±${fmt(acc.maxCm / 100, 2)} م` : '—';

  // next high / low
  const nextH = state.extrema.find((e) => e.type === 'H' && e.t >= state.time);
  const nextL = state.extrema.find((e) => e.type === 'L' && e.t >= state.time);
  const levelOf = (e: TidePoint | undefined) =>
    e ? `${fmtTime(e.t)} (${fmt(state.station ? tideAt(state.station, e.t) : e.v, 2)} م)` : '—';
  $('#next-high').textContent = levelOf(nextH);
  $('#next-low').textContent = levelOf(nextL);

  renderMapStatus();

  // source badge
  const badge = $('#source-badge');
  badge.textContent = state.live ? t('liveNoaa') : t('offlineModel');
  badge.className = 'badge ' + (state.live ? 'live' : 'offline');

  // time
  $('#time-label').textContent = fmtTime(state.time);
  ($('#time-slider') as HTMLInputElement).value = String(state.time);
  $('#timeline-window').textContent =
    `${fmtTime(state.time - WINDOW_MS, false)} ← ${fmtTime(state.time + WINDOW_MS, false)}`;

  chart.setCursor(state.time);
}

function trendFromLive(): number {
  const a = interpLevel(state.livePoints, state.time);
  const b = interpLevel(state.livePoints, state.time + 3600_000);
  if (a === null || b === null) return 0;
  return b - a;
}

function trendFromModel(): number {
  if (!state.station) return 0;
  return tideAt(state.station, state.time + 3600_000) - tideAt(state.station, state.time);
}

function renderMapStatus() {
  const basemapMissing = state.styleSource === 'background';
  const styleName = {
    openfreemap: 'OpenFreeMap',
    osm: 'OpenStreetMap',
    background: t('basemapUnavailable'),
    loading: t('loading'),
  }[state.styleSource];
  const dem = demLayer?.stats;
  const demFailed = state.demError || (dem?.failed ?? 0) > 2;
  const terrain = !map
    ? t('terrainNeedsWebgl')
    : demFailed
      ? 'DEM ✕'
      : dem?.loaded
        ? `DEM ✓ (${dem.loaded})`
        : 'DEM …';
  const status = $('#map-status');
  status.textContent = `${styleName} · ${terrain}`;
  status.classList.toggle('bad', basemapMissing || demFailed);
  $('#map-retry').hidden = !basemapMissing;
}

function refreshStationList() {
  const list = $('#station-list');
  if (!list) return;
  const query = ($('#station-search') as HTMLInputElement).value.trim().toLowerCase();
  const center = map?.getCenter() ?? rasterMap?.getCenter() ?? state.station ??
    {lng: DEFAULT_CENTER[0], lat: DEFAULT_CENTER[1]};
  const near = new Set(nearestStations(state.stations, center.lat, center.lng, 8).map((s) => s.id));
  const filtered = state.stations
    .filter((s) => !query || s.name.toLowerCase().includes(query) || s.id.includes(query))
    .sort((a, b) => {
      const an = near.has(a.id) ? 0 : 1;
      const bn = near.has(b.id) ? 0 : 1;
      if (an !== bn) return an - bn;
      return (b.meanRange ?? 0) - (a.meanRange ?? 0);
    })
    .slice(0, 60);
  list.innerHTML = '';
  for (const s of filtered) {
    const li = document.createElement('button');
    li.className = 'station' + (state.station?.id === s.id ? ' active' : '');
    li.innerHTML = `<span class="st-name">${s.name}</span><span class="st-meta">${
      s.state ?? ''
    } · ${fmt(s.meanRange ?? 0, 1)} م</span>`;
    li.onclick = () => void selectStation(s);
    list.appendChild(li);
  }
}

async function selectStation(s: Station) {
  state.station = s;
  moveTo(s.lng, s.lat, 9, 1400);
  await refreshTideData();
  render();
  refreshStationList();
}

/** إظهار/إخفاء طبقة المدّ — يتيح رؤية الخريطة الأساسية بشكل خرائط Google */
function toggleDemLayer() {
  if (!map || !demLayer) return;
  state.demVisible = !state.demVisible;
  try {
    if (state.demVisible && !map.getLayer('tide-dem')) {
      map.addLayer(demLayer, firstSymbolLayerId());
    }
    map.setLayoutProperty('tide-dem', 'visibility', state.demVisible ? 'visible' : 'none');
  } catch (e) {
    console.warn('[dem] تعذّر التبديل', e);
  }
  const btn = $('#btn-dem');
  btn.classList.toggle('active', state.demVisible);
  btn.textContent = state.demVisible ? t('demOn') : t('demOff');
  document.body.classList.toggle('dem-off', !state.demVisible);
}

/* ------------------------------------------------------------------ */
/* search (like Google Maps)                                            */
/* ------------------------------------------------------------------ */

function bindSearch() {
  const input = $<HTMLInputElement>('#search-input');
  const box = $('#search-results');
  let timer: number | undefined;

  const close = () => {
    box.classList.remove('open');
  };

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      box.innerHTML = '';
      close();
      return;
    }
    timer = window.setTimeout(async () => {
      const ql = q.toLowerCase();
      const local: any[] = state.stations
        .filter((st) => st.name.toLowerCase().includes(ql))
        .slice(0, 4)
        .map((st) => ({
          name: st.name + (st.state ? ' — ' + st.state : ''),
          sub: t('stations') + ' · ' + (st.meanRange ?? 0).toFixed(1) + ' م',
          lat: st.lat,
          lng: st.lng,
          kind: 'station',
          station: st,
        }));
      const places = q.length >= 3 ? await geocode(q, getLang()) : [];
      const items = [
        ...local,
        ...places.map((p) => ({
          name: p.name.split(',').slice(0, 2).join(','),
          sub: p.name,
          lat: p.lat,
          lng: p.lng,
          kind: 'place',
        })),
      ];
      if (!items.length) {
        box.innerHTML = `<div class="sr-empty">${t('noStations')}</div>`;
        box.classList.add('open');
        return;
      }
      box.innerHTML = '';
      for (const it of items) {
        const el = document.createElement('button');
        el.className = 'sr-item';
        el.innerHTML = `<span class="sr-name">${it.name}</span><span class="sr-sub">${it.sub ?? ''}</span>`;
        el.onclick = () => {
          close();
          input.value = it.name;
          if (it.kind === 'station') {
            void selectStation(it.station as Station);
          } else {
            moveTo(it.lng, it.lat, 13, 1600);
            showPlaceMarker(it.lng, it.lat, it.name);
          }
        };
        box.appendChild(el);
      }
      box.classList.add('open');
    }, 320);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.blur();
      close();
    }
    if (e.key === 'Enter') {
      (box.querySelector('.sr-item') as HTMLButtonElement | null)?.click();
    }
  });
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement)?.closest?.('#search')) close();
  });
}

function showPlaceMarker(lng: number, lat: number, name: string) {
  state.placeMarker?.remove();
  const el = document.createElement('div');
  el.className = 'place-marker';
  el.innerHTML = '<span class="pm-dot"></span><span class="pm-label"></span>';
  (el.querySelector('.pm-label') as HTMLElement).textContent = name.split(',')[0];
  if (map) {
    state.placeMarker = new maplibregl.Marker({element: el}).setLngLat([lng, lat]).addTo(map);
  } else if (rasterMap && rasterMarker) {
    state.placeMarker = rasterMarker([lat, lng], {title: name, alt: name}).addTo(rasterMap);
  }
}

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

function bindControls() {
  const slider = $<HTMLInputElement>('#time-slider');
  slider.min = String(Date.now() - 30 * 24 * 3600_000);
  slider.max = String(Date.now() + 30 * 24 * 3600_000);
  slider.step = '60000';
  slider.value = String(state.time);
  slider.addEventListener('input', () => {
    state.time = Number(slider.value);
    state.playing = false;
    updatePlayButton();
    render();
  });

  $('#btn-jump-high').onclick = () => {
    const e = state.extrema.find((x) => x.type === 'H' && x.t >= state.time);
    if (e) {
      state.time = e.t;
      render();
    }
  };
  $('#btn-jump-low').onclick = () => {
    const e = state.extrema.find((x) => x.type === 'L' && x.t >= state.time);
    if (e) {
      state.time = e.t;
      render();
    }
  };
  $('#btn-now').onclick = () => {
    state.time = Date.now();
    render();
    void refreshTideData();
  };
  $('#btn-play').onclick = () => {
    state.playing = !state.playing;
    updatePlayButton();
  };
  $('#btn-export').onclick = () => {
    const target = map;
    target?.once('idle', () => {
      const canvas = target.getCanvas();
      const a = document.createElement('a');
      a.download = `tide-atlas-${new Date(state.time).toISOString().slice(0, 16)}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    });
  };
  const speed = $<HTMLInputElement>('#speed');
  speed.addEventListener('input', () => {
    state.speed = Number(speed.value);
    $('#speed-value').textContent = `${speed.value}×`;
  });

  const exag = $<HTMLInputElement>('#exaggeration');
  exag.addEventListener('input', () => {
    state.exaggeration = Number(exag.value);
    $('#exaggeration-value').textContent = `${exag.value}×`;
    render();
  });
  const bias = $<HTMLInputElement>('#bias');
  bias.addEventListener('input', () => {
    state.bias = Number(bias.value);
    $('#bias-value').textContent = `${fmt(Number(bias.value), 2)} م`;
    render();
  });
  const opacity = $<HTMLInputElement>('#opacity');
  opacity.addEventListener('input', () => {
    state.opacity = Number(opacity.value);
    render();
  });

  $('#btn-island').onclick = () => {
    if (!map) return;
    state.islandMode = !state.islandMode;
    $('#btn-island').classList.toggle('active', state.islandMode);
    map.getCanvas().style.cursor = state.islandMode ? 'crosshair' : '';
    $('#island-hint').style.display = state.islandMode ? 'block' : 'none';
  };
  const islElev = $<HTMLInputElement>('#island-elevation');
  islElev.addEventListener('input', () => {
    state.islandElevation = Number(islElev.value);
    $('#island-elevation-value').textContent = `${islElev.value} م`;
  });
  $('#btn-clear-islands').onclick = () => {
    islands?.clear();
  };

  ($('#station-search') as HTMLInputElement).addEventListener('input', refreshStationList);
  bindSearch();

  $('#btn-dem').onclick = () => toggleDemLayer();
  $('#map-retry').onclick = () => location.reload();
  $('#btn-lang').onclick = () => {
    setLang(getLang() === 'ar' ? 'en' : 'ar');
    applyStrings();
    render();
    renderMapStatus();
    refreshStationList();
  };
  $('#btn-about').onclick = () => {
    $('#about-modal').classList.toggle('open');
  };
  $('#about-close').onclick = () => $('#about-modal').classList.remove('open');
}

function updatePlayButton() {
  const b = $('#btn-play');
  b.textContent = state.playing ? t('pause') : t('play');
  b.classList.toggle('active', state.playing);
}

function applyStrings() {
  document.title = t('title');
  for (const el of Array.from(document.querySelectorAll('[data-i18n]'))) {
    el.textContent = t(el.getAttribute('data-i18n')!);
  }
  $('#btn-lang').textContent = t('langLabel');
  const dem = $('#btn-dem');
  if (dem) dem.textContent = state.demVisible ? t('demOn') : t('demOff');
  updatePlayButton();
}

/* ------------------------------------------------------------------ */
/* main loop                                                           */
/* ------------------------------------------------------------------ */

function tick() {
  if (state.playing) {
    state.time += state.speed * 60_000 * 0.016; // ~1 frame per 16 ms
    if (Math.abs(state.time - Date.now()) > 30 * 24 * 3600_000) state.time = Date.now();
    render();
  }
  requestAnimationFrame(tick);
}

async function main() {
  window.addEventListener('error', (e) => console.error('[window]', e.message));
  window.addEventListener('unhandledrejection', (e) => console.error('[rejection]', String(e.reason)));
  setLang('ar');
  chart = new TideChart($<HTMLCanvasElement>('#chart'), {
    color: '#4fc3f7',
    accent: '#ff6b6b',
    grid: 'rgba(255,255,255,0.09)',
    text: '#9fb4c8',
  });
  applyStrings();
  bindControls();
  try {
    await initMap();
  } catch (e) {
    console.error('[map]', e);
    state.styleSource = 'background';
  }
  for (const selector of ['#btn-dem', '#exaggeration', '#bias', '#opacity']) {
    $<HTMLButtonElement | HTMLInputElement>(selector).disabled = !map || state.demError;
  }
  for (const selector of ['#btn-island', '#btn-clear-islands', '#island-elevation']) {
    $<HTMLButtonElement | HTMLInputElement>(selector).disabled = !islands;
  }
  $<HTMLButtonElement>('#btn-export').disabled = !map;
  renderMapStatus();
  hideBoot();
  try {
    await loadData();
  } catch (e) {
    console.error('[loadData]', e);
    $('#station-list').innerHTML = `<div class="error">${t('error')}: ${String(e)}</div>`;
  }
  tick();
}

(window as any).__tide = {state, render, refreshTideData, effectiveLevel, get map() { return map; }, get dem() { return demLayer; }};

void main();
