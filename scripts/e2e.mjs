/**
 * End-to-end check against the real app in a real browser.
 *
 * Chromium is launched with a fake audio device so the whole chain actually
 * runs: worklets load, a sample decodes, the graph plays, and the recorder
 * produces a WAV. Assertions are on audio that came out, not on markup.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.E2E_URL ?? 'http://localhost:4173';
const SHOTS = 'artifacts';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A short WAV with obvious content, built here so the test owns its input. */
function makeTestWav(seconds = 2, sampleRate = 44100) {
  const frames = seconds * sampleRate;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const ascii = (off, s) => [...s].forEach((c, i) => view.setUint8(off + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    // A sweep plus a pulse train: broadband enough that any filter or
    // distortion in the chain has something to bite on.
    const sweep = Math.sin(2 * Math.PI * (200 + 600 * t) * t);
    const pulse = i % Math.floor(sampleRate / 4) < 400 ? 0.5 : 0;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sweep * 0.6 + pulse)) * 0x7fff, true);
  }
  return Buffer.from(buffer);
}

const wav = makeTestWav();
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  // `chromium` in the browsers dir is a symlink straight to the binary.
  executablePath: join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers', 'chromium'),
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--no-sandbox',
  ],
});

const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle' });

// ------------------------------------------------------------- boot

await page.getByRole('button', { name: 'wake up' }).click();
await page.waitForFunction(() => !document.querySelector('.gate'), null, { timeout: 15000 });
check('audio context and worklets start from a user gesture', true);

const workletsLoaded = await page.evaluate(async () => {
  const r = await Promise.all([
    fetch('/worklets/granular-processor.js').then((x) => x.ok),
    fetch('/worklets/fx-processors.js').then((x) => x.ok),
  ]);
  return r.every(Boolean);
});
check('both worklet modules are served', workletsLoaded);

// -------------------------------------------------------- load a sample

await page.setInputFiles('input[type=file]', {
  name: 'voice-note.wav',
  mimeType: 'audio/wav',
  buffer: wav,
});

await page.waitForFunction(
  () => !!document.querySelector('.sample-list li .sample-name'),
  null,
  { timeout: 15000 },
);
const sampleName = await page.locator('.sample-list .sample-name').first().textContent();
check('uploaded file decodes into the library', sampleName === 'voice-note', `named "${sampleName}"`);

// The starter patch already refers to "voice-note", so the decks pick it up.
const waveformDrawn = await page.evaluate(() => {
  const canvas = document.querySelector('.waveform canvas');
  if (!canvas) return false;
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++;
  return lit > 500;
});
check('waveform renders the decoded sample', waveformDrawn);

// ------------------------------------------------------------- playback

await page.getByRole('button', { name: /play/ }).click();
await page.waitForTimeout(1500);

const level = await page.evaluate(async () => {
  // Read the master analyser the app already owns.
  const { engine } = await import('/src/audio/engine.ts');
  let peak = 0;
  for (let i = 0; i < 30; i++) {
    peak = Math.max(peak, engine.levels().peak);
    await new Promise((r) => setTimeout(r, 50));
  }
  return peak;
});
check('the graph makes sound', level > 0.001, `master peak ${level.toFixed(4)}`);

const finite = await page.evaluate(async () => {
  const { engine } = await import('/src/audio/engine.ts');
  const data = new Float32Array(2048);
  for (let i = 0; i < 20; i++) {
    engine.scope(data);
    for (const v of data) {
      if (!Number.isFinite(v) || Math.abs(v) > 4) return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
});
check('output stays finite and in range (no NaN or runaway feedback)', finite);

await page.screenshot({ path: join(SHOTS, 'desktop.png'), fullPage: false });

// ------------------------------------------- knobs write back to source

const before = await page.locator('.editor-input').inputValue();
const cutoffKnob = page.locator('.unit[data-node="svf"] .knob').filter({ hasText: 'Cutoff' }).locator('svg');
await cutoffKnob.focus();
for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
const after = await page.locator('.editor-input').inputValue();

const cutoffBefore = Number(before.match(/cutoff=(\d+(?:\.\d+)?)/)?.[1]);
const cutoffAfter = Number(after.match(/cutoff=(\d+(?:\.\d+)?)/)?.[1]);
check(
  'turning a knob rewrites the value in the source',
  Number.isFinite(cutoffAfter) && cutoffAfter > cutoffBefore,
  `cutoff ${cutoffBefore} → ${cutoffAfter}`,
);
check(
  'the rest of the patch is untouched',
  after.includes('# sloppy_knobs') && after.split('\n').length === before.split('\n').length,
);

// ------------------------------------------- editing source moves knobs

await page.locator('.editor-input').fill(before.replace(/cutoff=\d+(?:\.\d+)?/, 'cutoff=5000'));
await page.waitForTimeout(300);
const knobReadout = await page
  .locator('.unit[data-node="svf"] .knob')
  .filter({ hasText: 'Cutoff' })
  .locator('.knob-value')
  .first()
  .textContent();
check('editing the source moves the knob', knobReadout?.startsWith('5000'), `knob reads ${knobReadout}`);

// --------------------------------------------------- diagnostics report

await page.locator('.editor-input').fill('deck d {\n  src grain "voice-note"\n  fx crsh bits=4\n}');
await page.waitForTimeout(300);
const diagText = await page.locator('.diagnostics').textContent();
check('a typo is reported with a suggestion', /crsh/.test(diagText) && /crush/.test(diagText), diagText?.trim().slice(0, 90));

// ------------------------------------------------------------ recording

await page.locator('.editor-input').fill(before);
await page.waitForTimeout(400);
if (!(await page.getByRole('button', { name: /stop/ }).count())) {
  await page.getByRole('button', { name: /play/ }).click();
}
await page.waitForTimeout(300);

// `.transport-record`, not a name match: the library has its own mic button.
await page.locator('.transport-record').click();
await page.waitForTimeout(2500);
const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
await page.locator('.transport-record').click();
const download = await downloadPromise;
const path = join(SHOTS, 'export.wav');
await download.saveAs(path);

const { readFileSync } = await import('node:fs');
const exported = readFileSync(path);
const view = new DataView(exported.buffer, exported.byteOffset, exported.byteLength);
const isRiff = exported.subarray(0, 4).toString() === 'RIFF' && exported.subarray(8, 12).toString() === 'WAVE';
let peakSample = 0;
let nonZero = 0;
for (let off = 44; off + 1 < exported.length; off += 2) {
  const s = Math.abs(view.getInt16(off, true)) / 0x8000;
  if (s > peakSample) peakSample = s;
  if (s > 0.0005) nonZero++;
}
check('export is a valid WAV', isRiff, `${(exported.length / 1024).toFixed(0)} kB`);
check(
  'exported audio is not silent',
  peakSample > 0.005 && nonZero > 1000,
  `peak ${peakSample.toFixed(3)}, ${nonZero} audible samples`,
);

// ------------------------------------------------ reload with a library

// The sample is already in IndexedDB now, so this exercises the path where
// decoding happens during boot rather than in response to an upload.
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'wake up' }).click();
await page.waitForFunction(() => !document.querySelector('.gate'), null, { timeout: 15000 });
await page.waitForTimeout(800);

const redrawn = await page.evaluate(() => {
  const canvas = document.querySelector('.waveform canvas');
  if (!canvas) return false;
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let lit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++;
  return lit > 500;
});
check('a restored sample is drawn after reload', redrawn);

await page.getByRole('button', { name: /play/ }).click();
await page.waitForTimeout(1200);
const reloadLevel = await page.evaluate(async () => {
  const { engine } = await import('/src/audio/engine.ts');
  let peak = 0;
  for (let i = 0; i < 20; i++) {
    peak = Math.max(peak, engine.levels().peak);
    await new Promise((r) => setTimeout(r, 50));
  }
  return peak;
});
check('the graph builds and plays after reload', reloadLevel > 0.001, `master peak ${reloadLevel.toFixed(4)}`);

// -------------------------------------------------------------- mobile

const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(BASE, { waitUntil: 'networkidle' });
await mobile.getByRole('button', { name: 'wake up' }).click();
await mobile.waitForFunction(() => !document.querySelector('.gate'), null, { timeout: 15000 });
await mobile.waitForTimeout(500);

const noHorizontalScroll = await mobile.evaluate(
  () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
);
check('mobile layout does not scroll sideways', noHorizontalScroll);
await mobile.screenshot({ path: join(SHOTS, 'mobile-rack.png') });
await mobile.getByRole('tab', { name: 'code' }).click();
await mobile.waitForTimeout(200);
await mobile.screenshot({ path: join(SHOTS, 'mobile-code.png') });

check('no uncaught errors in the console', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
writeFileSync(join(SHOTS, 'e2e-results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
