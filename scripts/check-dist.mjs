/**
 * Guards the built output before it is published.
 *
 * A base-path mistake produces a page that builds cleanly, passes every unit
 * test, and then serves a blank screen with four 404s — and the worklet 404 is
 * the worst of them, because the UI would come up and simply make no sound.
 * Cheaper to assert it here than to discover it on a phone.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const base = process.env.VITE_BASE ?? '/';

const problems = [];
const ok = [];

function require(condition, message) {
  if (condition) ok.push(message);
  else problems.push(message);
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`No ${DIST}/index.html — run the build first.`);
  process.exit(1);
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');

// Every absolute reference the page makes must sit under the base.
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((h) => h.startsWith('/'));

const strays = refs.filter((h) => !h.startsWith(base));
require(
  strays.length === 0,
  strays.length === 0
    ? `all ${refs.length} absolute references sit under "${base}"`
    : `these would 404 under "${base}": ${strays.join(', ')}`,
);

require(refs.length > 0, 'index.html references its built assets');

// The worklets are fetched at runtime, so a bundler cannot catch their absence.
for (const worklet of ['granular-processor.js', 'fx-processors.js']) {
  require(existsSync(join(DIST, 'worklets', worklet)), `worklets/${worklet} is present`);
}

require(existsSync(join(DIST, 'manifest.webmanifest')), 'manifest is present');
require(existsSync(join(DIST, 'sw.js')), 'service worker is present');

for (const icon of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) {
  require(existsSync(join(DIST, 'icons', icon)), `icons/${icon} is present`);
}

// The service worker must precache the worklets, or the app loads offline and
// then silently fails to build any audio graph.
if (existsSync(join(DIST, 'sw.js'))) {
  const swDir = readFileSync(join(DIST, 'sw.js'), 'utf8');
  const precacheFile = swDir.match(/["']([^"']*workbox[^"']*\.js)["']/)?.[1];
  const manifestSource = [
    swDir,
    precacheFile && existsSync(join(DIST, precacheFile)) ? readFileSync(join(DIST, precacheFile), 'utf8') : '',
  ].join('');
  require(
    manifestSource.includes('worklets/') || swDir.includes('worklets/'),
    'service worker precaches the worklets',
  );
}

for (const line of ok) console.log(`  ok    ${line}`);
for (const line of problems) console.error(`  FAIL  ${line}`);

console.log(`\n${ok.length}/${ok.length + problems.length} build checks passed (base "${base}")`);
process.exit(problems.length ? 1 : 0);
