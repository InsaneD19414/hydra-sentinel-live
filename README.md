# H.A.I.L. Sentinel v2.0

Private peer-to-peer camera stations from your own iPhones and iPads. Installable web app (PWA), no App Store.

Live: https://insaned19414.github.io/hydra-sentinel-live/

Video goes device to device over encrypted WebRTC (DTLS-SRTP). Nothing is uploaded. The PeerJS broker only introduces devices.

## What's new in 2.0
- **One-tap pairing:** QR code (iPhone Camera app opens it), a 6-character typed code (`K7Q-4MZ`), or a share/copy link. Approving on the camera starts it right away, and the viewer opens the live feed by itself. Devices remember each other.
- **Connectivity:** never-ending auto-reconnect with backoff (1 s, 2 s, 4 s … capped at 30 s, with jitter). It reconnects immediately on `online`, `visibilitychange` and `pageshow`. A 2 s heartbeat runs over the data channel. ICE restart recovers network changes without dropping the session. There are 4 public Google STUN servers, and the broker socket heals itself. Optional user-supplied TURN.
- **Status:** LIVE (crimson neon, only when frames arrived in the last 3 s), STALE, CONNECTING and OFFLINE per feed, with round-trip time, last-frame age and fps.
- **Monitor grid:** all cameras at once (phone: 1 column, iPad: 2–3). Tap for fullscreen with record, listen, talk and flip. Each tile has Connect and Disconnect.
- **Alerts:** camera-offline alert (on by default) and optional motion alert, with sound and vibration (vibration only where the browser supports it; not on iOS).
- **Keep screen awake:** Screen Wake Lock API, re-acquired after the app is hidden. Silent looping-video fallback for older iOS. Toggle and state shown everywhere you monitor.
- **Guard mode:** a black or dim touch-blocking overlay. Streams and wake lock keep running. Unlock by press-and-hold for 2 s, or with an optional PIN (stored only as a salted SHA-256 hash).

## Run locally
Serve this folder over HTTPS or on `localhost` (secure context needed for camera, service worker and Wake Lock):
```
python3 -m http.server 8765    # http://127.0.0.1:8765
```

## Deploy
GitHub Pages serves `main` / root. Bump `VERSION` in `sw.js` on every release so installed Home Screen copies update.

## Licenses
The vendored libraries and their licenses are in `vendor/`. The fonts Cinzel, Rajdhani, Inter and Share Tech Mono are under the SIL Open Font License 1.1.
