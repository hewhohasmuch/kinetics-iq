import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    basicSsl(),

    VitePWA({
      // 'autoUpdate' — new service worker activates automatically in background.
      // Good for MVP: users always get latest version without a manual refresh prompt.
      registerType: 'autoUpdate',

      // Include these files in the precache (app shell)
      includeAssets: [
        'icons/*.png',
        'icons/*.svg',
      ],

      manifest: {
        name: 'KineticsIQ',
        short_name: 'KineticsIQ',
        description: 'Joint range of motion measurement using visual markers',
        start_url: '/',
        display: 'standalone',      // hides browser chrome — feels native
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        orientation: 'portrait',    // lock to portrait — phone held upright beside leg

        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },

      workbox: {
        // Cache the app shell (HTML, JS, CSS) with cache-first strategy.
        // App works offline after first load.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],

        // Runtime caching: Chart.js from CDN
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdnjs\.cloudflare\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 30,  // 30 days
              },
            },
          },
        ],
      },
    }),
  ],

  server: {
    https: true,
    host: true,
    port: 5173,
  },

  test: {
    environment: 'node',
  },
})
