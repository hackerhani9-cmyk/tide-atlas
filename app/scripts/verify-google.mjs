/**
 * verify-google.mjs — يتحقق من مزايا "خرائط Google":
 *  1) شريط البحث Géocode (محلي + Nominatim)
 *  2) مبدّل طبقة المدّ (إظهار/إخفاء الأرض الرقمية)
 *  3) أدوات التحكّم (بوصلة/ملء الشاشة)
 *  4) تدوير الخريطة بالسحب
 *  5) الخريطة تعمل بعد إصلاح getStyle
 */
import {chromium} from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:4180/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({name, ok});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 160));
});

await page.goto(URL, {waitUntil: 'domcontentloaded', timeout: 60000});
await page
  .waitForFunction(() => document.querySelector('#source-badge')?.textContent?.includes('NOAA'), {timeout: 45000})
  .catch(() => {});
await page.waitForTimeout(7000);

// 1) الخريطة تعمل + لا أخطاء
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
const boot = await page.evaluate(() => document.querySelector('#boot')?.classList.contains('hidden'));
check('boot overlay hidden', boot === true, String(boot));

// 2) شريط البحث
await page.click('#search-input');
await page.fill('#search-input', 'Jeddah');
await page.waitForTimeout(2600);
const results_n = await page.locator('#search-results .sr-item').count();
check('search returns results', results_n > 0, `${results_n} items`);
if (results_n > 0) {
  const before = await page.evaluate(() => {
    const c = window.__tide?.map?.getCenter();
    return c ? [c.lng, c.lat] : null;
  });
  await page.locator('#search-results .sr-item').first().click();
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => {
    const c = window.__tide?.map?.getCenter();
    return c ? [c.lng, c.lat] : null;
  });
  const moved = before && after ? Math.hypot(after[0] - before[0], after[1] - before[1]) : 0;
  check('clicking a result flies the map', moved > 0.5, `Δ=${moved.toFixed(3)}°`);
  await page.screenshot({path: 'shots/google-search.png'});
}

// 3) مبدّل طبقة المدّ
const before = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  const off = document.createElement('canvas');
  off.width = 200;
  off.height = 140;
  const ctx = off.getContext('2d');
  ctx.drawImage(c, 0, 0, 200, 140);
  const d = ctx.getImageData(0, 0, 200, 140).data;
  let blue = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 2] > d[i] + 25 && d[i + 2] > 60) blue++;
  return blue;
});
await page.click('#btn-dem');
await page.waitForTimeout(1500);
const after = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  const off = document.createElement('canvas');
  off.width = 200;
  off.height = 140;
  const ctx = off.getContext('2d');
  ctx.drawImage(c, 0, 0, 200, 140);
  const d = ctx.getImageData(0, 0, 200, 140).data;
  let blue = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 2] > d[i] + 25 && d[i + 2] > 60) blue++;
  return blue;
});
check('tide layer toggle changes the map', Math.abs(after - before) > 500, `water px ${before} -> ${after}`);
await page.screenshot({path: 'shots/google-basemap.png'});
await page.click('#btn-dem');
await page.waitForTimeout(1200);

// 4) أدوات التحكّم
const ctrls = await page.evaluate(() => ({
  zoomIn: !!document.querySelector('.maplibregl-ctrl-zoom-in'),
  zoomOut: !!document.querySelector('.maplibregl-ctrl-zoom-out'),
  compass: !!document.querySelector('.maplibregl-ctrl-compass'),
  fullscreen: !!document.querySelector('.maplibregl-ctrl-fullscreen'),
  scale: !!document.querySelector('.maplibregl-ctrl-scale'),
}));
check(
  'zoom + compass + fullscreen + scale controls',
  ctrls.zoomIn && ctrls.zoomOut && ctrls.compass && ctrls.fullscreen && ctrls.scale,
  JSON.stringify(ctrls),
);

// 5) تدوير الخريطة

await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  const r = c.getBoundingClientRect();
  const opts = (b) => ({
    bubbles: true,
    cancelable: true,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 2,
    buttons: 2,
    pointerId: 1,
    pointerType: 'mouse',
    ...b,
  });
  c.dispatchEvent(new MouseEvent('mousedown', opts()));
  c.dispatchEvent(new MouseEvent('mousemove', opts({clientX: r.left + r.width / 2 + 120})));
  c.dispatchEvent(new MouseEvent('mouseup', opts({clientX: r.left + r.width / 2 + 120})));
});
await page.waitForTimeout(1200);
const rotated = await page.evaluate(() => {
  const m = window.__tide?.map;
  return m ? m.getBearing() : null;
});
check('right-drag rotates the map', rotated !== null && Math.abs(rotated) > 1, `bearing=${rotated}`);

await page.screenshot({path: 'shots/google-final.png'});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
