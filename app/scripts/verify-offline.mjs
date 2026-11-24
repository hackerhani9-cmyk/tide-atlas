import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const appUrl = new URL(process.argv[2] ?? 'http://127.0.0.1:4180/');
const styleUrl = 'https://tiles.openfreemap.org/styles/liberty';
const fixtureTile = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQCMgDAAGKAOdV07rDAAAAAElFTkSuQmCC',
  'base64',
);
const fixtureStyle = {
  version: 8,
  sources: {fixture: {type: 'raster', tiles: ['https://tiles.openfreemap.org/test/{z}/{x}/{y}.png']}},
  layers: [{id: 'fixture', type: 'raster', source: 'fixture'}],
};

const scenarios = [
  {name: 'primary basemap', expected: 'OpenFreeMap', primary: true},
  {name: 'primary style blocked', expected: 'OpenStreetMap', osm: true, noStyle: true},
  {name: 'vector provider tiles blocked', expected: 'OpenStreetMap', osm: true},
  {name: 'all external tiles blocked', expected: 'الخريطة الأساسية غير متاحة'},
  {name: 'WebGL disabled', expected: 'OpenStreetMap', osm: true, noWebgl: true},
  {name: 'WebGL disabled and tiles blocked', expected: 'الخريطة الأساسية غير متاحة', noWebgl: true},
];

const browser = await chromium.launch({args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
try {
  for (const scenario of scenarios) {
    const page = await browser.newPage();
    const errors = [];
    const osmTiles = [];
    const cartoRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    if (scenario.noWebgl) {
      await page.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...options) {
          return type.startsWith('webgl') ? null : getContext.call(this, type, ...options);
        };
      });
    }
    await page.route('**/*', (route) => {
      const request = new URL(route.request().url());
      if (request.origin === appUrl.origin) return route.continue();
      const headers = {'access-control-allow-origin': '*'};
      if (request.hostname.endsWith('cartocdn.com')) cartoRequests.push(request.href);
      if (request.href === styleUrl && !scenario.noStyle) return route.fulfill({json: fixtureStyle, headers});
      if (scenario.osm && request.hostname === 'tile.openstreetmap.org') {
        osmTiles.push(request.pathname);
        return route.fulfill({body: fixtureTile, contentType: 'image/png', headers});
      }
      if (scenario.primary && request.hostname === 'tiles.openfreemap.org') {
        return route.fulfill({body: fixtureTile, contentType: 'image/png', headers});
      }
      return route.abort();
    });

    await page.goto(appUrl.href, {waitUntil: 'domcontentloaded'});
    await page.locator('#boot').waitFor({state: 'hidden', timeout: 25000});
    await page.locator('#map-status').filter({hasText: scenario.expected}).waitFor({timeout: 10000});
    await page.locator('#station-list .station').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#level-value').textContent !== '—');
    assert.equal(await page.locator('#map-retry').isVisible(), !scenario.primary && !scenario.osm, scenario.name);
    if (scenario.osm) {
      assert.ok(osmTiles.some((path) => /^\/\d+\/\d+\/\d+\.png$/.test(path)), scenario.name);
      await page.locator('#map a[href="https://www.openstreetmap.org/copyright"]').waitFor({state: 'attached'});
      if (scenario.noWebgl) await page.locator('#map .leaflet-tile-loaded').first().waitFor();
    }
    assert.equal(await page.locator('#btn-dem').isDisabled(), Boolean(scenario.noWebgl), scenario.name);
    assert.equal(await page.locator('#map').evaluate((element) => element.classList.contains('leaflet-container')), Boolean(scenario.noWebgl));
    await page.locator('#station-list .station:not(.active)').first().click();
    await page.locator('#btn-lang').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.deepEqual(errors, [], scenario.name);
    assert.deepEqual(cartoRequests, [], scenario.name);
    console.log(`PASS: ${scenario.name}`);
    await page.close();
  }
} finally {
  await browser.close();
}
