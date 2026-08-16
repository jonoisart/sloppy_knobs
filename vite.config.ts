import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves a project site from a subpath, so the base has to be
// `/sloppy_knobs/` there and `/` everywhere else. Reading it from the
// environment keeps dev, the e2e suite and the deploy workflow each correct.
// src/audio/engine.ts resolves the worklets through import.meta.env.BASE_URL,
// so they follow this automatically.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      workbox: {
        // The worklets live in public/ and are fetched at runtime by
        // addModule(), so they must be precached or the app would load offline
        // and then make no sound at all.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
      manifest: {
        name: 'sloppy_knobs',
        short_name: 'sloppy',
        description:
          'An audio coding language with knobs on. Load voice notes and found sound, then mangle them live.',
        // Relative so the manifest does not care what path it is served from.
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0d0c0f',
        theme_color: '#0d0c0f',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
});
