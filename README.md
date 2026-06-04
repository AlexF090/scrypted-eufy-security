# Scrypted Eufy Security Plugin

**English** | [Deutsch](README.de.md)

Direct [`eufy-security-client`](https://github.com/bropat/eufy-security-client)
integration for [Scrypted](https://www.scrypted.app/) — no WebSocket bridge, no
middleware, no Docker, no Home Assistant. The plugin talks P2P to your HomeBase
directly from the Scrypted process and lets Scrypted bridge your cameras to
HomeKit (including HomeKit Secure Video), Google Home and Home Assistant.

## Features

- ✅ Direct `eufy-security-client` integration — no middleware, no external process
- ✅ Eufy HomeBase 3 (S380) support
- ✅ HomeKit Secure Video (HKSV) via the Scrypted HomeKit plugin
- ✅ P2P livestreaming (H.264 / H.265)
- ✅ Motion detection (person, pet, vehicle, sound)
- ✅ Two-way audio / talkback
- ✅ PTZ pan/tilt for the Indoor Cam C210
- ✅ Guard Mode (Away / Home / Off)
- ✅ Automatic reconnect with exponential backoff
- ✅ Node.js 18+ compatible (via `enableEmbeddedPKCS1Support`)
- ✅ Falls back to a legacy-crypto child process when needed
- ⚠️ HomeBase 3: max. 1 stream at a time (hardware limitation)

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

## Known Limitations

- **HomeBase 3:** only one camera can stream at a time (Eufy hardware limit).
- **RTSP** direct access to HomeBase 3 has been broken since the March 2026
  firmware — the plugin works around it by using P2P directly.
- **Stream start** takes 3–10 seconds (P2P connection setup to the HomeBase).

## Crypto Compatibility (Node.js 18+)

Eufy devices use `RSA_PKCS1_PADDING` in the P2P protocol, which Node.js 18+
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
    ├── StreamManager (session lifecycle, HomeBase 3 limit)
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
