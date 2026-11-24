import {chromium} from 'playwright';
const browser = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport:{width:1280,height:800}});
const errs=[]; page.on('pageerror',e=>errs.push(String(e).slice(0,120)));
await page.goto('http://127.0.0.1:4190/', {waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>document.querySelector('#source-badge')?.textContent?.includes('NOAA'),{timeout:45000}).catch(()=>{});
await page.waitForTimeout(6000);
console.log(JSON.stringify(await page.evaluate(()=>{
  const c=document.querySelector('#map canvas'); const off=document.createElement('canvas');
  off.width=200;off.height=140; const ctx=off.getContext('2d'); ctx.drawImage(c,0,0,200,140);
  const d=ctx.getImageData(0,0,200,140).data; let painted=0;
  for(let i=0;i<d.length;i+=4) if(d[i]||d[i+1]||d[i+2]) painted++;
  return {painted, stations:document.querySelectorAll('#station-list .station').length,
    level:document.querySelector('#level-value')?.textContent,
    status:document.querySelector('#map-status')?.textContent,
    boot:document.querySelector('#boot')?.classList.contains('hidden')};
})));
console.log('errors:', errs.join('|')||'none');
await browser.close();
