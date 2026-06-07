import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ command }) => ({
  plugins: [
    // basicSsl only in dev — never in production build
    command === 'serve' && basicSsl(),

    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'icons/*.svg'],

      manifest: {
        name: 'KineticsIQ',
        short_name: 'KineticsIQ',
        description: 'Joint range of motion measurement using visual markers',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0a0a',
        theme_color: '#0a0a0a',
        orientation: 'portrait',
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
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm,bin}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdnjs\.cloudflare\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-cache',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
            },
          },
          {
            urlPattern: /^https:\/\/storage\.googleapis\.com\/mediapipe-models\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mediapipe-models',
              expiration: {
                maxEntries: 5,
                maxAgeSeconds: 60 * 60 * 24 * 90,
              },
            },
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mediapipe-wasm',
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 60 * 60 * 24 * 90,
              },
            },
          },
        ],
      },
    }),
  ].filter(Boolean),

  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },

  server: {
    https: true,
    host: true,
    port: 5173,
  },

  test: {
    environment: 'node',
  },
}))
