/**
 * Legacy-crypto fallback child process.
 *
 * Spawned by {@link ChildProcessEufyClient} with `node --openssl-legacy-provider`
 * on a runtime where the in-process `enableEmbeddedPKCS1Support` path is not
 * usable. It hosts a real `eufy-security-client` instance and bridges it to the
 * parent over Node's IPC channel using the message types in `ipc-protocol.ts`.
 *
 * Raw video/audio frames are forwarded as base64-chunked IPC events because the
 * IPC channel cannot carry live `Readable` streams.
 */
import {
  EufySecurity,
  type Device,
  type EufySecurityConfig,
  type StreamMetadata as EufyStreamMetadata,
  type Station,
  type TalkbackStream,
} from "eufy-security-client";
import type { EventEmitter } from "events";
import type { Readable } from "stream";
import type { BatteryStatus, DeviceInfo, StationInfo, StreamMetadata } from "../types";
import type { ChildConfig, ChildMessage, ParentMessage } from "./ipc-protocol";

const DEVICE_BATTERY_PROPERTY = "battery";
const DEVICE_BATTERY_LOW_PROPERTIES = new Set([
  "batteryLow",
  "lowBatteryAlert",
]);

/** Send a typed message to the parent. No-op if the IPC channel is closed. */
function send(message: ChildMessage): void {
  try {
    process.send?.(message);
  } catch {
    // IPC channel already closed — parent is gone, discard silently.
  }
}

/** Reply to a request with a payload. */
function reply(requestId: string, payload: unknown): void {
  send({ type: "result", requestId, payload });
}

/** Reply to a request with an error. */
function replyError(requestId: string | undefined, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : undefined;
  send({ type: "error", requestId, message, code });
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

function toStationInfo(station: Station): StationInfo {
  return {
    serial: station.getSerial(),
    name: station.getName(),
    model: station.getModel(),
    guardMode: numberOrZero(station.getGuardMode()),
    isSingleStreamStation:
      station.isStationHomeBase3() || station.isStationHomeBase2OrOlder(),
  };
}

function isDeviceOnline(device: Device): boolean {
  try {
    return Number(device.getPropertyValue("state")) === 1;
  } catch {
    return true;
  }
}

function normalizeBatteryLevel(value: unknown): number | undefined {
  const level = Number(value);
  if (!Number.isFinite(level)) return undefined;
  return Math.max(0, Math.min(100, Math.round(level)));
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}

function hasBattery(device: Device): boolean {
  try {
    return device.hasBattery();
  } catch {
    return readBatteryLevel(device) !== undefined;
  }
}

function readBatteryLevel(device: Device): number | undefined {
  try {
    const getBatteryValue = (
      device as Device & { getBatteryValue?: () => unknown }
    ).getBatteryValue;
    if (typeof getBatteryValue === "function") {
      return normalizeBatteryLevel(getBatteryValue.call(device));
    }
  } catch {
    // fall through to generic property lookup
  }
  try {
    return normalizeBatteryLevel(device.getPropertyValue(DEVICE_BATTERY_PROPERTY));
  } catch {
    return undefined;
  }
}

function readBatteryLow(device: Device): boolean | undefined {
  for (const property of DEVICE_BATTERY_LOW_PROPERTIES) {
    try {
      const value = device.getPropertyValue(property);
      const normalized = normalizeBoolean(value);
      if (normalized !== undefined) return normalized;
    } catch {
      // try the next low-battery property name
    }
  }
  return undefined;
}

function batteryStatusFromProperty(
  name: string,
  value: unknown,
): BatteryStatus | undefined {
  if (name === DEVICE_BATTERY_PROPERTY) {
    const batteryLevel = normalizeBatteryLevel(value);
    return batteryLevel === undefined ? undefined : { batteryLevel };
  }
  if (DEVICE_BATTERY_LOW_PROPERTIES.has(name)) {
    const batteryLow = normalizeBoolean(value);
    return batteryLow === undefined ? undefined : { batteryLow };
  }
  return undefined;
}

function toDeviceInfo(device: Device): DeviceInfo {
  return {
    serial: device.getSerial(),
    name: device.getName(),
    model: device.getModel(),
    stationSerial: device.getStationSerial(),
    hasPanAndTilt: device.hasCommand("devicePanAndTilt" as never),
    hasIntercom: device.hasCommand("deviceStartTalkback" as never),
    isCamera: device.isCamera(),
    isOnline: isDeviceOnline(device),
    hasBattery: hasBattery(device),
    batteryLevel: readBatteryLevel(device),
    batteryLow: readBatteryLow(device),
  };
}

// VideoCodec enum (eufy-security-client p2p/types.ts): UNKNOWN=-1, H264=0, H265=1
function videoCodecName(codec: unknown): string {
  return Number(codec) === 1 ? "h265" : "h264";
}

function toStreamMetadata(metadata: EufyStreamMetadata): StreamMetadata {
  return {
    videoCodec: videoCodecName(metadata.videoCodec),
    audioCodec: String(metadata.audioCodec ?? ""),
    videoFPS: numberOrZero(metadata.videoFPS),
    videoWidth: numberOrZero(metadata.videoWidth),
    videoHeight: numberOrZero(metadata.videoHeight),
  };
}

/**
 * Owns the client instance and wires up its event handlers + parent commands.
 */
class ChildWrapper {
  private client?: EufySecurity;
  private readonly talkbackStreams = new Map<string, TalkbackStream>();

  constructor(private readonly config: ChildConfig) {}

  /** Build the client and register all event listeners. */
  async init(): Promise<void> {
    const clientConfig: EufySecurityConfig = {
      username: this.config.username,
      password: this.config.password,
      country: this.config.country,
      language: this.config.language,
      persistentDir: this.config.persistentDir,
      trustedDeviceName: this.config.trustedDeviceName,
      eventDurationSeconds: this.config.eventDurationSeconds,
      p2pConnectionSetup: this.config.p2pConnectionSetupTimeout,
      pollingIntervalMinutes: 10,
      // Still request embedded support; harmless when the runtime already
      // permits legacy padding via --openssl-legacy-provider.
      enableEmbeddedPKCS1Support: true,
    };

    this.client = await EufySecurity.initialize(clientConfig);
    this.registerEvents(this.client);
    send({ type: "ready" });
  }

  private registerEvents(client: EufySecurity): void {
    client.on("connect", () => send({ type: "event:connected" }));
    client.on("close", () => send({ type: "event:disconnected" }));
    (client as unknown as EventEmitter).on("error", (err: Error) => {
      console.warn("[EufyChild] eufy-security-client error:", err?.message ?? err);
      send({ type: "event:disconnected" });
    });

    client.on("tfa request", () => send({ type: "tfa_request" }));
    client.on("captcha request", (captchaId: string, captcha: string) =>
      send({ type: "captcha_request", captchaId, captchaB64: captcha }),
    );

    client.on("device motion detected", (device: Device, state: boolean) =>
      send({ type: "event:motionDetected", deviceSerial: device.getSerial(), state }),
    );
    client.on("device person detected", (device: Device, state: boolean) =>
      send({ type: "event:personDetected", deviceSerial: device.getSerial(), state }),
    );
    client.on("device pet detected", (device: Device, state: boolean) =>
      send({ type: "event:petDetected", deviceSerial: device.getSerial(), state }),
    );
    client.on("device vehicle detected", (device: Device, state: boolean) =>
      send({ type: "event:vehicleDetected", deviceSerial: device.getSerial(), state }),
    );
    client.on("device sound detected", (device: Device, state: boolean) =>
      send({ type: "event:soundDetected", deviceSerial: device.getSerial(), state }),
    );
    client.on(
      "device property changed",
      (device: Device, name: string, value: unknown) => {
        const status = batteryStatusFromProperty(name, value);
        if (status) {
          send({
            type: "event:batteryStatus",
            deviceSerial: device.getSerial(),
            status,
          });
        }
      },
    );
    client.on("device low battery", (device: Device, state: boolean) =>
      send({
        type: "event:batteryStatus",
        deviceSerial: device.getSerial(),
        status: { batteryLow: state },
      }),
    );
    client.on(
      "device battery fully charged",
      (device: Device, state: boolean) => {
        if (state) {
          send({
            type: "event:batteryStatus",
            deviceSerial: device.getSerial(),
            status: { batteryLevel: 100, batteryLow: false },
          });
        }
      },
    );

    client.on(
      "station livestream start",
      (
        _station: Station,
        device: Device,
        metadata: EufyStreamMetadata,
        videoStream: Readable,
        audioStream: Readable,
      ) => {
        const deviceSerial = device.getSerial();
        send({
          type: "event:livestreamStart",
          deviceSerial,
          metadata: toStreamMetadata(metadata),
        });
        this.pipeStream(deviceSerial, videoStream, (chunkB64) =>
          send({ type: "event:livestreamVideoChunk", deviceSerial, chunkB64 }),
        );
        this.pipeStream(deviceSerial, audioStream, (chunkB64) =>
          send({ type: "event:livestreamAudioChunk", deviceSerial, chunkB64 }),
        );
      },
    );

    client.on("station livestream stop", (_station: Station, device: Device) =>
      send({ type: "event:livestreamStop", deviceSerial: device.getSerial() }),
    );

    client.on("station guard mode", (station: Station, guardMode: number) =>
      send({ type: "event:guardMode", stationSerial: station.getSerial(), mode: guardMode }),
    );

    client.on(
      "station talkback start",
      (_station: Station, device: Device, talkbackStream: TalkbackStream) => {
        this.talkbackStreams.set(device.getSerial(), talkbackStream);
        send({ type: "event:talkbackStart", deviceSerial: device.getSerial() });
      },
    );
    client.on("station talkback stop", (_station: Station, device: Device) => {
      this.talkbackStreams.delete(device.getSerial());
    });

    client.on("station added", (station: Station) =>
      send({ type: "event:stationAdded", station: toStationInfo(station) }),
    );
    client.on("device added", (device: Device) =>
      send({ type: "event:deviceAdded", device: toDeviceInfo(device) }),
    );
  }

  /** Forward a raw stream to the parent as base64 chunks. */
  private pipeStream(
    deviceSerial: string,
    stream: Readable,
    emit: (chunkB64: string) => void,
  ): void {
    stream.on("data", (chunk: Buffer) => emit(chunk.toString("base64")));
    stream.on("error", (err: Error) =>
      send({ type: "event:livestreamError", deviceSerial, message: err.message }),
    );
  }

  private require(): EufySecurity {
    if (!this.client) {
      throw new Error("client not initialised");
    }
    return this.client;
  }

  /** Dispatch a single parent command. */
  async handle(msg: ParentMessage): Promise<void> {
    const client = this.require();
    switch (msg.type) {
      case "connect":
        await client.connect({ force: false });
        reply(msg.requestId, null);
        break;
      case "disconnect":
        await client.close();
        reply(msg.requestId, null);
        break;
      case "verifyCode":
        await client.connect({ verifyCode: msg.code, force: false });
        reply(msg.requestId, null);
        break;
      case "verifyCaptcha":
        await client.connect({
          captcha: { captchaId: msg.captchaId, captchaCode: msg.captcha },
          force: false,
        });
        reply(msg.requestId, null);
        break;
      case "getStations": {
        const stations = await client.getStations();
        reply(msg.requestId, stations.map(toStationInfo));
        break;
      }
      case "getDevices": {
        const devices = await client.getDevices();
        reply(msg.requestId, devices.map(toDeviceInfo));
        break;
      }
      case "startLivestream":
        await client.startStationLivestream(msg.deviceSerial);
        reply(msg.requestId, null);
        break;
      case "stopLivestream":
        await client.stopStationLivestream(msg.deviceSerial);
        reply(msg.requestId, null);
        break;
      case "isLiveStreaming": {
        const device = await client.getDevice(msg.deviceSerial);
        const station = await client.getStation(device.getStationSerial());
        reply(msg.requestId, station.isLiveStreaming(device));
        break;
      }
      case "panAndTilt": {
        const device = await client.getDevice(msg.deviceSerial);
        const station = await client.getStation(device.getStationSerial());
        station.panAndTilt(device, msg.direction);
        reply(msg.requestId, null);
        break;
      }
      case "rotate360": {
        const device = await client.getDevice(msg.deviceSerial);
        const station = await client.getStation(device.getStationSerial());
        station.panAndTilt(device, 0);
        reply(msg.requestId, null);
        break;
      }
      case "startTalkback":
        await client.startStationTalkback(msg.deviceSerial);
        reply(msg.requestId, null);
        break;
      case "stopTalkback":
        this.talkbackStreams.delete(msg.deviceSerial);
        await client.stopStationTalkback(msg.deviceSerial);
        reply(msg.requestId, null);
        break;
      case "transmitAudio": {
        const stream = this.talkbackStreams.get(msg.deviceSerial);
        if (!stream) {
          throw new Error(`no active talkback stream for ${msg.deviceSerial}`);
        }
        stream.write(Buffer.from(msg.bufferB64, "base64"));
        reply(msg.requestId, null);
        break;
      }
      case "setGuardMode":
        await client.setStationProperty(msg.stationSerial, "guardMode", msg.mode);
        reply(msg.requestId, null);
        break;
      case "setProperty":
        await client.setDeviceProperty(msg.serial, msg.name, msg.value);
        reply(msg.requestId, null);
        break;
      case "getSnapshot": {
        const device = await client.getDevice(msg.deviceSerial);
        let payload: string | null = null;
        try {
          const picture = device.getPropertyValue("picture") as { data?: Buffer } | undefined;
          payload = picture?.data ? picture.data.toString("base64") : null;
        } catch {
          payload = null;
        }
        reply(msg.requestId, payload);
        break;
      }
      default: {
        // Exhaustiveness guard.
        const exhaustive: never = msg;
        throw new Error(`unhandled message: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

function main(): void {
  const raw = process.env.EUFY_CHILD_CONFIG;
  if (!raw) {
    replyError(undefined, new Error("EUFY_CHILD_CONFIG env var missing"));
    process.exit(1);
    return;
  }

  const config = JSON.parse(raw) as ChildConfig;
  const wrapper = new ChildWrapper(config);

  process.on("message", (msg: ParentMessage) => {
    try {
      wrapper.handle(msg).catch((err) => replyError(msg.requestId, err));
    } catch (err) {
      replyError(msg.requestId, err);
    }
  });

  // Exit cleanly when the parent closes the IPC channel.
  process.on("disconnect", () => process.exit(0));

  wrapper.init().catch((err) => {
    replyError(undefined, err);
    process.exit(1);
  });
}

main();
