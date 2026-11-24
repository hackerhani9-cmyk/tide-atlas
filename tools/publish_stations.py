#!/usr/bin/env python3
"""
publish_stations.py — ينشر بيانات المحطات جاهزةً للتطبيق.

يقرأ  fitted.json  (ناتج build_fitted.py) ويحوّله إلى
app/public/data/stations.json  بالشكل الذي يتوقعه التطبيق:

{
  "generated": "YYYY-MM-DD",
  "source": "…",
  "stations": [ { id, name, lat, lng, state, meanRange, offset, const[], published[], accuracy{} } ]
}

الاستخدام:
    python3 tools/publish_stations.py
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FITTED = ROOT / 'data' / 'fitted.json'
OUT = ROOT / 'app' / 'public' / 'data' / 'stations.json'

# المكوّنات التي تحدّد مدى المدّ (مدى بين مدّ عالي ومنخفض)
RANGE_CONSTITUENTS = {'M2', 'S2', 'N2', 'K2', 'K1', 'O1', 'P1', 'Q1'}


def main() -> int:
    if not FITTED.exists():
        print(f'لا يوجد {FITTED} — شغّل tools/build_fitted.py أولاً', file=sys.stderr)
        return 1
    fitted = json.loads(FITTED.read_text())
    stations = []
    for sid, v in fitted.items():
        const = v['const']
        mean_range = 2 * sum(c['a'] for c in const if c['n'] in RANGE_CONSTITUENTS)
        stations.append({
            'id': sid,
            'name': v['name'],
            'lat': v['lat'],
            'lng': v['lng'],
            'state': v.get('state'),
            'meanRange': round(mean_range, 2),
            'offset': v.get('offset', 0.0),
            'const': const,
            'published': v.get('published', []),
            'accuracy': {
                'maxCm': v['val']['fit_max_cm'],
                'rmseCm': v['val']['fit_rmse_cm'],
            },
        })
    stations.sort(key=lambda s: -(s.get('meanRange') or 0))
    payload = {
        'generated': '2026-11-23',
        'source': (
            'Harmonic constants derived by least-squares fit of official NOAA CO-OPS '
            'tide predictions (2024-2026). The app uses live NOAA predictions when online.'
        ),
        'stations': stations,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
    errs = [s['accuracy']['maxCm'] for s in stations]
    print(f'كُتب {len(stations)} محطة إلى {OUT}')
    print(f'دقة النموذج: وسيط {sorted(errs)[len(errs)//2]} سم، أسوأ {max(errs)} سم')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
