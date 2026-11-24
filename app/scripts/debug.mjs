import {chromium} from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:4173/';
const browser = await chromium.launch({args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(0, 120), r.failure()?.errorText));
page.on('response', (r) => console.log('[resp]', r.status(), r.url().slice(0, 110)));
await page.goto(URL, {waitUntil: 'domcontentloaded', timeout: 45000});
await page.waitForTimeout(12000);
const state = await page.evaluate(() => ({
  stations: document.querySelectorAll('#station-list .station').length,
  listHtml: document.querySelector('#station-list')?.innerHTML.slice(0, 200),
  level: document.querySelector('#level-value')?.textContent,
  badge: document.querySelector('#source-badge')?.textContent,
  canvas: (() => {
    const c = document.querySelector('#map canvas');
    return c ? [c.width, c.height] : null;
  })(),
}));
console.log('STATE', JSON.stringify(state));
await page.screenshot({path: 'shots/debug.png'});
await browser.close();
