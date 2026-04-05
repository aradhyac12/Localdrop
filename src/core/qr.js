/**
 * core/qr.js
 *
 * QR Code generation (qrcode lib) and scanning (html5-qrcode lib).
 *
 * QR capacity note:
 *   QR Version 40 (alphanumeric mode) ≈ 4296 chars.
 *   A typical WebRTC SDP is ~4-8 KB raw JSON.
 *   After lz-string compression it drops to ~800-1400 chars — fits comfortably.
 *   If a user has many ICE candidates (unlikely on LAN), the payload may exceed
 *   QR capacity. We detect this and fall back to manual text paste.
 *
 * MAX_QR_PAYLOAD must match the actual QR library limit.
 * qrcode.js at error correction level L maxes out around 2953 bytes for byte mode.
 * lz-string compressToEncodedURIComponent uses only URI-safe chars (alphanumeric + _-).
 * Alphanumeric QR mode allows ~4296 chars at ECC=L. We set 2800 as safe limit.
 */

import QRCode from 'qrcode';

const MAX_QR_PAYLOAD = 2800;

// ─── Generator ────────────────────────────────────────────────────────────────

/**
 * Render a QR code for `text` into a <canvas> element.
 * Returns { ok: true } or { ok: false, reason } if payload too large.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {string}            text   — compressed SDP string
 */
export async function renderQR(canvas, text) {
  if (text.length > MAX_QR_PAYLOAD) {
    return { ok: false, reason: `Payload too large for QR (${text.length} chars). Use text fallback.` };
  }
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: 'L', // L = max data capacity; we don't need high ECC for on-screen QR
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
    width: Math.min(canvas.parentElement?.offsetWidth ?? 280, 280),
  });
  return { ok: true };
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

let _scanner = null; // singleton to avoid double-init

/**
 * Start scanning using the device camera.
 * Calls onResult(text) when a QR code is detected.
 * Calls onError(err) on permission denial or missing camera.
 *
 * Returns a stop() function.
 *
 * @param {string}   containerId  — id of the div to render the viewfinder into
 * @param {Function} onResult
 * @param {Function} onError
 */
export async function startScanner(containerId, onResult, onError) {
  // Probe camera availability before initialising the lib (better UX)
  if (!navigator.mediaDevices?.getUserMedia) {
    onError(new Error('Camera API not available. Use text fallback.'));
    return { stop: () => {} };
  }

  try {
    // Request permission early to get a clear browser dialog
    await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      onError(new Error('Camera permission denied. Use text fallback below.'));
    } else if (err.name === 'NotFoundError') {
      onError(new Error('No camera found on this device. Use text fallback below.'));
    } else {
      onError(err);
    }
    return { stop: () => {} };
  }

  // html5-qrcode lazy import (it's large; only load when needed)
  const { Html5Qrcode } = await import('html5-qrcode');

  if (_scanner) {
    try { await _scanner.stop(); } catch (_) {}
    _scanner = null;
  }

  _scanner = new Html5Qrcode(containerId, { verbose: false });

  let stopped = false;

  await _scanner.start(
    { facingMode: 'environment' },
    { fps: 15, qrbox: { width: 240, height: 240 } },
    (decodedText) => {
      if (stopped) return;
      stopped = true;
      stopScanner();
      onResult(decodedText);
    },
    () => {}, // ignore per-frame scan failures
  );

  async function stopScanner() {
    if (!_scanner) return;
    try {
      await _scanner.stop();
      _scanner.clear();
    } catch (_) {}
    _scanner = null;
  }

  return { stop: stopScanner };
}
