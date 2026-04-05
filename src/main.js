/**
 * main.js — Vite entry point
 *
 * Registers the Service Worker (via vite-plugin-pwa's virtual module)
 * and boots the UI controller.
 */

import { registerSW } from 'virtual:pwa-register';
import './ui/app.js';

// PWA: auto-update SW silently. Show a toast if a new version is ready.
registerSW({
  onNeedRefresh() {
    import('./ui/app.js').then(({ showToast }) => {
      showToast('New version available — reload to update', 'info');
    });
  },
  onOfflineReady() {
    import('./ui/app.js').then(({ showToast }) => {
      showToast('App ready for offline use ✓', 'success');
    });
  },
});
