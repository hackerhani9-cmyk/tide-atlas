#!/usr/bin/env python3
"""
fetch_harcon.py — تنزيل ثوابت الـharmonic الرسمية من NOAA لكل المحطات المختارة.

يستعمل واجهة MDAPI:
    https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{id}/harcon.json?units=metric

ويخزّن النتيجة في data/harcon/{id}.json ثم يبني data/stations.json (بيانات وصفية
+ الثوابت المنشورة كما هي من NOAA).

الاستخدام:
    python3 tools/fetch_harcon.py
"""
import concurrent.futures
import json
import pathlib
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
HARCON = DATA / 'harcon'
STATIONS = DATA / 'stations.json'

# قائمة المحطات المختارة: تغطي سواحل在美国 والمحيط الهادئ والبحر الكاريبي
# ووسط أمريكا الجنوبية، وتضمّ جزراً مثل هونولولو وهاواي وجوام.
PICK = """
San Francisco|Los Angeles|Long Beach|Honolulu|Sand Point|Ketchikan|Juneau|Sitka|Hilo|Kahului|
Midway|Guam|San Juan|Aguadilla|Vieques|Cape May|Atlantic City|Nantucket|Boston|Providence|
New London|Bridgeport|Coney Island|Charleston|Cape Fear|Wilmington|Morehead City|Savannah|
Daytona|Cedar Key|Key West|Miami|Port Canaveral|Cape Canaveral|Sand Key|Pensacola|
Panama City|Corpus Christi|Port Aransas|Galveston|Freeport|Brownsville|Cedros|Ensenada|
La Paz|Santa Rosalia|Mazatlan|Progreso|Coatzacoalcos|Tampico|Guayaquil|Callao|Valparaiso|
San Antonio|Valdivia|Talcahuano|Antofagasta|Iquique|Arica|Easter Island|Pitcairn|Christmas|
Kiritimati|Tarawa|Apia|Fiji|Nadi|Suva|Townsville|Cairns|Brisbane|Bondi|Sydney|Eucla|Adelaide|
Port Lincoln|Hobart|Melbourne|Launceston|Campbell|Lyttelton|Wellington|Auckland|Whangarei|
Napier|Tauranga|Bluff|Invercargill|Stewart|Majuro|Kwajalein|Enewetak|Wake|Johnston|Palau|Yap|
Koror|Djakarta|Yokohama|Manila
"""

KEEP = {
    'M2', 'S2', 'N2', 'K2', 'K1', 'O1', 'P1', 'Q1', 'Mf', 'Mm', 'Ssa', 'SSA', 'M4', 'MS4', 'M6',
    'MU2', 'NU2', '2Q1', '2N2', 'LAM2', 'RHO', 'MK3', '2MK3', 'T2', 'R2', 'L2', 'M3', 'M1', 'J1',
    'OO1', 'S1', 'E2',
}


def fetch(sid: str):
    path = HARCON / f'{sid}.json'
    if path.exists() and path.stat().st_size > 50:
        return sid, 'cached'
    url = (f'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{sid}'
           f'/harcon.json?units=metric')
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            if len(data) < 50:
                return sid, 'empty'
            path.write_bytes(data)
            return sid, 'ok'
        except Exception:
            time.sleep(2 * (attempt + 1))
    return sid, 'error'


def main() -> int:
    HARCON.mkdir(parents=True, exist_ok=True)
    meta_path = DATA / 'noaa_stations_raw.json'
    if not meta_path.exists():
        url = ('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json'
               '?type=tidepredictions')
        with urllib.request.urlopen(url, timeout=120) as r:
            meta_path.write_bytes(r.read())
    all_stations = json.loads(meta_path.read_text())['stations']
    by_id = {s['id']: s for s in all_stations}

    import re
    pattern = re.compile(PICK.replace('\n', ''), re.I)
    ids, seen = [], set()
    for s in all_stations:
        if pattern.search(s['name']) and s['id'] not in seen:
            seen.add(s['id'])
            ids.append(s['id'])
    (DATA / 'noaa_pick.json').write_text(json.dumps(sorted(ids)))
    print(f'محطات مختارة: {len(ids)}')

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        for sid, status in ex.map(fetch, ids):
            results.append(status)
    print('تنزيل:', {s: results.count(s) for s in set(results)})

    out = []
    for path in sorted(HARCON.glob('*.json')):
        sid = path.stem
        try:
            hc = json.loads(path.read_text())
        except Exception:
            continue
        cons = hc.get('HarmonicConstituents') or []
        if not cons:
            continue
        m = by_id.get(sid, {})
        amps = [c for c in cons if c['name'] in KEEP and abs(c.get('amplitude') or 0) >= 0.005]
        if not amps:
            continue
        out.append({
            'id': sid,
            'name': m.get('name', 'Station ' + sid),
            'state': m.get('state'),
            'lat': m.get('lat'),
            'lng': m.get('lng'),
            'tz': m.get('timezonecorr'),
            'meanRange': round(max((c['amplitude'] for c in cons), default=0) * 2, 2),
            'h': [{'n': c['name'], 'a': round(c['amplitude'], 4), 'g': c['phase_GMT'], 'w': c['speed']}
                  for c in amps],
        })
    out.sort(key=lambda s: -s['meanRange'])
    STATIONS.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(f'كُتب {len(out)} محطة إلى {STATIONS}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
