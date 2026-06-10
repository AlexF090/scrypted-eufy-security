# Projekt-Prompt: Scrypted Eufy Security Plugin

> **Verwendung:** Diesen Prompt vollständig in eine neue Claude-Konversation oder Claude Code einfügen.
> Das Modell soll daraufhin das komplette, produktionsreife GitHub-Repository generieren —
> alle Dateien, vollständiger Code, keine Platzhalter, keine TODOs.

---

## 1. Projektauftrag & Ziel

Erstelle ein vollständiges, produktionsreifes **Scrypted-Plugin** in TypeScript.

Das Plugin verbindet Eufy-Security-Kameras **direkt über `eufy-security-client`** (npm-Paket) mit Scrypted.
Scrypted übernimmt danach automatisch die Brücke zu HomeKit (über das bereits vorhandene HomeKit-Plugin),
Google Home und Home Assistant. Das Plugin selbst hat **keine externe Prozess-Abhängigkeit** —
weder eufy-security-ws noch Docker noch Home Assistant.

**Einzige npm-Dependency:** `eufy-security-client` (bropat, aktiv gewartet, ~3.7.x)

**Primäre Zielgeräte:**

- `eufyCam E330 (Professional)` — kabelgebunden, 4K, Outdoor, läuft über HomeBase 3 (S380)
- `Indoor Cam C210` — kabelgebunden, 1080p, 360° PTZ Pan/Tilt, läuft über HomeBase 3 (S380)

**Rahmenbedingungen:**

- HomeBase 3 (S380) ist vorhanden, beide Kameras darin registriert
- HomeBase 3 hat kein natives HomeKit — Scrypted ist der einzige HomeKit-Weg
- RTSP auf HomeBase 3 ist seit Firmware März 2026 defekt → nur P2P-Streaming
- HomeBase 3 erlaubt nur **eine aktive Stream-Session gleichzeitig**
- Kein HA, kein Docker, kein externer Prozess — das Plugin läuft rein in Scrypted

---

## 2. Das Node.js-Crypto-Problem & Lösungsstrategie

Eufy-Geräte verwenden `RSA_PKCS1_PADDING` im P2P-Protokoll,
das Node.js 18+ standardmäßig ablehnt (CVE-2023-46809).

`eufy-security-client` hat dafür die Option `enableEmbeddedPKCS1Support: true` eingebaut.
Diese aktiviert intern `--openssl-legacy-provider` via `crypto.setFips(false)` und
embedded OpenSSL-Patches, ohne einen separaten Prozess zu benötigen.

**Strategie im Plugin (in dieser Reihenfolge):**

```
1. Primär: EufySecurity.initialize({ enableEmbeddedPKCS1Support: true, ... })
           → Wenn erfolgreich: P2P funktioniert nativ in Scrypted's Node-Prozess

2. Fallback: Child-Process mit Node 16 + --openssl-legacy-provider
             → Nur wenn Primär-Ansatz mit CryptoError fehlschlägt
             → Child-Process führt minimalen eufy-security-client-Wrapper aus
             → Kommunikation mit Parent via IPC (JSON-Messages)
             → Dieser Fallback ist vollständig im Plugin enthalten, kein externer Download
```

Der Fallback-Child-Process-Code muss ebenfalls vollständig im Repository enthalten sein
(`src/fallback/child-wrapper.ts` + Build-Script).

---

## 3. Architektur

```
┌─────────────────────────────────────────────────────────────┐
│                    Scrypted Process                          │
│                                                             │
│  EufySecurityPlugin  (ScryptedDeviceBase + DeviceProvider)  │
│    │                                                         │
│    ├── EufyClient  (Wrapper um eufy-security-client)        │
│    │     ├── Primär: EufySecurity direkt (Node 18+)         │
│    │     └── Fallback: ChildProcess IPC  (Node 16)          │
│    │                                                         │
│    ├── EufyCamera[]  (pro Kamera eine Instanz)              │
│    │     implements: Camera, VideoCamera, MotionSensor,      │
│    │                 Intercom, VideoCameraConfiguration      │
│    │     + PanTiltZoom  (nur für C210 / PT-Kameras)         │
│    │                                                         │
│    └── EufyStation[]  (pro HomeBase eine Instanz)           │
│          implements: SecuritySystem                          │
│                                                             │
│  StreamManager  (Session-Lifecycle, HomeBase-3-Limit)       │
└─────────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
   HomeKit Plugin        NVR Plugin
   (HKSV-fähig)         (HA-Integration)
```

---

## 4. eufy-security-client TypeScript API — vollständige Referenz

### 4.1 Initialisierung

```typescript
import { EufySecurity, EufySecurityConfig } from "eufy-security-client";

const config: EufySecurityConfig = {
  username: string, // Eufy-Account E-Mail
  password: string, // Eufy-Account Passwort
  country: string, // z.B. "DE" — muss mit App-Einstellung übereinstimmen
  language: string, // z.B. "de"
  persistentDir: string, // Pfad für Token/Session-Persistenz (Scrypted storage dir)
  enableEmbeddedPKCS1Support: true, // KRITISCH: Node.js 18+ Crypto-Kompatibilität
  trustedDeviceName: string, // Label in Eufy-App (z.B. "scrypted-plugin")
  eventDurationSeconds: number, // Sekunden bis Motion-Event zurückgesetzt (default: 10)
  p2pConnectionSetupTimeout: number, // P2P Verbindungs-Timeout ms (default: 120000)
};

const client = await EufySecurity.initialize(config);
await client.connect();
```

### 4.2 2FA & CAPTCHA Handling

```typescript
// 2FA Event — Plugin muss in der Scrypted-UI danach fragen
client.on("tfa request", async () => {
  const code = await promptUserForTFACode(); // via Scrypted Settings
  await client.connect({ verifyCode: code });
});

// CAPTCHA Event
client.on("captcha request", async (id: string, captcha: string) => {
  // captcha ist Base64-PNG
  const answer = await promptUserForCaptcha(id, captcha);
  await client.connect({ captchaId: id, captcha: answer });
});
```

### 4.3 Geräte & Stationen abrufen

```typescript
// Alle Stationen (HomeBases)
const stations = await client.getStations(); // Station[]
const station = await client.getStation(serialNumber); // Station

// Alle Kameras/Geräte
const devices = await client.getDevices(); // Device[]
const device = await client.getDevice(serialNumber); // Device

// Geräte einer Station
const devicesOfStation = await client.getStationDevices(stationSerial); // Device[]

// Typ-Checks (statische Methoden)
Device.isCamera(device); // boolean
Device.isIndoorCamera(device); // boolean
Device.isOutdoorCamera(device); // boolean
Device.hasPanAndTilt(device); // boolean → C210 erkennen
Device.hasIntercom(device); // boolean → Two-Way Audio
Device.isStation(station); // boolean
```

### 4.4 Livestream starten/stoppen

```typescript
// Starten (via Station, nicht Device direkt)
await client.startStationLivestream(deviceSerial);

// Stoppen
await client.stopStationLivestream(deviceSerial);

// Status prüfen
const isStreaming = await client.isStationLiveStreaming(deviceSerial);
```

### 4.5 Streaming Events (wichtigste Events des Clients)

```typescript
// Stream-Daten kommen als Buffer-Events:
client.on('station livestream start',
  (station: Station, device: Device, metadata: StreamMetadata,
   videoStream: Readable, audioStream: Readable) => {
    // videoStream: rohe H.264/H.265 Annexb-Frames
    // audioStream: AAC oder PCM Audio
    // metadata: { videoCodec, audioCodec, videoFPS, videoWidth, videoHeight }
    // → FFmpeg oder go2rtc damit füttern
});

client.on('station livestream stop',
  (station: Station, device: Device) => { ... });

// Snapshot (Thumbnail)
client.on('device thumbnail url',
  (device: Device, url: string) => { ... });
```

### 4.6 Bewegungserkennung Events

```typescript
client.on('device motion detected',
  (device: Device, state: boolean) => { motionDetected = state; });

client.on('device person detected',
  (device: Device, state: boolean, person?: string) => { ... });

client.on('device pet detected',
  (device: Device, state: boolean) => { ... });

client.on('device vehicle detected',
  (device: Device, state: boolean) => { ... });

client.on('device sound detected',
  (device: Device, state: boolean) => { ... });

client.on('device crying detected',
  (device: Device, state: boolean) => { ... });
```

### 4.7 PTZ — Pan & Tilt (für C210)

```typescript
import { PanTiltDirection } from "eufy-security-client";

// Nur aufrufen wenn Device.hasPanAndTilt(device) === true
await client.panAndTilt(deviceSerial, PanTiltDirection.LEFT); // = 1
await client.panAndTilt(deviceSerial, PanTiltDirection.RIGHT); // = 2
await client.panAndTilt(deviceSerial, PanTiltDirection.UP); // = 3
await client.panAndTilt(deviceSerial, PanTiltDirection.DOWN); // = 4

await client.rotate360(deviceSerial); // 360° Scan
```

### 4.8 Two-Way Audio / Talkback

```typescript
// Starten (nur wenn device.hasIntercom() === true)
await client.startStationTalkback(deviceSerial);

client.on("station talkback start", (station: Station, device: Device) => {
  // Jetzt Audio senden:
  await client.transmitStationTalkbackAudio(deviceSerial, pcmBuffer);
});

// Stoppen
await client.stopStationTalkback(deviceSerial);
```

### 4.9 Station Guard Mode

```typescript
import { GuardMode } from 'eufy-security-client';

await client.setStationGuardMode(stationSerial, GuardMode.AWAY);     // 0
await client.setStationGuardMode(stationSerial, GuardMode.HOME);     // 1
await client.setStationGuardMode(stationSerial, GuardMode.SCHEDULE); // 2
await client.setStationGuardMode(stationSerial, GuardMode.CUSTOM1);  // 3
await client.setStationGuardMode(stationSerial, GuardMode.OFF);      // 6

client.on('station guard mode', (station: Station, guardMode: GuardMode) => { ... });
client.on('station current mode', (station: Station, currentMode: number) => { ... });
```

### 4.10 Device Properties setzen

```typescript
import { PropertyName } from "eufy-security-client";

// Motion Detection ein/aus
await client.setDeviceMotionDetection(deviceSerial, true);

// Status-LED
await client.setDeviceStatusLed(deviceSerial, false);

// Nacht-Vision automatisch
await client.setDeviceAutoNightVision(deviceSerial, true);

// Snapshot anfordern
await client.triggerStationAlarm(stationSerial, 2); // 2 Sekunden Alarm

// Oder direkt Property setzen
await client.setDeviceProperty(
  deviceSerial,
  PropertyName.DeviceMotionDetection,
  true,
);
```

### 4.11 Verbindungs-Events

```typescript
client.on('connect', () => { /* Cloud-Verbindung hergestellt */ });
client.on('close', () => { /* Verbindung getrennt → Reconnect starten */ });
client.on('push connect', () => { /* Push-Notifications aktiv */ });
client.on('push close', () => { /* Push-Notifications inaktiv */ });

// Station P2P-Verbindung
client.on('station connect', (station: Station) => { ... });
client.on('station close', (station: Station) => { ... });

// Geräte-Änderungen (Hot-Plug)
client.on('device added', (device: Device) => { ... });
client.on('device removed', (device: Device) => { ... });
client.on('station added', (station: Station) => { ... });
```

### 4.12 Fehler-Events

```typescript
client.on('device livestream error',
  (device: Device, error: Error) => { ... });

client.on('station livestream error',
  (station: Station, device: Device, error: Error) => { ... });

// P2P Timeout etc. kommen als Error-Events oder via rejected Promises
```

---

## 5. Repository-Struktur

Erzeuge exakt diese Dateistruktur, alle Dateien vollständig implementiert:

```
scrypted-eufy-security/
├── package.json
├── tsconfig.json
├── .eslintrc.json
├── .gitignore
├── .github/
│   └── workflows/
│       ├── ci.yml            # Build + Test bei jedem Push/PR
│       └── release.yml       # NPM publish bei Tag v*.*.*
├── src/
│   ├── main.ts               # Plugin-Einstiegspunkt (export default)
│   ├── plugin.ts             # EufySecurityPlugin Hauptklasse
│   ├── eufy-client.ts        # Wrapper: Primär (direct) + Fallback (IPC)
│   ├── camera.ts             # EufyCamera Device
│   ├── station.ts            # EufyStation Device
│   ├── stream-manager.ts     # Stream Lifecycle, HomeBase-3-Limit
│   ├── ptz.ts                # Pan/Tilt Mixin für C210
│   ├── talkback.ts           # Two-Way Audio
│   ├── types.ts              # Interne Interfaces
│   ├── utils.ts              # Logger, Helpers
│   └── fallback/
│       ├── child-wrapper.ts  # eufy-security-client in Node16 Child-Process
│       └── ipc-protocol.ts   # IPC Message Types (Parent ↔ Child)
├── tests/
│   ├── eufy-client.test.ts
│   ├── stream-manager.test.ts
│   └── plugin.test.ts
├── README.md
├── CHANGELOG.md
└── LICENSE                   # Apache-2.0
```

---

## 6. Implementierungsanforderungen pro Datei

### 6.1 `package.json`

```json
{
  "name": "scrypted-eufy-security",
  "version": "1.0.0",
  "description": "Eufy Security plugin for Scrypted — direct eufy-security-client integration",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc",
    "test": "jest --passWithNoTests",
    "lint": "eslint 'src/**/*.ts'",
    "prepublishOnly": "npm run build && npm test"
  },
  "scrypted": {
    "name": "Eufy Security",
    "interfaces": ["Settings"],
    "deviceCreator": "EufySecurityPlugin"
  },
  "keywords": ["scrypted", "eufy", "homekit", "hksv", "camera", "homebase"],
  "license": "Apache-2.0",
  "peerDependencies": {
    "@scrypted/sdk": "*"
  },
  "dependencies": {
    "eufy-security-client": "^3.7.0"
  },
  "devDependencies": {
    "@scrypted/sdk": "latest",
    "typescript": "^5.4.0",
    "jest": "^29.0.0",
    "@types/jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^8.0.0"
  }
}
```

### 6.2 `src/eufy-client.ts` — Adapter-Schicht

Diese Klasse abstrahiert den Unterschied zwischen Primär- und Fallback-Ansatz.
Beide Varianten müssen dasselbe Interface `IEufyClient` implementieren.

```typescript
interface IEufyClient extends EventEmitter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStations(): Promise<StationInfo[]>;
  getDevices(): Promise<DeviceInfo[]>;
  startLivestream(deviceSerial: string): Promise<void>;
  stopLivestream(deviceSerial: string): Promise<void>;
  isLiveStreaming(deviceSerial: string): Promise<boolean>;
  panAndTilt(deviceSerial: string, direction: PanTiltDirection): Promise<void>;
  rotate360(deviceSerial: string): Promise<void>;
  startTalkback(deviceSerial: string): Promise<void>;
  stopTalkback(deviceSerial: string): Promise<void>;
  transmitAudio(deviceSerial: string, buffer: Buffer): Promise<void>;
  setGuardMode(stationSerial: string, mode: number): Promise<void>;
  setDeviceProperty(
    serial: string,
    name: string,
    value: unknown,
  ): Promise<void>;
  triggerSnapshot(deviceSerial: string): Promise<void>;
}
```

**Primär-Implementierung (`DirectEufyClient`):**

- Instanziiert `EufySecurity` mit `enableEmbeddedPKCS1Support: true`
- Fängt `Error` mit `code === 'ERR_OSSL_EVP_UNSUPPORTED'` oder ähnlichem
- Wenn Crypto-Fehler → wirft `EufyCryptoError` für Fallback-Signal

**Fallback-Implementierung (`ChildProcessEufyClient`):**

- Spawnt `child-wrapper.js` mit `node --openssl-legacy-provider`
- Kommunikation via `process.send` / `process.on('message')` (IPC JSON)
- Selbe Methoden, aber als IPC-Aufrufe serialisiert
- Streaming-Daten werden als Buffer via IPC übertragen (chunked Base64)

**Factory-Funktion:**

```typescript
async function createEufyClient(
  config: EufyPluginConfig,
): Promise<IEufyClient> {
  try {
    const client = new DirectEufyClient(config);
    await client.connect();
    return client;
  } catch (err) {
    if (err instanceof EufyCryptoError) {
      console.warn(
        "[EufyPlugin] PKCS1 not supported natively, using child process fallback",
      );
      const fallback = new ChildProcessEufyClient(config);
      await fallback.connect();
      return fallback;
    }
    throw err;
  }
}
```

### 6.3 `src/fallback/ipc-protocol.ts` — IPC Message Types

```typescript
// Parent → Child
type ParentMessage =
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "startLivestream"; deviceSerial: string }
  | { type: "stopLivestream"; deviceSerial: string }
  | { type: "panAndTilt"; deviceSerial: string; direction: number }
  | { type: "rotate360"; deviceSerial: string }
  | { type: "startTalkback"; deviceSerial: string }
  | { type: "stopTalkback"; deviceSerial: string }
  | { type: "transmitAudio"; deviceSerial: string; bufferB64: string }
  | { type: "setGuardMode"; stationSerial: string; mode: number }
  | { type: "setProperty"; serial: string; name: string; value: unknown }
  | { type: "triggerSnapshot"; deviceSerial: string }
  | { type: "getStations" }
  | { type: "getDevices" };

// Child → Parent
type ChildMessage =
  | { type: "ready" }
  | { type: "error"; message: string; code?: string }
  | { type: "result"; requestType: string; payload: unknown }
  | { type: "event:motionDetected"; deviceSerial: string; state: boolean }
  | { type: "event:personDetected"; deviceSerial: string; state: boolean }
  | { type: "event:petDetected"; deviceSerial: string; state: boolean }
  | { type: "event:vehicleDetected"; deviceSerial: string; state: boolean }
  | {
      type: "event:livestreamStart";
      deviceSerial: string;
      metadata: StreamMetadata;
    }
  | {
      type: "event:livestreamVideoChunk";
      deviceSerial: string;
      chunkB64: string;
    }
  | {
      type: "event:livestreamAudioChunk";
      deviceSerial: string;
      chunkB64: string;
    }
  | { type: "event:livestreamStop"; deviceSerial: string }
  | { type: "event:thumbnailUrl"; deviceSerial: string; url: string }
  | { type: "event:guardMode"; stationSerial: string; mode: number }
  | { type: "event:stationAdded"; station: StationInfo }
  | { type: "event:deviceAdded"; device: DeviceInfo }
  | { type: "event:connected" }
  | { type: "event:disconnected" }
  | { type: "tfa_request" }
  | { type: "captcha_request"; captchaId: string; captchaB64: string };
```

### 6.4 `src/stream-manager.ts` — Stream Lifecycle

Kritische Anforderungen:

- **HomeBase-3-Limitierung:** Es darf nur eine `startLivestream`-Session gleichzeitig laufen.
  Kommt eine zweite Anfrage, wird die erste gestoppt (500ms Warte-Zeit), dann neue gestartet.
- **Session Reuse:** Mehrere Scrypted-Konsumenten (HomeKit + HA gleichzeitig) teilen
  eine physische Stream-Session. Referenzzähler.
- **Auto-Cleanup:** Nach 0 Konsumenten → Stream nach 30s stoppen (Grace Period).
- **Stream-Timeout:** `startLivestream` bekommt 20s um das `livestreamStart`-Event
  zu produzieren, sonst Error.
- **Reconnect:** `livestreamStop`-Event während aktiver Konsumenten → automatisch neu starten.

```typescript
class StreamManager {
  async requestStream(deviceSerial: string): Promise<StreamSession>;
  async releaseStream(deviceSerial: string, consumerId: string): Promise<void>;
  private async startPhysicalStream(deviceSerial: string): Promise<void>;
  private async stopPhysicalStream(deviceSerial: string): Promise<void>;
}

interface StreamSession {
  deviceSerial: string;
  videoStream: Readable; // H.264/H.265 Annexb
  audioStream: Readable; // AAC/PCM
  metadata: StreamMetadata;
  consumerId: string;
  release: () => void; // Shortcut für releaseStream
}
```

### 6.5 `src/camera.ts` — EufyCamera

Implementiere `EufyCamera extends ScryptedDeviceBase` mit:

**`Camera` Interface:**

```typescript
async takePicture(options?: PictureOptions): Promise<MediaObject>
// → client.triggerSnapshot(serial)
// → auf 'device thumbnail url' Event warten (5s Timeout)
// → URL via mediaManager.createMediaObjectFromUrl zurückgeben
```

**`VideoCamera` Interface:**

```typescript
async getVideoStream(options?: MediaStreamOptions): Promise<MediaObject>
// → streamManager.requestStream(serial)
// → StreamSession.videoStream + audioStream via FFmpeg zu RTSP
// → RTSP-URL als MediaObject zurückgeben (MediaStreamUrl)

async getVideoStreamOptions(): Promise<MediaStreamOptions[]>
// → Statisch deklarieren: H264, mit Audio
// → E330 hint: 4K (3840x2160), C210 hint: 1080p (1920x1080)
```

**`MotionSensor` Interface:**

```typescript
motionDetected: boolean;
// Wird gesetzt durch: motionDetected, personDetected, petDetected, vehicleDetected
// Auto-Reset nach config.eventDurationSeconds
```

**`Intercom` Interface:**

```typescript
async startIntercom(media: MediaObject): Promise<void>
// → client.startTalkback(serial)
// → Audio aus MediaObject decodieren (FFmpeg → PCM)
// → client.transmitAudio(serial, pcmChunk) in Loop

async stopIntercom(): Promise<void>
// → client.stopTalkback(serial)
```

### 6.6 `src/ptz.ts` — PTZ Mixin

Wird nur instanziiert wenn `Device.hasPanAndTilt(device) === true`.

```typescript
// Scrypted PanTiltZoom Interface:
async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
  if (command.pan < 0)  await client.panAndTilt(serial, PanTiltDirection.LEFT);
  if (command.pan > 0)  await client.panAndTilt(serial, PanTiltDirection.RIGHT);
  if (command.tilt > 0) await client.panAndTilt(serial, PanTiltDirection.UP);
  if (command.tilt < 0) await client.panAndTilt(serial, PanTiltDirection.DOWN);
}
```

### 6.7 `src/station.ts` — EufyStation

`SecuritySystem` Interface:

```typescript
// Mapping Scrypted → eufy GuardMode:
// SecuritySystemMode.Away   → GuardMode.AWAY   (0)
// SecuritySystemMode.Home   → GuardMode.HOME   (1)
// SecuritySystemMode.Night  → GuardMode.HOME   (1)
// SecuritySystemMode.Off    → GuardMode.OFF    (6)

async armSecuritySystem(mode: SecuritySystemMode): Promise<void>
async disarmSecuritySystem(): Promise<void>
```

### 6.8 `src/plugin.ts` — Hauptklasse

`EufySecurityPlugin extends ScryptedDeviceBase`
implements `DeviceProvider`, `Settings`, `DeviceDiscovery`

**Settings (erscheinen in Scrypted UI):**

```typescript
[
  { key: "username", title: "Eufy E-Mail", type: "string" },
  { key: "password", title: "Eufy Passwort", type: "password" },
  { key: "country", title: "Land (z.B. DE)", type: "string", value: "DE" },
  {
    key: "eventDuration",
    title: "Bewegung Reset (Sek.)",
    type: "number",
    value: 30,
  },
  { key: "tfa_code", title: "2FA Code (falls nötig)", type: "string" },
  { key: "captcha_answer", title: "CAPTCHA Antwort", type: "string" },
];
```

**Device Discovery:**

```typescript
async discoverDevices(): Promise<void> {
  const stations = await client.getStations();
  const devices  = await client.getDevices();

  for (const device of devices) {
    const interfaces = [
      ScryptedInterface.Camera,
      ScryptedInterface.VideoCamera,
      ScryptedInterface.MotionSensor,
    ];
    if (Device.hasIntercom(device))    interfaces.push(ScryptedInterface.Intercom);
    if (Device.hasPanAndTilt(device))  interfaces.push(ScryptedInterface.PanTiltZoom);

    await deviceManager.onDeviceDiscovered({
      nativeId: device.getSerial(),
      name: device.getName(),
      type: ScryptedDeviceType.Camera,
      interfaces,
    });
  }

  for (const station of stations) {
    await deviceManager.onDeviceDiscovered({
      nativeId: station.getSerial(),
      name: station.getName(),
      type: ScryptedDeviceType.SecuritySystem,
      interfaces: [ScryptedInterface.SecuritySystem],
    });
  }
}
```

---

## 7. FFmpeg-Integration für RTSP-Output

Da `eufy-security-client` rohe H.264/H.265-Annexb-Frames und AAC-Audio liefert
(keine fertige RTSP-URL), muss FFmpeg diese in einen RTSP-Stream verpacken:

```typescript
// In stream-manager.ts / camera.ts:
// Scrypted's eingebauten FFmpeg-Helper nutzen:
import { mediaManager, FFmpegInput } from "@scrypted/sdk";

// Aus videoStream + audioStream einen RTSP-Stream machen:
const ffmpegInput: FFmpegInput = {
  url: undefined,
  inputArguments: [
    "-f",
    "h264", // oder 'hevc' je nach metadata.videoCodec
    "-i",
    "pipe:0", // videoStream → stdin
  ],
  // Scrypted's FFmpegHelper übernimmt RTSP-Output-Setup
};

// Alternativ: go2rtc (falls Scrypted's go2rtc-Integration verfügbar)
// Das Plugin soll BEIDE Wege unterstützen:
// Primär: Scrypted's interner FFmpegHelper
// Optional: go2rtc PUSH-URL wenn go2rtc-Plugin installiert
```

---

## 8. Fehlerbehandlung — vollständige Szenarienliste

```
Szenario 1: PKCS1 Crypto-Fehler auf Node 18+
→ EufyCryptoError fangen → automatisch ChildProcess-Fallback starten
→ User-sichtbare Meldung in Scrypted: "Using legacy crypto fallback"

Szenario 2: Ungültige Credentials
→ AuthError → in Scrypted Settings als Fehler anzeigen
→ 'tfa request' / 'captcha request' Events → Settings-Prompt

Szenario 3: Cloud-Verbindung verloren
→ 'close' Event → Reconnect mit Exponential Backoff (2s, 4s, 8s, max 60s)
→ Während Reconnect: Streams pausiert, Konsumenten warten

Szenario 4: Stream startet nicht (20s Timeout)
→ Error loggen → StreamManager wirft TimeoutError
→ Kamera-Entität zeigt "unavailable" in HomeKit/Scrypted

Szenario 5: Stream bricht ab (livestreamStop während Konsumenten aktiv)
→ StreamManager erkennt aktive Konsumenten → startet Stream neu
→ Max 3 Versuche, dann Error

Szenario 6: Zweite Kamera will streamen (HomeBase-3-Limitierung)
→ Ersten Stream graceful stoppen (500ms Wartezeit)
→ Zweiten Stream starten
→ Ersten Stream-Konsument bekommt StreamInterruptedError

Szenario 7: panAndTilt auf Kamera ohne PTZ
→ Stille ignorieren, nur debug-Log

Szenario 8: Child-Process stürzt ab (Fallback)
→ Parent erkennt 'exit' Event → Child neu starten
→ Pending IPC-Promises mit Error rejecten

Szenario 9: eufy-security-client Paket-Version inkompatibel
→ Version-Check beim Start → Warning in Scrypted logs

Szenario 10: Kamera offline / nicht erreichbar
→ P2P Timeout → device.isOnline() === false → Status in Scrypted
```

---

## 9. Tests

### `eufy-client.test.ts`

- Mock `EufySecurity.initialize` — Primär-Pfad erfolgreich
- Mock `EufySecurity.initialize` — wirft Crypto-Error → Fallback-Pfad wird gewählt
- `startLivestream` → `livestreamStart`-Event triggern → Promise resolved
- `startLivestream` → 20s Timeout → Promise rejected
- Reconnect nach `close` Event: 3 Versuche mit Timing-Mocks

### `stream-manager.test.ts`

- 2 Konsumenten teilen eine Session: `startLivestream` nur 1× aufgerufen
- Auto-Cleanup: 0 Konsumenten → nach 30s `stopLivestream` aufgerufen (fake timers)
- HomeBase-3-Limit: 2. Anfrage → 1. Session gestoppt, dann 2. gestartet
- `livestreamStop` während 1 Konsument → automatischer Neustart (max 3×)

### `plugin.test.ts`

- Discovery: Mock-Devices → richtige Scrypted-Interfaces werden registriert
- PTZ-Interface nur bei `Device.hasPanAndTilt() === true`
- Intercom-Interface nur bei `Device.hasIntercom() === true`
- Motion-Reset-Timer: `motionDetected = true` → nach N Sekunden `false`

---

## 10. README.md

### Features

```markdown
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
```

### Voraussetzungen

```markdown
1. Scrypted (Docker, HA Add-on, oder nativ)
2. Scrypted HomeKit Plugin (für HomeKit Secure Video)
3. Eufy-Account Credentials
4. Kein weiteres Tool nötig — Plugin ist self-contained
```

### Installation

```markdown
In Scrypted: Plugin Store → "Eufy Security" suchen → Installieren
Zugangsdaten in Settings eintragen → Geräte werden automatisch erkannt
```

### HomeKit einrichten

```markdown
1. Plugin installiert, Kameras erkannt
2. Kamera in Scrypted → HomeKit → "Zu HomeKit hinzufügen"
3. QR-Code in Apple Home App scannen
4. HKSV ist automatisch aktiv wenn iCloud-Plan vorhanden (Home 50GB+)
```

### Bekannte Einschränkungen

```markdown
- HomeBase 3: Nur 1 Kamera gleichzeitig streambar (Eufy Hardware-Limit)
- RTSP-Direktzugriff auf HomeBase 3 seit Firmware März 2026 defekt
  (wird umgangen: Plugin nutzt P2P direkt)
- Stream-Start: 3–10 Sekunden (P2P-Verbindungsaufbau zur HomeBase)
```

---

## 11. GitHub Actions

### `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [22.x, 24.x]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: "npm"
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm test
```

### `.github/workflows/release.yml`

```yaml
name: Release to NPM
on:
  push:
    tags: ["v*.*.*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24.x"
          registry-url: "https://registry.npmjs.org"
          cache: "npm"
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## 12. Code-Qualitätsanforderungen

- `"strict": true` in `tsconfig.json`
- Kein `any` außer in rohen IPC/Event-Handlern — dort `unknown` + Type Guards
- Keine unbehandelten Promise-Rejections — überall `try/catch` oder `.catch()`
- Kein globaler Mutable State außer Plugin-Singleton
- Jede exportierte Klasse und public Methode hat JSDoc
- ESLint `@typescript-eslint/recommended` — 0 Warnings
- Node.js `22` und `24` müssen beide funktionieren (CI Matrix)

---

## 13. Abschlussbedingung

Das Ergebnis gilt als fertig wenn:

1. `npm run build` auf Node 18 und Node 20 fehlerfrei
2. `npm test` — alle Tests grün
3. `npm run lint` — 0 Errors, 0 Warnings
4. Alle Dateien aus Abschnitt 5 vorhanden und vollständig (kein `// TODO`, kein `throw new Error('not implemented')`)
5. `eufy-security-ws` kommt in keiner Datei vor — weder als Import noch als Dependency
6. README vollständig wie in Abschnitt 10
7. Beide GitHub Actions Workflows syntaktisch korrekt

**Erstelle jetzt alle Dateien in dieser Reihenfolge:**
`package.json` → `tsconfig.json` → `.eslintrc.json` → `src/types.ts` →
`src/fallback/ipc-protocol.ts` → `src/fallback/child-wrapper.ts` →
`src/eufy-client.ts` → `src/stream-manager.ts` → `src/ptz.ts` →
`src/talkback.ts` → `src/station.ts` → `src/camera.ts` →
`src/plugin.ts` → `src/utils.ts` → `src/main.ts` →
`tests/*.test.ts` → `README.md` → `CHANGELOG.md` →
`.github/workflows/ci.yml` → `.github/workflows/release.yml` →
`.gitignore` → `LICENSE`

---

## 14. Aktueller Codebase-Stand (Stand 2026-06-09)

### Prod-Ready-Status: ✅ Alle Fixes committed

Branch: `fix/startup-race-unknown-device`

### Behobene Bug-Klassen

**Resource-Leaks**
- `camera.ts`: TCP-Server schließt bei `end`/`close`/`error`; `activeTcpServers[]` in `cleanup()` geschlossen
- `eufy-client.ts`: `child.removeAllListeners()` in `onChildExit()` — verhindert Listener-Akkumulation bei Reconnects
- `stream-manager.ts`: `destroy()` entfernt alle Client-Listener (gebundene Refs); in Plugin-Reconnect aufgerufen
- `talkback.ts`: `removeAllListeners()` auf ffmpeg-Process vor kill in `stop()`

**Race-Conditions**
- `stream-manager.ts`: `requestStream()` mit Promise-Chain-Mutex (`requestLock`) serialisiert
- `camera.ts`: `getVideoStream()` serialisiert via `streamRequestLock`
- `talkback.ts`: `active = true` sofort nach Guard-Check, vor `await stop()` — verhindert doppelten Start
- `talkback.ts`: `active = false` VOR `ffmpeg.kill()` (Exit-Handler-Re-entry verhindert); lokale `currentFfmpeg`-Ref für in-flight `transmitAudio()`

**IPC-Safety (`src/fallback/child-wrapper.ts`)**
- `send()` zentral in try/catch — einzige sichere Stelle für geschlossenen IPC-Kanal
- `process.on("disconnect", () => process.exit(0))` — kein Zombie-Child wenn Parent stirbt
- `process.on("message")` Callback in try/catch für synchrone Exceptions in `handle()`
- `ChildProcessEufyClient.disconnect()` wartet bis zu 2 s auf Child-Exit nach `kill()`

**Fehlerbehandlung**
- Alle `void asyncFn()` in Event-Handlern haben `.catch()` (inkl. `discoverDevices`, `restartStream`)
- `ptz.ts`: per-Move try/catch; wirft erst wenn ALLE Moves scheitern
- `station.ts`: `updateState()` nur nach erfolgreichem `setGuardMode()`
- `plugin.ts`: `reconnecting`-Flag in `finally` freigegeben

**Reconnect-Flow (`src/plugin.ts`)**
- cameras/stations/infos/streamManager vollständig geleert vor Neuverbindung
- `client.removeAllListeners()` vor `client = undefined`

### CI/CD

- Node 20.x in CI-Matrix hinzugefügt (war nur 22/24)
- Release-Workflow baut auf Node 20.x (Minimum-Version des Projekts)
- Release: Tag-Version wird gegen `package.json` version validiert (verhindert falschen Publish)
- `tests/` wird von ESLint erfasst (war irrtümlich excluded)

### Kritische Invarianten (nicht brechen)

1. `StreamManager.requestStream()` MUSS mutex-gesichert bleiben — HomeBase 3 erlaubt nur 1 Stream gleichzeitig
2. `send()` in `child-wrapper.ts` MUSS in try/catch bleiben — IPC-Kanal kann jederzeit zu sein
3. Reconnect in `putSetting()` muss ALLES aufräumen (cameras, stations, streamManager, client-Listener)
4. `talkback.start()`: `active = true` SOFORT nach Guard-Check, VOR dem ersten `await` — Race-Schutz
5. `eufy-security-ws` darf NIRGENDWO vorkommen — weder als Import noch als Dependency
