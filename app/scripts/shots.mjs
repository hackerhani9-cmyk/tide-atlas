/**
 * لقطة مقارنة: نفس المكان عند المدّ المنخفض والمدّ العالي، لبيان أثر المدّ على الخريطة.
 *   node scripts/shots.mjs [url] [outDir]
 */
import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';

const URL = process.argv[2] ?? 'http://127.0.0.1:4173/';
const OUT = process.argv[3] ?? 'shots';
mkdirSync(OUT, {recursive: true});

const browser = await chromium.launch({args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport: {width: 1440, height: 900}});
await page.goto(`${URL}?station=9414290`, {waitUntil: 'domcontentloaded', timeout: 60000});
await page
  .waitForFunction(() => document.querySelector('#source-badge')?.textContent?.includes('NOAA'), {timeout: 45000})
  .catch(() => {});
await page.waitForTimeout(6000);

// اقفز إلى أقرب مدّ منخفض ثم إلى أقرب مدّ عالٍ
async function jumpTo(kind) {
  await page.click(kind === 'H' ? '#btn-jump-high' : '#btn-jump-low');
  await page.waitForTimeout(3500);
}

await jumpTo('L');
await page.screenshot({path: `${OUT}/low-tide.png`});
const low = await page.locator('#level-value').innerText();

await jumpTo('H');
await page.screenshot({path: `${OUT}/high-tide.png`});
const high = await page.locator('#level-value').innerText();

// نسخة بواجهة إنجليزية
await page.click('#btn-lang');
await page.waitForTimeout(1200);
await page.screenshot({path: `${OUT}/english.png`});

console.log(`low tide  : ${low}`);
console.log(`high tide : ${high}`);
await browser.close();
