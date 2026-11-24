#!/usr/bin/env python3
"""
build_fitted.py — يبني ثوابت الـharmonic لكل محطة من تنبؤات NOAA الرسمية.

الخطوات:
  1. تنزيل تنبؤات NOAA الرسمية (ساعية) لكل محطة في الفترة 2024-01-01 → 2026-11-22
     (تُخزَّن في data/raw لإعادة الاستخدام).
  2. ملاءقة ثوابت الـharmonic بطريقة أقل المربعات على 2024-2025.
  3. التحقق على 2026 (فترة لم تُستخدم في الملاءقة) وقياس الخطأ الأقصى و RMSE.
  4. كتابة data/fitted.json.

النموذج:  h(T) = offset + Σ aᵢ · cos(ωᵢ·T − gᵢ)     T = ساعات منذ 1900-01-01T00:00Z

الاستخدام:
    python3 tools/build_fitted.py
"""
import concurrent.futures
import datetime
import json
import math
import os
import pathlib
import time
import urllib.request

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
CACHE = DATA / 'raw'
OUT = DATA / 'fitted.json'
META = DATA / 'stations.json'

EPOCH = datetime.datetime(1900, 1, 1, tzinfo=datetime.timezone.utc)
DATES = [('20240101', '20241231'), ('20250101', '20251231'), ('20260101', '20261122')]
API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'


def fetch_range(sid: str, d1: str, d2: str):
    url = (f'{API}?product=predictions&application=TideAtlasBuild'
           f'&begin_date={d1}&end_date={d2}&datum=MSL&station={sid}'
           f'&time_zone=gmt&interval=h&units=metric&format=json')
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return json.load(r).get('predictions', [])
        except Exception:
            time.sleep(3 * (attempt + 1))
    return []


def station_series(sid: str):
    rows = []
    for d1, d2 in DATES:
        cache = CACHE / f'{sid}_{d1}.json'
        if cache.exists() and cache.stat().st_size > 20:
            rows += json.loads(cache.read_text())
        else:
            got = fetch_range(sid, d1, d2)
            cache.write_text(json.dumps(got))
            rows += got
    T, V = [], []
    for p in rows:
        try:
            t = datetime.datetime.strptime(p['t'], '%Y-%m-%d %H:%M').replace(tzinfo=datetime.timezone.utc)
            v = float(p['v'])
        except Exception:
            continue
        T.append((t - EPOCH).total_seconds() / 3600.0)
        V.append(v)
    return np.array(T), np.array(V)


def fit(T, V, names, speeds, ridge=1e-9):
    cols = [np.ones_like(T)]
    for n in names:
        w = math.radians(speeds[n])
        cols.append(np.cos(w * T))
        cols.append(np.sin(w * T))
    A = np.vstack(cols).T
    ATA = A.T @ A
    k = len(names)
    ATA[np.arange(1, 2 * k + 1), np.arange(1, 2 * k + 1)] += ridge * len(T)
    coef = np.linalg.solve(ATA, A.T @ V)
    out = []
    for i, name in enumerate(names):
        a, b = coef[1 + 2 * i], coef[2 + 2 * i]
        amp = math.hypot(a, b)
        # h = a·cos(ωT) + b·sin(ωT) = amp·cos(ωT − g)  ⇒  g = atan2(b, a)
        g = math.degrees(math.atan2(b, a)) % 360
        out.append({'n': name, 'a': round(amp, 5), 'g': round(g, 4), 'w': speeds[name]})
    return float(coef[0]), out


def evaluate(const, offset, T):
    s = np.full(len(T), offset)
    for c in const:
        s += c['a'] * np.cos(np.radians(c['w'] * T - c['g']))
    return s


def process(sid: str):
    try:
        st = META[sid]
        T, V = station_series(sid)
        if len(T) < 4000:
            return sid, 'short', len(T)
        speeds = {c['n']: c['w'] for c in st['h']}
        names = [c['n'] for c in st['h'] if c['n'] != 'S1']
        cut = (datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc) - EPOCH).total_seconds() / 3600.0
        tr, va = T < cut, T >= cut
        offset, const = fit(T[tr], V[tr], names, speeds)
        ev = evaluate(const, offset, T[va]) - V[va]
        pub = evaluate(st['h'], 0.0, T[va]) - V[va]
        rec = {
            'id': sid, 'name': st['name'], 'lat': st['lat'], 'lng': st['lng'], 'state': st.get('state'),
            'meanRange': st.get('meanRange'), 'offset': round(offset, 4),
            'const': [c for c in const if c['a'] >= 0.003], 'published': st['h'],
            'val': {
                'fit_max_cm': round(float(np.abs(ev).max() * 100), 1),
                'fit_rmse_cm': round(float(np.sqrt((ev ** 2).mean()) * 100), 1),
                'pub_max_cm': round(float(np.abs(pub).max() * 100), 1),
                'pub_rmse_cm': round(float(np.sqrt((pub ** 2).mean()) * 100), 1),
                'n_val': int(va.sum()), 'n_train': int(tr.sum()),
            },
        }
        return sid, 'ok', rec
    except Exception as e:
        return sid, 'err', str(e)


def main() -> int:
    os.makedirs(CACHE, exist_ok=True)
    meta = {s['id']: s for s in json.loads(META.read_text())}
    ids = [i for i in json.loads((DATA / 'noaa_pick.json').read_text()) if i in meta]
    print(f'معالجة {len(ids)} محطة…', flush=True)
    out = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        for sid, status, rec in ex.map(process, ids):
            print(sid, status, flush=True)
            if status == 'ok':
                out[sid] = rec
    OUT.write_text(json.dumps(out, ensure_ascii=False))
    errs = sorted(v['val']['fit_max_cm'] for v in out.values())
    if errs:
        print(f'تم: {len(out)} محطة · وسيط الخطأ الأقصى {errs[len(errs)//2]} سم · أسوأ {errs[-1]} سم')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
