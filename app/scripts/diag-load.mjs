import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';
mkdirSync('shots', {recursive: true});

const scenarios = [
  ['file', 'file:///workspace/tide-atlas/app/dist/index.html'],
  ['static', 'http://127.0.0.1:4180/'],
];

for (const [name, url] of scenarios) {
  const browser = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport:{width:1200,height:760}});
  const errs = [];
  page.on('console', m => { if (m.type()==='error') errs.push(m.text().slice(0,160)); });
  page.on('pageerror', e => errs.push('PAGEERR '+String(e).slice(0,160)));
  page.on('requestfailed', r => errs.push('REQFAIL '+r.url().slice(0,80)));
  try {
    await page.goto(url, {waitUntil:'domcontentloaded', timeout:30000});
    await page.waitForTimeout(12000);
    const st = await page.evaluate(() => {
      const c = document.querySelector('#map canvas');
      let painted = 0;
      if (c) {
        const off = document.createElement('canvas'); off.width=200; off.height=140;
        const ctx = off.getContext('2d'); ctx.drawImage(c,0,0,200,140);
        const d = ctx.getImageData(0,0,200,140).data;
        for (let i=0;i<d.length;i+=4) if (d[i]||d[i+1]||d[i+2]) painted++;
      }
      return {
        canvas: c ? [c.width,c.height] : null,
        painted,
        stations: document.querySelectorAll('#station-list .station').length,
        level: document.querySelector('#level-value')?.textContent,
        badge: document.querySelector('#source-badge')?.textContent,
        webgl2: !!document.createElement('canvas').getContext('webgl2'),
      };
    });
    console.log(`\n=== ${name} (${url})`);
    console.log(JSON.stringify(st));
    console.log('errors:', errs.slice(0,6).join(' || ') || 'none');
    await page.screenshot({path:`shots/load-${name}.png`});
  } catch (e) {
    console.log(`\n=== ${name} FAILED:`, String(e).slice(0,200));
  }
  await browser.close();
}
