# Scrypted Eufy Security Plugin — Codebase Guide

## Was dieses Plugin tut

Verbindet Eufy-Kameras **direkt** (kein eufy-security-ws, kein Docker) mit Scrypted.
Scrypted brückt dann zu HomeKit/HKSV, Google Home und HA weiter.

Zielgeräte:
- **eufyCam E330** (4K Outdoor, über HomeBase 3 S380)
- **Indoor Cam C210** (1080p PTZ, über HomeBase 3 S380)

Constraint: HomeBase 3 erlaubt **max. 1 aktiven Stream gleichzeitig**.

---

## Architektur

```
EufySecurityPlugin (plugin.ts)
  ├── IEufyClient — abstrakte Schnittstelle (types.ts)
  │     ├── DirectEufyClient   — in-process (eufy-client.ts)
  │     └── ChildProcessEufyClient — IPC-Fallback (eufy-client.ts)
  ├── StreamManager (stream-manager.ts) — HomeBase-3-Limit, Ref-Counting, Restart
  ├── EufyCamera[] (camera.ts) — Camera/VideoCamera/MotionSensor/Intercom/PTZ
  └── EufyStation[] (station.ts) — SecuritySystem (GuardMode)
```

### Crypto-Strategie (Node 18+ Problem)

Eufy P2P verwendet `RSA_PKCS1_PADDING`, das Node 18+ ablehnt.

1. **Primär**: `DirectEufyClient` mit `enableEmbeddedPKCS1Support: true`
2. **Fallback**: `ChildProcessEufyClient` spawnt `src/fallback/child-wrapper.js`
   mit `--openssl-legacy-provider` und kommuniziert via IPC (JSON).

`createEufyClient()` in `eufy-client.ts` wählt automatisch.

---

## Kritische Invarianten

### Stream-Limit
`StreamManager.requestStream()` ist **mutex-gesichert** (`requestLock`).
Nur eine physische Stream-Session läuft gleichzeitig.
Zweite Anfrage → erste wird gestoppt (500ms Pause) → zweite startet.

### Reconnect-Flow
`putSetting()` mit Credential-Keys räumt **vollständig** auf:
cameras + stations + deviceInfos + stationInfos + streamManager.destroy() + client.removeAllListeners()
Dann erst disconnect → neu connect.

### Child-Prozess-Lifecycle
- `send()` in child-wrapper.ts ist try/catch-geschützt (IPC kann zu sein)
- `process.on("disconnect")` → `process.exit(0)` (kein Zombie)
- `onChildExit()` ruft `removeAllListeners()` vor `child = undefined`
- `disconnect()` wartet bis zu 2s auf Child-Exit

### Talkback
- `active = true` wird sofort nach Guard-Check gesetzt (Race-Schutz)
- `stop()` setzt `active = false` VOR kill (Exit-Handler re-entry verhindert)
- transmitAudio-Chunks prüfen `this.ffmpeg === currentFfmpeg` nach await

---

## Build & Test

```bash
npm run build   # scrypted-webpack → dist/
npm test        # jest, 22 Tests
npm run lint    # eslint src/ + tests/
```

Node-Anforderung: `>=20`. CI testet 20.x / 22.x / 24.x.
Release baut auf Node 20.x; Tag muss package.json-Version matchen.

---

## Verbotene Dependencies

`eufy-security-ws` darf **nirgendwo** vorkommen — weder Import noch Dependency.

---

## Datei-Übersicht

| Datei | Verantwortung |
|-------|---------------|
| `src/main.ts` | Scrypted entry point (`export default EufySecurityPlugin`) |
| `src/plugin.ts` | DeviceProvider, Settings, Reconnect-Backoff, Discovery |
| `src/eufy-client.ts` | DirectEufyClient + ChildProcessEufyClient + Factory |
| `src/stream-manager.ts` | Mutex, Ref-Counting, Restart (max 3×), Cleanup-Timer |
| `src/camera.ts` | getVideoStream (TCP-Hosting), takePicture, MotionSensor, Intercom |
| `src/station.ts` | SecuritySystem / GuardMode |
| `src/talkback.ts` | FFmpeg → PCM → transmitAudio Loop |
| `src/ptz.ts` | PanTiltZoom Directions, per-Move Error-Handling |
| `src/types.ts` | IEufyClient Interface, alle shared Types |
| `src/utils.ts` | Logger, withTimeout, delay, makeRequestId |
| `src/fallback/child-wrapper.ts` | eufy-security-client in legacy Node |
| `src/fallback/ipc-protocol.ts` | ParentMessage / ChildMessage Union-Types |

---

## Bekannte Hardware-Einschränkungen

- HomeBase 3: nur 1 Stream gleichzeitig (StreamManager.enforceSingleStream)
- RTSP auf HomeBase 3 seit Firmware März 2026 defekt → nur P2P
- P2P-Verbindungsaufbau: 3–10s normal
