/**
 * ui/app.js — LocalDrop DOM State Machine
 * Wires WebRTC, QR, and transfer modules to the HTML.
 */

import { LocalDropConnection } from '../core/webrtc.js';
import { sendFiles, receiveFiles, triggerDownload } from '../core/transfer.js';
import { renderQR, startScanner } from '../core/qr.js';
import { SpeedMeter, formatBytes } from '../utils/speed.js';

const $ = (id) => document.getElementById(id);

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const panelSend         = $('panel-send');
const panelReceive      = $('panel-receive');
const dropZone          = $('dropZone');
const fileInput         = $('fileInput');
const fileListEl        = $('fileList');
const qrSection         = $('qrSection');
const qrCanvas          = $('qrCanvas');
const qrStatusText      = $('qrStatusText');
const textFallbackBox   = $('textFallbackBox');
const textFallbackInput = $('textFallbackInput');
const sendActions       = $('sendActions');
const transferSection   = $('transferSection');
const transferTitle     = $('transferTitle');
const speedValEl        = $('speedVal');
const progressItems     = $('progressItems');
const statTransferred   = $('statTransferred');
const statElapsed       = $('statElapsed');
const statETA           = $('statETA');
const btnGenQR          = $('btnGenQR');
const btnScanAnswer     = $('btnScanAnswer');
const scanAnswerSection = $('scanAnswerSection');
const scanAnswerWrap    = $('scanAnswerWrap');
const manualAnswerBox   = $('manualAnswerBox');
const pastedAnswerInput = $('pastedAnswerInput');
const btnApplyPasted    = $('btnApplyPastedAnswer');
const btnCopyOffer      = $('btnCopyOffer');
const btnScanOffer      = $('btnScanOffer');
const scanOfferWrap     = $('scanOfferWrap');
const manualOfferBox    = $('manualOfferBox');
const offerTextInput    = $('offerTextInput');
const btnApplyOffer     = $('btnApplyTextOffer');
const answerQrSection   = $('answerQrSection');
const answerQrCanvas    = $('answerQrCanvas');
const answerQrStatus    = $('answerQrStatus');
const answerTextBox     = $('answerTextBox');
const answerTextInput   = $('answerTextInput');
const btnCopyAnswer     = $('btnCopyAnswer');
const incomingCard      = $('incomingCard');
const rxSpeed           = $('rxSpeed');
const rxProgressItems   = $('rxProgressItems');
const rxStatTransferred = $('rxStatTransferred');
const rxStatElapsed     = $('rxStatElapsed');
const rxStatETA         = $('rxStatETA');

// ─── State ────────────────────────────────────────────────────────────────────
let conn          = null;
let selectedFiles = [];
let scannerHandle = null;
const speed       = new SpeedMeter();
let statsInterval = null;
let _totalBytes   = 0;
let _sentBytes    = 0;

// Module-level URL map for receiver's manual-save buttons.
// Must be module-scoped (not closure-scoped) so resetAll() can revoke and clear
// it without window pollution. Keyed by fileIndex.
let _rxSavedUrls = {};

// ─── Transfer guard — warn before tab close / back-swipe ─────────────────────
// Set to true when DataChannel opens; false when complete or reset.
let isTransferring = false;

window.addEventListener('beforeunload', (e) => {
  if (isTransferring) {
    e.preventDefault();
    // Chrome requires returnValue to be set; most browsers show their own text.
    e.returnValue = 'A file transfer is in progress. Leaving will cancel it.';
  }
});

// ─── Screen WakeLock — prevent display sleep during long transfers ────────────
// Without this, a 5 GB transfer on a phone with 30s screen timeout will
// suspend the Wi-Fi radio mid-transfer, stalling or killing the DataChannel.
// WakeLock is released automatically when the tab loses focus (OS behaviour),
// so we re-acquire it on visibilitychange.

let _wakeLock = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return; // not supported (iOS < 16.4, Firefox)
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch (e) {
    // Permission denied or document not focused — non-fatal, transfer continues
    console.warn('[WakeLock] Could not acquire:', e.message);
  }
}

function releaseWakeLock() {
  _wakeLock?.release().catch(() => {});
  _wakeLock = null;
}

// Re-acquire if the tab regains visibility while a transfer is running
// (WakeLock is automatically released when the page is hidden)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isTransferring) {
    acquireWakeLock();
  }
});

// ─── OPFS capability banner ───────────────────────────────────────────────────
// Show a one-time info toast if OPFS is unavailable so the user knows the
// ~500 MB RAM limit applies. Runs after DOM is ready.
(async () => {
  const hasOPFS = typeof navigator.storage?.getDirectory === 'function';
  if (!hasOPFS) {
    // Delay so the toast container is rendered before first paint
    await new Promise(r => setTimeout(r, 800));
    toast(
      'Legacy browser detected — file size limited to ~500 MB. ' +
      'Use Chrome 86+ / Safari 17+ / Firefox 111+ for unlimited transfers.',
      'info',
    );
  }
})();

// ─── Haptic feedback ──────────────────────────────────────────────────────────
// Android Chrome/Firefox support the Vibration API; iOS silently no-ops it.
// Safe to call unconditionally — try/catch prevents any edge-case throws.
const vibrate = (pattern) => {
  try { navigator.vibrate?.(pattern); } catch (_) {}
};

// ─── Role switching ───────────────────────────────────────────────────────────
  document.querySelectorAll('.role-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  panelSend.classList.toggle('active', role === 'send');
  panelReceive.classList.toggle('active', role === 'receive');
  resetAll();
};

// ─── File selection ───────────────────────────────────────────────────────────
function getIconInfo(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','svg'].includes(ext)) return { icon:'🖼', cls:'img' };
  if (['mp4','mov','avi','mkv','webm'].includes(ext))         return { icon:'🎬', cls:'vid' };
  if (['pdf','doc','docx','txt','xls','xlsx'].includes(ext))  return { icon:'📄', cls:'doc' };
  return { icon:'📦', cls:'other' };
}

function renderFileList() {
  fileListEl.innerHTML = selectedFiles.map((f, i) => {
    const { icon, cls } = getIconInfo(f.name);
    return `<div class="file-item">
      <div class="file-icon ${cls}">${icon}</div>
      <div class="file-info">
        <div class="file-name">${esc(f.name)}</div>
        <div class="file-size">${formatBytes(f.size)}</div>
      </div>
      <button class="file-remove" onclick="removeFile(${i})">✕</button>
    </div>`;
  }).join('');
  sendActions.style.display = selectedFiles.length ? 'flex' : 'none';
}

window.removeFile = (i) => { selectedFiles.splice(i, 1); renderFileList(); };
window.clearFiles = () => {
  selectedFiles = [];
  renderFileList();
  hide(qrSection, textFallbackBox, sendActions, transferSection, scanAnswerSection);
};

function addFiles(list) {
  selectedFiles = [...selectedFiles, ...Array.from(list)];
  vibrate(50); // tactile confirmation on Android
  renderFileList();
}

fileInput?.addEventListener('change', () => addFiles(fileInput.files));
// NO dropZone click listener — the <label for="fileInput"> in HTML handles
// tap-to-open natively. Adding a JS click handler here would create a bubbling
// loop: label click → fileInput.click() → event bubbles back to label → loop.
dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone?.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragging');
  addFiles(e.dataTransfer.files);
});

// ─── SENDER: Generate Offer QR ────────────────────────────────────────────────
btnGenQR?.addEventListener('click', async () => {
  if (!selectedFiles.length) { toast('Select files first', 'info'); return; }

  resetConn();
  conn = new LocalDropConnection();

  conn.addEventListener('state', ({ state }) => {
    console.log('[WRT send]', state);
    if (state === 'connected') onSenderChannelOpen();
    if (state === 'failed')    toast('ICE failed — are both on the same Wi-Fi?', 'error');
  });

  btnGenQR.disabled = true;
  toast('Creating WebRTC offer…', 'info');

  try {
    const compressed = await conn.createOffer();
    show(qrSection);
    hide(sendActions);

    const result = await renderQR(qrCanvas, compressed);
    if (!result.ok) {
      show(textFallbackBox);
      textFallbackInput.value = compressed;
      if (qrStatusText) qrStatusText.textContent = '⚠ Payload too large for QR. Use text below.';
      toast('SDP too large for QR — use text fallback', 'info');
    } else {
      hide(textFallbackBox);
      if (qrStatusText) qrStatusText.textContent = 'Show this QR to the receiver →';
    }

    show(scanAnswerSection);
  } catch (err) {
    toast(err.message, 'error');
  }
  btnGenQR.disabled = false;
});

btnCopyOffer?.addEventListener('click', () => {
  navigator.clipboard?.writeText(textFallbackInput.value)
    .then(() => toast('Copied to clipboard', 'success'))
    .catch(() => toast('Select the text and copy manually', 'info'));
});

// ─── SENDER: Scan Receiver's Answer ──────────────────────────────────────────
btnScanAnswer?.addEventListener('click', async () => {
  show(scanAnswerWrap);
  btnScanAnswer.disabled = true;

  scannerHandle = await startScanner(
    'scanAnswerDiv',
    async (text) => {
      hide(scanAnswerWrap);
      btnScanAnswer.disabled = false;
      try {
        await conn.applyAnswer(text);
        toast('Answer applied — connecting…', 'success');
      } catch (err) {
        toast('Bad answer: ' + err.message, 'error');
      }
    },
    (err) => {
      hide(scanAnswerWrap);
      btnScanAnswer.disabled = false;
      show(manualAnswerBox);
      toast(err.message, 'info');
    },
  );
});

btnApplyPasted?.addEventListener('click', async () => {
  const text = pastedAnswerInput?.value?.trim();
  if (!text) { toast('Paste the answer text first', 'info'); return; }
  try {
    await conn.applyAnswer(text);
    toast('Answer applied — connecting…', 'success');
    hide(manualAnswerBox);
  } catch (err) {
    toast('Bad answer string: ' + err.message, 'error');
  }
});

// ─── SENDER: Connected → Send files ──────────────────────────────────────────
function onSenderChannelOpen() {
  isTransferring = true;
  acquireWakeLock();
  toast('🟢 Peer connected! Sending files…', 'success');
  hide(qrSection, scanAnswerSection, textFallbackBox, manualAnswerBox);
  show(transferSection);

  _totalBytes = selectedFiles.reduce((a, f) => a + f.size, 0);
  _sentBytes  = 0;
  if (transferTitle) transferTitle.textContent =
    `Sending ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}…`;

  if (progressItems) {
    progressItems.innerHTML = selectedFiles.map((f, i) =>
      progressRowHtml(i, f.name, f.size)
    ).join('');
  }

  speed.start();
  startStats(false);

  sendFiles(conn._channel, selectedFiles, {
    onProgress: (fi, sent, total, oSent) => {
      _sentBytes = oSent;
      speed.record(oSent);
      updateRow(fi, sent, total);
    },
    onFileComplete: (fi) => doneRow(fi),
    onAllComplete: () => {
      isTransferring = false;
      releaseWakeLock();
      stopStats();
      if (transferTitle) transferTitle.textContent = '✓ All files sent successfully';
      const sp = transferSection?.querySelector('.transfer-speed');
      if (sp) sp.innerHTML = '<span style="color:var(--accent)">Complete</span>';
      toast('Transfer complete! 🎉', 'success');
    },
    onError: (err) => toast(err.message, 'error'),
  });
}

// ─── RECEIVER: Scan Offer QR ──────────────────────────────────────────────────
btnScanOffer?.addEventListener('click', async () => {
  show(scanOfferWrap);
  btnScanOffer.disabled = true;

  scannerHandle = await startScanner(
    'scanOfferDiv',
    async (text) => {
      hide(scanOfferWrap);
      btnScanOffer.disabled = false;
      await processOffer(text);
    },
    (err) => {
      hide(scanOfferWrap);
      btnScanOffer.disabled = false;
      show(manualOfferBox);
      toast(err.message, 'info');
    },
  );
});

btnApplyOffer?.addEventListener('click', async () => {
  const text = offerTextInput?.value?.trim();
  if (!text) { toast('Paste the offer text first', 'info'); return; }
  hide(manualOfferBox);
  await processOffer(text);
});

async function processOffer(compressedOffer) {
  resetConn();
  conn = new LocalDropConnection();

  conn.addEventListener('channel', ({ channel }) => {
    onReceiverChannelOpen(channel);
  });

  try {
    toast('Processing offer…', 'info');
    await conn.applyOffer(compressedOffer);
    const compressed = await conn.createAnswer();

    show(answerQrSection);
    const result = await renderQR(answerQrCanvas, compressed);
    if (!result.ok) {
      show(answerTextBox);
      if (answerTextInput) answerTextInput.value = compressed;
      if (answerQrStatus) answerQrStatus.textContent = '⚠ Too large for QR. Copy text below.';
    } else {
      hide(answerTextBox);
      if (answerQrStatus) answerQrStatus.textContent = 'Show this QR to the sender →';
    }
    toast('Offer accepted! Show answer QR to sender.', 'success');
  } catch (err) {
    toast('Offer error: ' + err.message, 'error');
  }
}

btnCopyAnswer?.addEventListener('click', () => {
  navigator.clipboard?.writeText(answerTextInput?.value ?? '')
    .then(() => toast('Copied!', 'success'))
    .catch(() => toast('Select text and copy manually', 'info'));
});

// ─── RECEIVER: DataChannel open → receive ────────────────────────────────────
function onReceiverChannelOpen(channel) {
  isTransferring = true;
  acquireWakeLock();
  toast('🟢 Sender connected! Waiting for files…', 'success');
  if (incomingCard) incomingCard.classList.add('visible');
  speed.start();
  startStats(true);

  // Map fileIndex → object URL so the manual Save button stays valid
  const savedUrls = {};

  receiveFiles(channel, {
    onFileStart: (meta) => {
      let row = $('rxrow-' + meta.fileIndex);
      if (!row) {
        row = document.createElement('div');
        row.id = 'rxrow-' + meta.fileIndex;
        row.innerHTML = progressRowHtml(meta.fileIndex, meta.name, meta.size);
        rxProgressItems?.appendChild(row);
      }
      toast('Receiving: ' + meta.name, 'info');
    },
    onProgress: (fi, rcvd, total, oRcvd, oTotal) => {
      _totalBytes = oTotal;
      _sentBytes  = oRcvd;
      speed.record(oRcvd);
      updateRow(fi, rcvd, total);
      if (rxStatTransferred)
        rxStatTransferred.textContent = formatBytes(oRcvd) + ' / ' + formatBytes(oTotal);
    },

    // ── onFileComplete: OPFS fileHandle passed as 4th arg ─────────────────
    onFileComplete: (fi, fileOrBlob, name, opfsHandle) => {
      doneRow(fi);

      // Trigger download — appends <a> to body for Safari compatibility
      triggerDownload(fileOrBlob, name, opfsHandle);

      // Create a stable object URL for the manual Save button.
      // This URL is independent of the one triggerDownload creates so the
      // 15 s cleanup there doesn't break the manual button.
      const manualUrl = URL.createObjectURL(fileOrBlob);
      savedUrls[fi]   = { url: manualUrl, name };

      // Inject manual Save button into the progress row (iOS Safari fallback)
      const row = $('rxrow-' + fi);
      if (row) {
        const btn = document.createElement('div');
        btn.style.cssText = 'margin-top:8px; text-align:right;';
        btn.innerHTML = `<button class="btn btn-sm btn-accent2"
          onclick="window.saveRxFile(this, ${fi})" style="font-size:.75rem; padding:6px 12px;">
          💾 Save manually
        </button>`;
        row.appendChild(btn);
      }

      toast('Saved: ' + name, 'success');
    },

    onAllComplete: () => {
      isTransferring = false;
      releaseWakeLock();
      stopStats();
      const rx = $('rxTitle');
      if (rx) rx.textContent = '✓ All files received';
      const sp = incomingCard?.querySelector('.transfer-speed');
      if (sp) sp.innerHTML = '<span style="color:var(--accent2)">Complete</span>';
      toast('All files received! 🎉', 'success');

      // Revoke manual-save URLs after 5 minutes to free memory
      setTimeout(() => {
        Object.values(savedUrls).forEach(({ url }) => URL.revokeObjectURL(url));
      }, 5 * 60 * 1000);
    },
  });

  // Global handler for manual Save buttons
  window.saveRxFile = (btn, fi) => {
    const entry = savedUrls[fi];
    if (!entry) return;
    const a   = document.createElement('a');
    a.href    = entry.url;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    btn.textContent = '✓ Saved';
    btn.disabled    = true;
  };
}

// ─── Stats interval ───────────────────────────────────────────────────────────
function startStats(isRx) {
  statsInterval = setInterval(() => {
    const label     = speed.getSpeedLabel();
    const elapsed   = speed.getElapsed();
    const remaining = Math.max(0, _totalBytes - _sentBytes);
    const eta       = speed.getETA(remaining);
    if (isRx) {
      if (rxSpeed)        rxSpeed.textContent        = label;
      if (rxStatElapsed)  rxStatElapsed.textContent  = elapsed;
      if (rxStatETA)      rxStatETA.textContent      = eta;
    } else {
      if (speedValEl)      speedValEl.textContent      = label;
      if (statElapsed)     statElapsed.textContent     = elapsed;
      if (statETA)         statETA.textContent         = eta;
      if (statTransferred) statTransferred.textContent =
        formatBytes(_sentBytes) + ' / ' + formatBytes(_totalBytes);
    }
  }, 400);
}
function stopStats() { clearInterval(statsInterval); statsInterval = null; }

// ─── Progress row helpers ─────────────────────────────────────────────────────
function progressRowHtml(fi, name, size) {
  return `<div class="progress-item">
    <div class="progress-top">
      <div class="progress-name">${esc(name)}</div>
      <div class="progress-pct" id="pct-${fi}">0%</div>
    </div>
    <div class="progress-bar-bg">
      <div class="progress-bar" id="bar-${fi}" style="width:0%"></div>
    </div>
    <div class="progress-sub" id="sub-${fi}">0 B / ${formatBytes(size)}</div>
  </div>`;
}

function updateRow(fi, sent, total) {
  const pct = total > 0 ? Math.round((sent / total) * 100) : 0;
  const bar = $('bar-' + fi), pctEl = $('pct-' + fi), sub = $('sub-' + fi);
  if (bar)   bar.style.width   = pct + '%';
  if (pctEl) pctEl.textContent = pct + '%';
  if (sub)   sub.textContent   = formatBytes(sent) + ' / ' + formatBytes(total);
}

function doneRow(fi) {
  const bar = $('bar-' + fi), pctEl = $('pct-' + fi);
  if (bar)   { bar.style.width = '100%'; bar.style.background = 'var(--accent)'; }
  if (pctEl) pctEl.textContent = '✓';
}

// ─── Reset ────────────────────────────────────────────────────────────────────
function resetConn() {
  conn?.close(); conn = null;
  scannerHandle?.stop(); scannerHandle = null;
  stopStats();
}

function resetAll() {
  isTransferring = false;
  releaseWakeLock();
  resetConn();
  selectedFiles = [];
  _totalBytes = 0; _sentBytes = 0;
  renderFileList();
  [qrSection, textFallbackBox, sendActions, transferSection, scanAnswerSection,
   scanAnswerWrap, manualAnswerBox, answerQrSection, answerTextBox,
   manualOfferBox, scanOfferWrap].forEach(el => { if (el) el.style.display = 'none'; });
  if (incomingCard)    incomingCard.classList.remove('visible');
  if (rxProgressItems) rxProgressItems.innerHTML = '';
  if (progressItems)   progressItems.innerHTML = '';
}

// ─── Toast ────────────────────────────────────────────────────────────────────
export function showToast(msg, type = 'info') { toast(msg, type); }

function toast(msg, type = 'info') {
  const c = $('toasts'); if (!c) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const col = type === 'success' ? 'var(--accent)' : type === 'error' ? 'var(--danger)' : 'var(--accent2)';
  t.innerHTML = `<span style="color:${col}">●</span> ${esc(msg)}`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0'; t.style.transition = 'opacity .3s';
    setTimeout(() => t.remove(), 300);
  }, 4500);
}

// ─── Util ─────────────────────────────────────────────────────────────────────
function show(...els) { els.forEach(el => { if (el) el.style.display = 'block'; }); }
function hide(...els) { els.forEach(el => { if (el) el.style.display = 'none';  }); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}
