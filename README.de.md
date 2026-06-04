# Scrypted Eufy Security Plugin

[English](README.md) | **Deutsch**

Direkte [`eufy-security-client`](https://github.com/bropat/eufy-security-client)
Integration für [Scrypted](https://www.scrypted.app/) — ohne WebSocket-Bridge, ohne Middleware,
ohne Docker, ohne Home Assistant. Das Plugin spricht P2P direkt mit deiner HomeBase aus dem
Scrypted-Prozess und lässt Scrypted deine Kameras zu HomeKit (inkl. HomeKit Secure Video),
Google Home und Home Assistant bridgen.

## Features

- ✅ Direkte `eufy-security-client` Integration — keine Middleware, kein externer Prozess
- ✅ Eufy HomeBase 3 (S380) Unterstützung
- ✅ HomeKit Secure Video (HKSV) über das Scrypted HomeKit Plugin
- ✅ P2P Live-Streaming (H.264 / H.265)
- ✅ Bewegungserkennung (Person, Tier, Fahrzeug, Sound)
- ✅ Bidirektionales Audio / Talkback
- ✅ PTZ Pan/Tilt für Indoor Cam C210
- ✅ Guard Mode (Weg / Zuhause / Aus)
- ✅ Automatischer Reconnect mit exponentiellem Backoff
- ✅ Node.js 18+ kompatibel (via `enableEmbeddedPKCS1Support`)
- ✅ Fallback auf Legacy-Crypto Child-Process bei Bedarf
- ⚠️ HomeBase 3: max. 1 Stream gleichzeitig (Hardware-Limitierung)

## Voraussetzungen

1. Scrypted (Docker, Home Assistant Add-on oder nativ)
2. Scrypted HomeKit Plugin (für HomeKit Secure Video)
3. Eufy-Account Zugangsdaten
4. Nichts weiter — das Plugin ist selbstständig

## Installation

In Scrypted: **Plugin Store → nach „Eufy Security" suchen → Installieren**.
Gib deine Zugangsdaten in den Settings ein → Geräte werden automatisch erkannt.

## HomeKit einrichten

1. Installiere das Plugin und lasse es deine Kameras entdecken.
2. Öffne in Scrypted eine Kamera → **HomeKit → „Zu HomeKit hinzufügen"**.
3. Scanne den QR-Code in der Apple Home App.
4. HKSV aktiviert sich automatisch, wenn du einen iCloud Plan hast (Home 50 GB+).

## Bekannte Einschränkungen

- **HomeBase 3:** Es kann nur eine Kamera gleichzeitig streamen (Eufy Hardware-Limitierung).
- **RTSP** direkter Zugriff auf HomeBase 3 ist seit Firmware März 2026 defekt — das Plugin
  umgeht dies durch direktes P2P.
- **Stream-Start** dauert 3–10 Sekunden (P2P-Verbindungsaufbau zur HomeBase).

## Crypto-Kompatibilität (Node.js 18+)

Eufy-Geräte verwenden `RSA_PKCS1_PADDING` im P2P-Protokoll, das Node.js 18+ standardmäßig
ablehnt (CVE-2023-46809). Das Plugin handhabt dies in zwei Stufen:

1. **Primär:** `EufySecurity.initialize({ enableEmbeddedPKCS1Support: true })` —
   P2P läuft nativ im Scrypted Node-Prozess.
2. **Fallback:** ein automatischer Child-Process mit `--openssl-legacy-provider`,
   wird ausgelöst sobald ein Crypto-Fehler erkannt wird. Vollständig im Plugin
   enthalten — kein externer Download.

## Architektur

```
Scrypted Prozess
  EufySecurityPlugin (DeviceProvider, Settings, DeviceDiscovery)
    ├── EufyClient    (DirectEufyClient | ChildProcessEufyClient)
    ├── StreamManager (Session-Lifecycle, HomeBase 3 Limit)
    ├── EufyCamera[]  (Camera, VideoCamera, MotionSensor, Intercom, [PanTiltZoom])
    └── EufyStation[] (SecuritySystem)
```

## Entwicklung

```bash
npm ci
npm run lint
npm run build
npm test
```

## Lizenz

Apache-2.0
