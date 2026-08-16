/**
 * Renders the app icon to the PNG sizes a home-screen install needs.
 *
 * Playwright is already a dev dependency for the e2e suite, so the icons are
 * screenshotted from SVG rather than adding an image library. Run this only
 * when the icon design changes; the output is committed.
 *
 *   node scripts/make-icons.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join('public', 'icons');
mkdirSync(OUT, { recursive: true });

/**
 * @param {number} size
 * @param {boolean} maskable Pad the art so Android's circular crop cannot clip
 *   it — maskable icons lose roughly the outer 10% on each edge.
 */
function svg(size, maskable = false) {
  const pad = maskable ? 0.18 : 0.06;
  const inner = 1 - pad * 2;
  const s = (n) => (n * inner + pad) * size;
  const stroke = size * 0.085;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="#0d0c0f"/>
    <circle cx="${s(0.5)}" cy="${s(0.54)}" r="${size * inner * 0.31}"
            fill="none" stroke="#7de3c3" stroke-width="${stroke}"/>
    <line x1="${s(0.5)}" y1="${s(0.54)}" x2="${s(0.29)}" y2="${s(0.33)}"
          stroke="#ff5f6d" stroke-width="${stroke}" stroke-linecap="round"/>
    <circle cx="${s(0.5)}" cy="${s(0.54)}" r="${size * 0.028}" fill="#f2efe9"/>
  </svg>`;
}

const targets = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  // iOS ignores the manifest for the home-screen icon and wants this one.
  { name: 'apple-touch-icon.png', size: 180, maskable: false },
];

const browser = await chromium.launch({
  executablePath: join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers', 'chromium'),
  args: ['--no-sandbox'],
});
const page = await browser.newPage();

for (const target of targets) {
  await page.setViewportSize({ width: target.size, height: target.size });
  await page.setContent(
    `<body style="margin:0;background:#0d0c0f">${svg(target.size, target.maskable)}</body>`,
  );
  await page.locator('svg').screenshot({ path: join(OUT, target.name) });
  console.log(`  wrote ${join(OUT, target.name)} (${target.size}px)`);
}

await browser.close();
