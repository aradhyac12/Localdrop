# LocalDrop — Serverless P2P File Sharing PWA

> Zero internet. Zero servers. Pure WebRTC over local Wi-Fi.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start dev server (HTTPS required for camera + WebRTC on mobile)
npm run dev

# 3. Open on both devices (same Wi-Fi):
#    https://<your-pc-ip>:5173
#    Accept the self-signed cert warning once on each device.
```

---

## Project Structure

```
localdrop/
├── index.html                  ← Full UI (all DOM ids)
├── vite.config.js              ← Vite + PWA + HTTPS
├── package.json
└── src/
    ├── main.js                 ← Entry: registers SW
    ├── core/
    │   ├── webrtc.js           ← RTCPeerConnection, SDP compression
    │   ├── transfer.js         ← Chunking, backpressure, receive
    │   └── qr.js               ← QR render + camera scanner
    ├── ui/
    │   └── app.js              ← DOM state machine, wires everything
    └── utils/
        └── speed.js            ← Rolling-window MB/s + ETA
```

---

## How the Handshake Works (Serverless WebRTC)

```
SENDER DEVICE                        RECEIVER DEVICE
─────────────────────────────────────────────────────

1. Select files
2. Click "Generate Offer QR"
   → createOffer()
   → wait for ICE gathering (LAN candidates, ~1s)
   → lz-string compress SDP
   → render as QR code (≈900 chars after compression)

                                  3. Click "Scan Offer QR"
                                     → scan sender's QR
                                     → applyOffer(decompress)
                                     → createAnswer()
                                     → wait for ICE gathering
                                     → lz-string compress answer SDP
                                     → render as QR code

4. Click "Scan Answer QR"
   → scan receiver's QR
   → applyAnswer(decompress)
   → ICE negotiation on LAN (host candidates only)
   → RTCDataChannel opens

5. DataChannel "open" event fires
   → sendFiles() starts streaming
   → 64 KB chunks via ReadableStream
   → backpressure via bufferedAmount check
   → progress + speed updated every 400ms

                                  6. receiveFiles() accumulates chunks
                                     → Blob assembled on 'done' signal
                                     → triggerDownload() fires
                                     → file saved to Downloads
```

---

## Text Fallback (No Camera)

If camera permission is denied or device has no camera:

**Sender**: The compressed offer text appears in a textarea. Copy it.

**Receiver**: Paste into "No camera? Paste offer text here" → Apply Offer → your answer text appears → Copy it.

**Sender**: Paste into "Paste the receiver's answer text here" → Apply Answer → connection established.

The compressed SDP strings are URL-safe base64 (~800-1400 chars). They can be sent via:
- AirDrop / nearby share
- Copy-paste over local network chat
- Manual typing if very short

---

## Why No STUN/TURN?

On the same Wi-Fi/hotspot, both peers have LAN IP addresses that are directly reachable.
WebRTC ICE will discover these as **host candidates** without needing STUN (which finds
your public IP) or TURN (which relays when P2P fails).

If you ever deploy this for cross-network use, add STUN:
```js
// webrtc.js — ICE_SERVERS array
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
```

---

## Chunking & Memory (1 GB+ Files)

- Files are read via `file.stream()` → `ReadableStream` → never fully in RAM
- 64 KB chunks sent via `RTCDataChannel.send(arrayBuffer)`
- Before each send, check `channel.bufferedAmount > 8 MB` → stall
- Resume on `bufferedamountlow` event (threshold: 512 KB)
- Receiver: chunks pushed into array, `new Blob(chunks)` assembled at end (zero-copy)

---

## Production Build

```bash
npm run build     # outputs to dist/
npm run preview   # serve dist/ with HTTPS for final testing
```

For deployment on a local server (e.g. Raspberry Pi on LAN):
```bash
npx serve dist --ssl-cert cert.pem --ssl-key key.pem
```

Generate a self-signed cert:
```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/CN=localdrop.local"
```

---

## iOS Safari Notes

- Requires HTTPS (self-signed OK, accept once)
- Camera works in Safari 14.5+
- WebRTC DataChannel works in Safari 15+
- PWA install: Share → Add to Home Screen

---

## Android Chrome Notes

- Works fully with camera + WebRTC
- PWA install prompt appears after second visit
- For hotspot transfers: sender hosts hotspot, both connect to it
