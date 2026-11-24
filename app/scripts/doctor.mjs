/**
 * doctor.mjs — تشخيص سريع: أيّ المصادر الخارجية يحجبها جدارك الناري؟
 *
 *   npm run doctor
 */
const targets = [
  ['نمط الخريطة (OpenFreeMap)', 'https://tiles.openfreemap.org/styles/positron'],
  ['بلاطات الخريطة', 'https://tiles.openfreemap.org/planet/8/39/99.pbf'],
  ['تسميات الخطوط', 'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf'],
  ['خريطة بديلة (OpenStreetMap)', 'https://tile.openstreetmap.org/8/40/98.png'],
  ['الارتفاع (AWS Terrain Tiles)', 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/8/107/201.png'],
  ['بيانات المد (NOAA)', 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=Doctor&begin_date=20260601&end_date=20260601&datum=MSL&station=9414290&time_zone=gmt&interval=h&units=metric&format=json'],
];

let blocked = 0;
console.log('\nفحص المصادر…\n');
for (const [name, url] of targets) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {Origin: 'http://localhost', 'User-Agent': 'TideAtlas-Doctor/1.0'},
    });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (res.ok) {
      console.log(`  ✅  ${name.padEnd(28)} ${res.status} — ${ms}ms`);
    } else {
      blocked++;
      console.log(`  ⚠️   ${name.padEnd(28)} HTTP ${res.status}`);
    }
  } catch (e) {
    blocked++;
    console.log(`  ❌  ${name.padEnd(28)} ${String(e.message).slice(0, 60)}`);
  }
}

console.log('');
if (blocked === 0) {
  console.log('كل المصادر متاحة — شغّل التطبيق: npm run dev\n');
  process.exit(0);
}
console.log(`${blocked} مصدر غير متاح. إن كان أحدها «الارتفاع» أو «بلاطات الخريطة» فالمشكلة شبكة-side:`);
console.log('جرّب متصفحاً آخر، أو شبكة أخرى، أو أزلِ الحجب من الجدار الناري/الوكيل.\n');
process.exit(1);
