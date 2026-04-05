/**
 * utils/speed.js
 *
 * Rolling-window speed calculator for accurate MB/s and ETA display.
 * Uses a 2-second sliding window to smooth out chunk bursts.
 */

const WINDOW_MS = 2000; // 2-second rolling average

export class SpeedMeter {
  constructor() {
    this._samples = []; // [{ t: timestamp, bytes }]
    this._startTime = null;
    this._lastBytes = 0;
  }

  start() {
    this._startTime = performance.now();
    this._samples = [];
    this._lastBytes = 0;
  }

  /**
   * Record bytes transferred at this point in time.
   * @param {number} totalBytesTransferred — cumulative total, not delta
   */
  record(totalBytesTransferred) {
    const now = performance.now();
    const delta = totalBytesTransferred - this._lastBytes;
    this._lastBytes = totalBytesTransferred;
    this._samples.push({ t: now, bytes: delta });

    // Prune samples outside the rolling window
    const cutoff = now - WINDOW_MS;
    this._samples = this._samples.filter(s => s.t >= cutoff);
  }

  /** @returns {number} bytes per second */
  getBytesPerSec() {
    if (this._samples.length < 2) return 0;
    const windowBytes = this._samples.reduce((a, s) => a + s.bytes, 0);
    const windowSec = (this._samples[this._samples.length - 1].t - this._samples[0].t) / 1000;
    return windowSec > 0 ? windowBytes / windowSec : 0;
  }

  /** @returns {string} e.g. "34.2 MB/s" */
  getSpeedLabel() {
    const bps = this.getBytesPerSec();
    if (bps > 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
    if (bps > 1e3) return (bps / 1e3).toFixed(0) + ' KB/s';
    return bps.toFixed(0) + ' B/s';
  }

  /**
   * @param {number} remainingBytes
   * @returns {string} e.g. "1:23" or "—"
   */
  getETA(remainingBytes) {
    const bps = this.getBytesPerSec();
    if (bps <= 0) return '—';
    const secs = Math.ceil(remainingBytes / bps);
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  /** @returns {string} elapsed time since start() */
  getElapsed() {
    if (!this._startTime) return '0:00';
    const secs = Math.floor((performance.now() - this._startTime) / 1000);
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  }
}

export function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(0) + ' KB';
  return bytes + ' B';
}
