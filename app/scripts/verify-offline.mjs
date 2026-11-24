/**
 * يختبر سلوك التطبيق عند حجب مصادر خارجية:
 *  1) حجب OpenFreeMap  → يجب التحويل إلى CARTO والاستمرار
 *  2) حجب كل البلاطات  → يجب بقاء التطبيق حيّاً مع رسالة واضحة
 *  3) الحالة السليمة    → مرجع للمقارنة
 */
import {chromium} from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:4180/';

const scenarios = [
  {name: 'openfreemap محجوب', block: (u) => u.includes('openfreemap.org')},
  {name: 'كل البلاطات محجوبة', block: () => true},
  {name: 'سليم', block: () => false},
];

for (const sc of scenarios) {
  const browser = await chromium.launch({args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport: {width: 1200, height: 760}});
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1') || u.startsWith('data:') || u.startsWith('blob:')) {
      return route.continue();
    }
    if (sc.block(u)) return route.abort();
    return route.continue();
  });
  await page.goto(URL, {waitUntil: 'domcontentloaded', timeout: 40000});
  await page.waitForTimeout(22000);
  const st = await page.evaluate(() => {
    const c = document.querySelector('#map canvas');
    let painted = 0;
    if (c) {
      const off = document.createElement('canvas');
      off.width = 200;
      off.height = 140;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0, 200, 140);
      const d = ctx.getImageData(0, 0, 200, 140).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] || d[i + 1] || d[i + 2]) painted++;
    }
    const boot = document.querySelector('#boot');
    return {
      painted,
      stations: document.querySelectorAll('#station-list .station').length,
      level: document.querySelector('#level-value')?.textContent,
      badge: document.querySelector('#source-badge')?.textContent,
      mapStatus: document.querySelector('#map-status')?.textContent,
      bootVisible: boot ? !boot.classList.contains('hidden') : false,
      bootTitle: document.querySelector('#boot-title')?.textContent,
    };
  });
  console.log(`\n=== ${sc.name}`);
  console.log(JSON.stringify(st));
  await page.screenshot({path: `shots/block-${sc.name.split(' ')[0]}.png`});
  await browser.close();
}
