import type { EventEmitter } from "events";
import type { Readable } from "stream";

/**
 * Pan/Tilt directions mirrored from eufy-security-client's `PanTiltDirection`
 * enum so the rest of the plugin (and the IPC fallback) can reference stable
 * numeric values without importing the heavy client in every module.
 */
export enum PanTiltDirection {
  ROTATE360 = 0,
  LEFT = 1,
  RIGHT = 2,
  UP = 3,
  DOWN = 4,
}

/**
 * Eufy guard modes mirrored from eufy-security-client's `GuardMode` enum.
 */
export enum GuardMode {
  AWAY = 0,
  HOME = 1,
  SCHEDULE = 2,
  CUSTOM1 = 3,
  CUSTOM2 = 4,
  CUSTOM3 = 5,
  OFF = 6,
  GEO = 47,
  DISARMED = 63,
}

/**
 * User-supplied plugin configuration, sourced from the Scrypted settings UI.
 */
export interface EufyPluginConfig {
  /** Eufy account e-mail. */
  username: string;
  /** Eufy account password. */
  password: string;
  /** Two-letter country code, must match the Eufy app (e.g. "DE"). */
  country: string;
  /** UI language hint passed to the client (e.g. "de"). */
  language: string;
  /** Directory used to persist tokens / session data. */
  persistentDir: string;
  /** Label shown for this integration inside the Eufy app. */
  trustedDeviceName: string;
  /** Seconds before a motion event auto-resets. */
  eventDurationSeconds: number;
  /** P2P connection setup timeout in milliseconds. */
  p2pConnectionSetupTimeout: number;
  /** Optional 2FA code entered by the user. */
  tfaCode?: string;
  /** Optional CAPTCHA answer entered by the user. */
  captchaAnswer?: string;
  /** Optional CAPTCHA id paired with {@link captchaAnswer}. */
  captchaId?: string;
}

/**
 * Lightweight, serialisable description of a Eufy station (HomeBase).
 * Serialisable so it can cross the IPC boundary to/from the fallback child.
 */
export interface StationInfo {
  serial: string;
  name: string;
  model: string;
  guardMode: number;
}

/**
 * Lightweight, serialisable description of a Eufy device (camera).
 */
export interface DeviceInfo {
  serial: string;
  name: string;
  model: string;
  stationSerial: string;
  hasPanAndTilt: boolean;
  hasIntercom: boolean;
  isCamera: boolean;
  isOnline: boolean;
}

/**
 * Stream metadata reported by the client when a livestream starts.
 */
export interface StreamMetadata {
  videoCodec: string;
  audioCodec: string;
  videoFPS: number;
  videoWidth: number;
  videoHeight: number;
}

/**
 * Common interface implemented by both the direct (in-process) client and the
 * child-process IPC fallback. Emits the events declared in {@link EufyClientEvents}.
 */
export interface IEufyClient extends EventEmitter {
  connect(): Promise<void>;
  /**
   * Re-establish the cloud session on the *existing* client, reusing the
   * persisted token. Used for transient disconnects so we do not re-run the
   * full username/password login (which triggers Eufy's CAPTCHA rate limit).
   */
  reconnect(): Promise<void>;
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
  /** Return the camera's most recent snapshot image, if available. */
  getSnapshot(deviceSerial: string): Promise<Buffer | undefined>;
}

/**
 * Payload emitted with the `livestreamStart` event.
 */
export interface LivestreamStartPayload {
  deviceSerial: string;
  metadata: StreamMetadata;
  videoStream: Readable;
  audioStream: Readable;
}

/**
 * Strongly-typed event map for {@link IEufyClient} consumers. Used for
 * documentation and to keep emit/handler call-sites consistent.
 */
export interface EufyClientEvents {
  connected: () => void;
  disconnected: () => void;
  tfaRequest: () => void;
  captchaRequest: (captchaId: string, captchaB64: string) => void;
  motionDetected: (deviceSerial: string, state: boolean) => void;
  livestreamStart: (payload: LivestreamStartPayload) => void;
  livestreamStop: (deviceSerial: string) => void;
  livestreamError: (deviceSerial: string, error: Error) => void;
  guardMode: (stationSerial: string, mode: number) => void;
  talkbackStart: (deviceSerial: string) => void;
  stationAdded: (station: StationInfo) => void;
  deviceAdded: (device: DeviceInfo) => void;
}

/**
 * Thrown by the direct client when the runtime rejects the legacy
 * `RSA_PKCS1_PADDING` crypto required by the Eufy P2P protocol. Signals the
 * factory to fall back to the legacy-crypto child process.
 */
export class EufyCryptoError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EufyCryptoError";
  }
}

/**
 * Thrown when a livestream fails to start within the configured timeout.
 */
export class StreamTimeoutError extends Error {
  constructor(deviceSerial: string) {
    super(`Livestream for ${deviceSerial} did not start within timeout`);
    this.name = "StreamTimeoutError";
  }
}

/**
 * Thrown to an existing stream consumer when its session is pre-empted because
 * of the HomeBase 3 single-stream hardware limit.
 */
export class StreamInterruptedError extends Error {
  constructor(deviceSerial: string) {
    super(`Stream for ${deviceSerial} was interrupted by another session`);
    this.name = "StreamInterruptedError";
  }
}
