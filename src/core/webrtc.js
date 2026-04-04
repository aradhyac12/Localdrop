/**
 * core/webrtc.js
 *
 * Raw RTCPeerConnection + SDP compression via lz-string.
 * Zero external signaling. Offer/Answer exchanged via QR or clipboard.
 *
 * Architecture:
 *   Sender  → createOffer()  → compress → QR-A
 *   Receiver → scanQR-A → applyOffer() → createAnswer() → compress → QR-B
 *   Sender  → scanQR-B → applyAnswer() → ICE completes → DataChannel opens
 *
 * Because both sides are on the same LAN, ICE candidates from the
 * local interface are sufficient — no STUN/TURN needed.
 * We gather ALL candidates before encoding (trickle=false via
 * onicegatheringstatechange) to keep the QR payload a single blob.
 *
 * ── Why ordered / reliable SCTP (no maxRetransmits) ──────────────────────────
 * The previous version used { ordered: false, maxRetransmits: 0 } (UDP-like).
 * On paper that maximises throughput; in practice Wi-Fi loses packets and
 * without application-layer reordering/retransmit the assembled file is silently
 * corrupted. WebRTC's SCTP layer IS already optimised for P2P — it uses
 * selective-ACK and avoids TCP's head-of-line blocking at the IP level.
 * On a good LAN the throughput difference vs. unreliable mode is < 3%.
 * The correctness guarantee is worth it unconditionally.
 */

import LZString from 'lz-string';

// ─── ICE config: LAN-only, no STUN/TURN ──────────────────────────────────────
const ICE_SERVERS = [];   // empty = host candidates only (LAN)

// For slightly better connectivity across different subnets/hotspots,
// optionally add Google STUN. Remove if truly zero-internet required:
// const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const RTC_CONFIG = {
  iceServers: ICE_SERVERS,
  iceTransportPolicy: 'all',
};

// ─── Compression helpers ──────────────────────────────────────────────────────
// lz-string's compressToEncodedURIComponent produces URL-safe base64-ish text,
// ideal for QR codes (alphanumeric mode) and clipboard copy.

export function compressSDP(sdpObject) {
  const json = JSON.stringify(sdpObject);
  return LZString.compressToEncodedURIComponent(json);
}

export function decompressSDP(compressed) {
  const json = LZString.decompressFromEncodedURIComponent(compressed);
  if (!json) throw new Error('SDP decompression failed — corrupted payload?');
  return JSON.parse(json);
}

// ─── Wait for ICE gathering to complete ──────────────────────────────────────
function waitForIceGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    // Safety timeout: 2s. On LAN, host candidates appear in <500ms.
    // Hotspot topology is equally fast — both devices share the same radio cell.
    setTimeout(resolve, 2000);
  });
}

// ─── LocalDropConnection class ────────────────────────────────────────────────
export class LocalDropConnection extends EventTarget {
  /**
   * Events emitted (use addEventListener):
   *   'state'       → { state: string }           connection phase updates
   *   'channel'     → { channel: RTCDataChannel }  fired when DC opens
   *   'error'       → { message: string }
   */

  constructor() {
    super();
    this._pc = null;
    this._channel = null;
    this.role = null; // 'sender' | 'receiver'
  }

  // ── SENDER SIDE ────────────────────────────────────────────────────────────

  /**
   * Step 1 (Sender): create offer, gather ICE, return compressed payload.
   * @returns {Promise<string>} compressed SDP string → encode into QR
   */
  async createOffer() {
    this.role = 'sender';
    this._pc = new RTCPeerConnection(RTC_CONFIG);
    this._setupPcListeners();

    // Create the DataChannel BEFORE the offer so it's included in SDP.
    //
    // RELIABILITY: Use default reliable/ordered SCTP (no options = TCP-like).
    // { ordered:false, maxRetransmits:0 } would give UDP-like speed but silently
    // corrupts files on any Wi-Fi packet loss. The SCTP stack's selective-ACK
    // handles retransmits natively with negligible overhead on LAN.
    this._channel = this._pc.createDataChannel('filedrop');
    this._wireDataChannel(this._channel);

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);

    this._emit('state', { state: 'gathering_ice' });
    await waitForIceGathering(this._pc);

    // localDescription now contains all ICE candidates inline (a=candidate lines)
    const payload = {
      sdp: this._pc.localDescription.sdp,
      type: this._pc.localDescription.type,
    };
    this._emit('state', { state: 'offer_ready' });
    return compressSDP(payload);
  }

  /**
   * Step 3 (Sender): apply the receiver's compressed answer.
   * @param {string} compressedAnswer
   */
  async applyAnswer(compressedAnswer) {
    const sdpObj = decompressSDP(compressedAnswer);
    await this._pc.setRemoteDescription(new RTCSessionDescription(sdpObj));
    this._emit('state', { state: 'connecting' });
  }

  // ── RECEIVER SIDE ──────────────────────────────────────────────────────────

  /**
   * Step 2a (Receiver): apply sender's offer.
   * @param {string} compressedOffer
   */
  async applyOffer(compressedOffer) {
    this.role = 'receiver';
    this._pc = new RTCPeerConnection(RTC_CONFIG);
    this._setupPcListeners();

    // Receiver gets the channel via ondatachannel
    this._pc.ondatachannel = (event) => {
      this._channel = event.channel;
      this._wireDataChannel(this._channel);
    };

    const sdpObj = decompressSDP(compressedOffer);
    await this._pc.setRemoteDescription(new RTCSessionDescription(sdpObj));
  }

  /**
   * Step 2b (Receiver): create answer after applying offer.
   * @returns {Promise<string>} compressed answer → encode into QR
   */
  async createAnswer() {
    const answer = await this._pc.createAnswer();
    await this._pc.setLocalDescription(answer);

    this._emit('state', { state: 'gathering_ice' });
    await waitForIceGathering(this._pc);

    const payload = {
      sdp: this._pc.localDescription.sdp,
      type: this._pc.localDescription.type,
    };
    this._emit('state', { state: 'answer_ready' });
    return compressSDP(payload);
  }

  // ── DataChannel wiring ─────────────────────────────────────────────────────

  _wireDataChannel(channel) {
    channel.binaryType = 'arraybuffer';

    // HIGH_WATER in transfer.js is 16 MB — set low threshold to 4 MB so the
    // sender's pump loop resumes quickly and keeps the pipe saturated.
    // This tuning is critical for hitting 50+ Mbps on a capable Wi-Fi link.
    channel.bufferedAmountLowThreshold = 4 * 1024 * 1024; // 4 MB

    channel.onopen = () => {
      this._emit('state', { state: 'connected' });
      this._emit('channel', { channel });
    };
    channel.onclose = () => this._emit('state', { state: 'closed' });
    channel.onerror = (e) => this._emit('error', { message: e.message ?? 'DataChannel error' });
  }

  // ── RTCPeerConnection listeners ────────────────────────────────────────────

  _setupPcListeners() {
    const pc = this._pc;

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this._emit('state', { state: s });
      if (s === 'failed') this._emit('error', { message: 'ICE connection failed. Ensure both devices are on the same Wi-Fi/hotspot.' });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _emit(type, detail) {
    this.dispatchEvent(Object.assign(new Event(type), detail));
  }

  close() {
    this._channel?.close();
    this._pc?.close();
  }
}
