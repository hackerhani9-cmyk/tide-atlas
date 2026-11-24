import * as maplibregl from 'maplibre-gl';
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
// بديل يعمل إن تعذّر تحميل النمط المتجهي (بلا مفتاح API)
const RASTER_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: ['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [{id: 'carto', type: 'raster', source: 'carto'}],
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

function bootMessage(title: string, msg: string) {
  const t = document.querySelector('#boot-title');
  const m = document.querySelector('#boot-msg');
  if (t) t.textContent = title;
  if (m) m.textContent = msg;
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
  styleSource: string;
  demError: boolean;
  demVisible: boolean;
  placeMarker: maplibregl.Marker | null;
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
  styleSource: 'openfreemap',
  demError: false,
  demVisible: true,
  placeMarker: null,
};

let map: maplibregl.Map;
let demLayer: TideDemLayer;
let islands: IslandManager;
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

/** ينتظر جاهزية الخريطة دون أن يُفشل التطبيقَ كلَّه عند بطء الشبكة */
function waitForMap(m: maplibregl.Map, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    m.on('load', () => done(true));
    m.on('idle', () => done(true));
    setTimeout(() => done(false), timeoutMs);
  });
}

/** يجرّب مصادر الخريطة بالترتيب حتى ينجح أحدها */
async function loadStyleWithFallback(): Promise<{style: any; source: string}> {
  const candidates: [string, () => Promise<any>][] = [
    [
      'openfreemap',
      async () => {
        const res = await fetch(STYLE_URL);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      },
    ],
    ['carto', async () => RASTER_STYLE],
    ['background', async () => FALLBACK_STYLE],
  ];
  for (const [name, loader] of candidates) {
    try {
      const style = await loader();
      return {style, source: name};
    } catch (e) {
      console.warn('[style] فشل المصدر', name, e);
    }
  }
  return {style: FALLBACK_STYLE, source: 'background'};
}

async function initMap() {
  demLayer = new TideDemLayer({});
  if (!document.createElement('canvas').getContext('webgl2')) {
    bootMessage(
      'المتصفح لا يدعم WebGL 2',
      'يحتاج التطبيق WebGL 2 لعرض التضاريس. جرّب متصفحاً حديثاً أو فعّل تسريع الرسوميات.',
    );
    throw new Error('WebGL2 unsupported');
  }

  const {style, source} = await loadStyleWithFallback();
  state.styleSource = source;
  (window as any).__styleSource = source;

  map = new maplibregl.Map({
    container: 'map',
    style,
    center: [-122.4, 37.8],
    zoom: 7,
    maxPitch: 60,
    attributionControl: false,
    canvasContextAttributes: {preserveDrawingBuffer: true, antialias: true},
  });
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
        'Tide: <a href="https://tidesandcurrents.noaa.gov/">NOAA CO-OPS</a> · ' +
        'Basemap: <a href="https://openfreemap.org/">OpenFreeMap</a>',
    }),
    'bottom-right',
  );

  map.on('error', (e) => {
    // أخطاء البلاطات لا تُفشل الخريطة كلها
    console.warn('[map]', (e as any)?.error?.message ?? e);
  });

  await waitForMap(map, 15000);

  // إن لم يُحمَّل النمط المتجهي (شبكة محجوبة/بطيئة) ننتقل إلى النمط النقطي
  if (!safeLayers().length) {
    console.warn('[style] تعذّر تحميل النمط — التحويل إلى CARTO');
    state.styleSource = 'carto';
    try {
      map.setStyle(RASTER_STYLE);
      await waitForMap(map, 12000);
    } catch (e) {
      console.warn('[style] فشل النمط النقطي أيضاً', e);
    }
  }

  hideBoot();

  try {
    map.addLayer(demLayer, firstSymbolLayerId());
  } catch (e) {
    console.error('[dem]', e);
    state.demError = true;
  }
  map.on('styledata', () => {
    // بعد تبديل النمط (fallback) نعيد إدراج طبقة المدّ
    if (!map.getLayer('tide-dem') && !state.demError) {
      try {
        map.addLayer(demLayer, firstSymbolLayerId());
      } catch (e) {
        console.warn('[dem] تعذّرت الإعادة', e);
      }
    }
  });

  islands = new IslandManager(map);
  chart = new TideChart($<HTMLCanvasElement>('#chart'), {
    color: '#4fc3f7',
    accent: '#ff6b6b',
    grid: 'rgba(255,255,255,0.09)',
    text: '#9fb4c8',
  });

  map.on('click', (e) => {
    if (!state.islandMode) return;
    islands.add(e.lngLat.lng, e.lngLat.lat, state.islandElevation, 6);
    islands.updateTide(effectiveLevel());
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
    return (map.getStyle()?.layers ?? []) as maplibregl.LayerSpecification[];
  } catch {
    return [];
  }
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
  if (state.station) {
    map.setCenter([state.station.lng, state.station.lat]);
    map.setZoom(8);
  }
  await refreshTideData();
  render();
  refreshStationList();
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
  demLayer.setTide(level, state.exaggeration, state.bias);
  demLayer.setOpacity(state.opacity);
  islands.updateTide(level);

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

  // حالة الخريطة: مصدر الأساس + طبقة الارتفاع
  const styleName =
    state.styleSource === 'openfreemap'
      ? 'OpenFreeMap'
      : state.styleSource === 'carto'
        ? 'CARTO'
        : '—';
  const dem = demLayer?.stats;
  const demText = state.demError
    ? 'DEM ✕'
    : dem && dem.failed > 2
      ? `DEM ✕ (${dem.failed})`
      : dem && dem.loaded > 0
        ? `DEM ✓ (${dem.loaded})`
        : 'DEM …';
  const statusEl = $('#map-status');
  if (statusEl) {
    statusEl.textContent = `${styleName} · ${demText}`;
    statusEl.className = state.demError || (dem && dem.failed > 2) ? 'bad' : '';
  }

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

function refreshStationList() {
  const list = $('#station-list');
  if (!list) return;
  const query = ($('#station-search') as HTMLInputElement).value.trim().toLowerCase();
  const center = map.getCenter();
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
  map.flyTo({center: [s.lng, s.lat], zoom: 9, duration: 1400, essential: false});
  await refreshTideData();
  render();
  refreshStationList();
}

/** إظهار/إخفاء طبقة المدّ — يتيح رؤية الخريطة الأساسية بشكل خرائط Google */
function toggleDemLayer() {
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
            map.flyTo({center: [it.lng, it.lat], zoom: 13, duration: 1600, essential: false});
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
  state.placeMarker = new maplibregl.Marker({element: el}).setLngLat([lng, lat]).addTo(map);
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
    map.once('idle', () => {
      const canvas = map.getCanvas();
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
    islands.clear();
  };

  ($('#station-search') as HTMLInputElement).addEventListener('input', refreshStationList);
  bindSearch();

  $('#btn-dem').onclick = () => toggleDemLayer();
  $('#btn-lang').onclick = () => {
    setLang(getLang() === 'ar' ? 'en' : 'ar');
    applyStrings();
    render();
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
  applyStrings();
  bindControls();
  try {
    await initMap();
  } catch (e) {
    console.error('[map]', e);
    bootMessage(
      'تعذّر رسم الخريطة',
      'جرّب كل مصادر الخريطة المتاحة ولم ينجح أيّها. تحقّق من الاتصال بالإنترنت أو اضغط «إعادة المحاولة».',
    );
    const retry = document.querySelector('#boot-retry') as HTMLButtonElement | null;
    if (retry) {
      retry.style.display = 'inline-block';
      retry.onclick = () => location.reload();
    }
    // الواجهة (المحطات والمنحنى) تبقى تعمل بلا خريطة
  }
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
