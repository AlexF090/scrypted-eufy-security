# Scrypted Eufy Security Plugin

Direct [`eufy-security-client`](https://github.com/bropat/eufy-security-client)
integration for [Scrypted](https://www.scrypted.app/) — no WebSocket bridge, no
middleware, no Docker, no Home Assistant. The plugin talks P2P to your HomeBase
directly from the Scrypted process and lets Scrypted bridge your cameras to
HomeKit (incl. HomeKit Secure Video), Google Home and Home Assistant.

## Features

- ✅ Direkte eufy-security-client Integration — keine Middleware, kein externer Prozess
- ✅ Eufy HomeBase 3 (S380) Unterstützung
- ✅ HomeKit Secure Video (HKSV) via Scrypted HomeKit Plugin
- ✅ P2P Livestreaming (H.264/H.265)
- ✅ Bewegungserkennung (Person, Tier, Fahrzeug, Sound)
- ✅ Two-Way Audio / Talkback
- ✅ PTZ Pan/Tilt für Indoor Cam C210
- ✅ Guard Mode (Weg / Zuhause / Aus)
- ✅ Automatischer Reconnect mit Exponential Backoff
- ✅ Node.js 18+ kompatibel (via enableEmbeddedPKCS1Support)
- ✅ Fallback auf Legacy-Crypto Child-Process wenn nötig
- ⚠️ HomeBase 3: Max. 1 Stream gleichzeitig (Hardware-Limitierung)

## Voraussetzungen

1. Scrypted (Docker, HA Add-on, oder nativ)
2. Scrypted HomeKit Plugin (für HomeKit Secure Video)
3. Eufy-Account Credentials
4. Kein weiteres Tool nötig — Plugin ist self-contained

## Installation

In Scrypted: Plugin Store → "Eufy Security" suchen → Installieren.
Zugangsdaten in Settings eintragen → Geräte werden automatisch erkannt.

## HomeKit einrichten

1. Plugin installiert, Kameras erkannt
2. Kamera in Scrypted → HomeKit → "Zu HomeKit hinzufügen"
3. QR-Code in Apple Home App scannen
4. HKSV ist automatisch aktiv wenn iCloud-Plan vorhanden (Home 50GB+)

## Bekannte Einschränkungen

- HomeBase 3: Nur 1 Kamera gleichzeitig streambar (Eufy Hardware-Limit)
- RTSP-Direktzugriff auf HomeBase 3 seit Firmware März 2026 defekt
  (wird umgangen: Plugin nutzt P2P direkt)
- Stream-Start: 3–10 Sekunden (P2P-Verbindungsaufbau zur HomeBase)

## Crypto-Kompatibilität (Node.js 18+)

Eufy-Geräte verwenden `RSA_PKCS1_PADDING` im P2P-Protokoll, das Node.js 18+
standardmäßig ablehnt (CVE-2023-46809). Das Plugin geht in dieser Reihenfolge
vor:

1. **Primär:** `EufySecurity.initialize({ enableEmbeddedPKCS1Support: true })` —
   P2P läuft nativ im Node-Prozess von Scrypted.
2. **Fallback:** Automatischer Child-Process mit `--openssl-legacy-provider`,
   sobald ein Crypto-Fehler erkannt wird. Vollständig im Plugin enthalten, kein
   externer Download.

## Architektur

```
Scrypted Process
  EufySecurityPlugin (DeviceProvider, Settings, DeviceDiscovery)
    ├── EufyClient   (DirectEufyClient | ChildProcessEufyClient)
    ├── StreamManager (Session-Lifecycle, HomeBase-3-Limit)
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
