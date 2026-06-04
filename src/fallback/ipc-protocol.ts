import type { DeviceInfo, StationInfo, StreamMetadata } from "../types";

/**
 * Messages sent from the parent (Scrypted process) to the legacy-crypto child.
 * Each request that expects a reply carries a `requestId` correlated by the
 * child's matching `result`/`error` response.
 */
export type ParentMessage =
  | { type: "connect"; requestId: string }
  | { type: "disconnect"; requestId: string }
  | { type: "verifyCode"; requestId: string; code: string }
  | { type: "verifyCaptcha"; requestId: string; captchaId: string; captcha: string }
  | { type: "startLivestream"; requestId: string; deviceSerial: string }
  | { type: "stopLivestream"; requestId: string; deviceSerial: string }
  | { type: "isLiveStreaming"; requestId: string; deviceSerial: string }
  | { type: "panAndTilt"; requestId: string; deviceSerial: string; direction: number }
  | { type: "rotate360"; requestId: string; deviceSerial: string }
  | { type: "startTalkback"; requestId: string; deviceSerial: string }
  | { type: "stopTalkback"; requestId: string; deviceSerial: string }
  | { type: "transmitAudio"; requestId: string; deviceSerial: string; bufferB64: string }
  | { type: "setGuardMode"; requestId: string; stationSerial: string; mode: number }
  | { type: "setProperty"; requestId: string; serial: string; name: string; value: unknown }
  | { type: "getSnapshot"; requestId: string; deviceSerial: string }
  | { type: "getStations"; requestId: string }
  | { type: "getDevices"; requestId: string };

/**
 * Messages sent from the legacy-crypto child back to the parent. Replies to a
 * request reuse its `requestId`; events carry no `requestId`.
 */
export type ChildMessage =
  | { type: "ready" }
  | { type: "error"; requestId?: string; message: string; code?: string }
  | { type: "result"; requestId: string; payload: unknown }
  | { type: "event:motionDetected"; deviceSerial: string; state: boolean }
  | { type: "event:personDetected"; deviceSerial: string; state: boolean }
  | { type: "event:petDetected"; deviceSerial: string; state: boolean }
  | { type: "event:vehicleDetected"; deviceSerial: string; state: boolean }
  | { type: "event:soundDetected"; deviceSerial: string; state: boolean }
  | { type: "event:livestreamStart"; deviceSerial: string; metadata: StreamMetadata }
  | { type: "event:livestreamVideoChunk"; deviceSerial: string; chunkB64: string }
  | { type: "event:livestreamAudioChunk"; deviceSerial: string; chunkB64: string }
  | { type: "event:livestreamStop"; deviceSerial: string }
  | { type: "event:livestreamError"; deviceSerial: string; message: string }
  | { type: "event:guardMode"; stationSerial: string; mode: number }
  | { type: "event:talkbackStart"; deviceSerial: string }
  | { type: "event:stationAdded"; station: StationInfo }
  | { type: "event:deviceAdded"; device: DeviceInfo }
  | { type: "event:connected" }
  | { type: "event:disconnected" }
  | { type: "tfa_request" }
  | { type: "captcha_request"; captchaId: string; captchaB64: string };

/** Serialisable subset of the plugin config passed to the child on spawn. */
export interface ChildConfig {
  username: string;
  password: string;
  country: string;
  language: string;
  persistentDir: string;
  trustedDeviceName: string;
  eventDurationSeconds: number;
  p2pConnectionSetupTimeout: number;
}
