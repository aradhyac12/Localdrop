import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    // HTTPS required for: WebRTC, getUserMedia (camera), Service Workers on non-localhost
    basicSsl(),

    VitePWA({
      registerType: 'autoUpdate',
      // Inject SW registration into index.html automatically
      injectRegister: 'auto',
      workbox: {
        // Precache everything in the dist folder
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Cache-first for all static assets (works fully offline)
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com/,
            handler: 'CacheFirst',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 10 } },
          },
        ],
        // Don't cache the QR scanner WASM; it's bundled by Vite anyway
        navigateFallback: 'index.html',
      },
      manifest: {
        name: 'LocalDrop',
        short_name: 'LocalDrop',
        description: 'Serverless P2P file sharing over local Wi-Fi',
        theme_color: '#0a0a0b',
        background_color: '#0a0a0b',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      devOptions: {
        // Enable SW in dev mode so you can test offline behaviour
        enabled: true,
      },
    }),
  ],

  server: {
    // Expose to LAN so mobile devices can reach the dev server
    host: '0.0.0.0',
    port: 5173,
  },
});
