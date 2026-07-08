# Scrypted Eufy Security Plugin

**English** | [Deutsch](README.de.md)

Direct [`eufy-security-client`](https://github.com/bropat/eufy-security-client)
integration for [Scrypted](https://www.scrypted.app/) — no WebSocket bridge, no
middleware, no Docker, no Home Assistant. The plugin talks P2P to your HomeBase
directly from the Scrypted process and lets Scrypted bridge your cameras to
HomeKit (including HomeKit Secure Video), Google Home and Home Assistant.

## Features

- ✅ Direct `eufy-security-client` integration — no middleware, no external process
- ✅ Eufy HomeBase 2/3 support
- ✅ HomeKit Secure Video (HKSV) via the Scrypted HomeKit plugin
- ✅ P2P livestreaming (H.264 / H.265)
- ✅ Motion detection (person, pet, vehicle, sound)
- ✅ Two-way audio / talkback
- ✅ PTZ pan/tilt for the Indoor Cam C210
- ✅ Guard Mode (Away / Home / Off)
- ✅ Automatic reconnect with exponential backoff
- ✅ Node.js 20+ compatible (via `enableEmbeddedPKCS1Support`)
- ✅ Falls back to a legacy-crypto child process when needed
- ⚠️ HomeBase 2/older and HomeBase 3: max. 1 stream at a time

## Requirements

1. Scrypted (Docker, Home Assistant add-on, or native)
2. Scrypted HomeKit plugin (for HomeKit Secure Video)
3. Eufy account credentials
4. Nothing else — the plugin is self-contained

## Installation

In Scrypted: **Plugin Store → search "Eufy Security" → Install**.
Enter your credentials in Settings → devices are discovered automatically.

## HomeKit Setup

1. Install the plugin and let it discover your cameras.
2. In Scrypted, open a camera → **HomeKit → "Add to HomeKit"**.
3. Scan the QR code in the Apple Home app.
4. HKSV activates automatically if you have an iCloud plan (Home 50 GB+).

## Streaming & Prebuffer (Single-Stream HomeBases)

HomeBase 2/older and HomeBase 3 allow **only one active camera stream at a
time**. The plugin therefore disables Scrypted's automatic prebuffering for all
cameras by default — prebuffering every camera would require one permanent
stream per camera, which the hardware cannot do (and previously caused an
endless stream pre-emption loop on startup).

- **Prebuffer camera** (plugin setting): pick the single camera that keeps a
  permanent prebuffer stream. That camera gets an instant live view and HKSV
  pre-roll footage. After changing the setting, restart the Rebroadcast
  plugin so it re-evaluates its prebuffer defaults.
- All other cameras stream **on demand**: opening their live view takes the
  3–10 s P2P connection setup and temporarily pre-empts the prebuffer
  camera's stream. The prebuffer camera reclaims the slot automatically once
  the live view is closed.

## Known Limitations

- **HomeBase 2/older and HomeBase 3:** only one camera can stream at a time.
- **RTSP** direct access to HomeBase 3 has been broken since the March 2026
  firmware — the plugin works around it by using P2P directly.
- **Stream start** takes 3–40 seconds depending on station wake-up and P2P
  connection setup.
- **HKSV pre-roll** is only available for the selected prebuffer camera;
  recordings from other cameras start at the motion event.

## Crypto Compatibility (Node.js 20+)

Eufy devices use `RSA_PKCS1_PADDING` in the P2P protocol, which Node.js 20+
rejects by default (CVE-2023-46809). The plugin handles this in two stages:

1. **Primary:** `EufySecurity.initialize({ enableEmbeddedPKCS1Support: true })` —
   P2P runs natively inside the Scrypted Node process.
2. **Fallback:** an automatic child process with `--openssl-legacy-provider`,
   triggered as soon as a crypto error is detected. Fully bundled with the
   plugin — no external download.

## Architecture

```
Scrypted Process
  EufySecurityPlugin (DeviceProvider, Settings, DeviceDiscovery)
    ├── EufyClient    (DirectEufyClient | ChildProcessEufyClient)
    ├── StreamManager (session lifecycle, HomeBase single-stream limit)
    ├── EufyCamera[]  (Camera, VideoCamera, MotionSensor, Intercom, [PanTiltZoom])
    └── EufyStation[] (SecuritySystem)
```

## Development

```bash
npm ci
npm run lint
npm run build
npm test
```

## License

Apache-2.0
