/**
 * Copies the MapLibre GL JS web worker into public/ so that it is served
 * next to the app. MapLibre derives the worker URL from its own module URL,
 * which points at the bundled asset — so the worker has to be available as a
 * standalone file.
 */
import {copyFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs');
const dstDir = resolve(root, 'public');
const dst = resolve(dstDir, 'maplibre-gl-worker.mjs');

if (!existsSync(src)) {
  console.error('maplibre worker not found at ' + src);
  process.exit(1);
}
mkdirSync(dstDir, {recursive: true});
copyFileSync(src, dst);
console.log('copied maplibre worker → public/maplibre-gl-worker.mjs');
