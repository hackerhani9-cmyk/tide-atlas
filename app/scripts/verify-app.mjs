/**
 * Browser test for the tide atlas: loads the built app, checks that the DEM
 * layer renders, that the tide level actually changes the map, that the chart
 * draws and that the island tool works.
 *
 *   node scripts/verify-app.mjs [url] [outDir]
 */
import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4173/';
const OUT = process.argv[3] ?? 'shots';
mkdirSync(OUT, {recursive: true});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({name, ok, detail});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

page.on('requestfailed', (r) => errors.push('REQFAIL ' + r.url().slice(0, 90)));
await page.goto(URL, {waitUntil: 'domcontentloaded', timeout: 60000});
await page.waitForSelector('#station-list .station', {timeout: 45000}).catch(() => {});
// wait until the live NOAA data has been applied to the read-out
await page
  .waitForFunction(() => document.querySelector('#source-badge')?.textContent?.includes('NOAA'), {timeout: 45000})
  .catch(() => {});
await page.waitForTimeout(7000);

// 1. the map canvas exists and has a size
const canvasBox = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  return c ? {w: c.width, h: c.height} : null;
});
check('map canvas present', !!canvasBox && canvasBox.w > 0, JSON.stringify(canvasBox));

// 2. the station list is populated
const stationCount = await page.locator('#station-list .station').count();
check('station list populated', stationCount > 3, `${stationCount} stations`);

// 3. the tide readout shows a number
const levelText = await page.locator('#level-value').innerText();
check('water level readout', /[0-9٠-٩]/.test(levelText), levelText);

// 4. the chart canvas has been drawn
const chartInk = await page.evaluate(() => {
  const c = document.querySelector('#chart');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
  return n;
});
check('tide curve drawn', chartInk > 2000, `${chartInk} painted pixels`);

// 5. the map actually shows water and land (sample the rendered canvas)
const grabPixels = async () =>
  page.evaluate(async () => {
    const c = document.querySelector('#map canvas');
    const off = document.createElement('canvas');
    off.width = 300;
    off.height = 200;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0, 300, 200);
    const d = ctx.getImageData(0, 0, 300, 200).data;
    let blue = 0;
    let land = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (b > r + 25 && b > 60) blue++;
      else if (g > r && g > 60) land++;
    }
    return {blue, land, total: d.length / 4, data: Array.from(d)};
  });

const pixelStats = async () => {
  const p = await grabPixels();
  return {blue: p.blue, land: p.land, total: p.total};
};

const beforeFull = await grabPixels();
const before = {blue: beforeFull.blue, land: beforeFull.land, total: beforeFull.total};
check('map renders water', before.blue > 3000, `${before.blue} water px of ${before.total}`);
check('map renders land', before.land > 3000, `${before.land} land px of ${before.total}`);

// 6. changing the tide changes the picture
await page.evaluate(() => {
  const s = document.querySelector('#exaggeration');
  s.value = '12';
  s.dispatchEvent(new Event('input', {bubbles: true}));
});
await page.waitForTimeout(1500);
const afterFull = await grabPixels();
const exag = await page.evaluate(() => window.__tide?.dem?.opts?.exaggeration);
// compare the actual pixels, not only the water-pixel count
let diff = 0;
for (let i = 0; i < beforeFull.data.length; i += 4) {
  diff += Math.abs(beforeFull.data[i] - afterFull.data[i]) + Math.abs(beforeFull.data[i + 1] - afterFull.data[i + 1]);
}
const meanDiff = diff / (beforeFull.data.length / 4) / 2;
check(
  'exaggeration changes the coastline',
  exag === 12 && meanDiff > 1.5,
  `exaggeration=${exag} mean pixel diff=${meanDiff.toFixed(2)}`,
);

// 7. the time slider moves the water level
const levelBefore = await page.locator('#level-value').innerText();
await page.evaluate(() => {
  const s = document.querySelector('#time-slider');
  s.value = String(Number(s.value) + 6 * 3600 * 1000);
  s.dispatchEvent(new Event('input', {bubbles: true}));
});
await page.waitForTimeout(800);
const levelAfter = await page.locator('#level-value').innerText();
check('time slider changes the level', levelBefore !== levelAfter, `${levelBefore} -> ${levelAfter}`);

// 8. the island tool adds a marker
await page.click('#btn-island');
await page.mouse.click(720, 420);
await page.waitForTimeout(800);
const islands = await page.locator('.island-marker').count();
check('island tool places an island', islands === 1, `${islands} markers`);

// 9. language toggle
await page.click('#btn-lang');
await page.waitForTimeout(400);
const dir = await page.evaluate(() => document.documentElement.dir);
check('language toggle switches to LTR', dir === 'ltr', dir);
await page.click('#btn-lang');

await page.screenshot({path: `${OUT}/atlas.png`});

// 10. no console errors
const real = errors.filter((e) => !/favicon|Failed to load resource/i.test(e));
check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
