/**
 * Adapter layer that hides the difference between the two ways of talking to
 * `eufy-security-client`:
 *
 *  - {@link DirectEufyClient}: runs the client in-process using
 *    `enableEmbeddedPKCS1Support` (works on modern Node when embedded OpenSSL
 *    patches apply).
 *  - {@link ChildProcessEufyClient}: spawns the legacy-crypto child wrapper with
 *    `--openssl-legacy-provider` and proxies every call over IPC.
 *
 * Both implement {@link IEufyClient}. {@link createEufyClient} tries direct first
 * and transparently falls back to the child process on a crypto error.
 */
import { ChildProcess, fork } from "child_process";
import { EventEmitter } from "events";
import path from "path";
import { PassThrough, type Readable } from "stream";
import type {
  ChildConfig,
  ChildMessage,
  ParentMessage,
} from "./fallback/ipc-protocol";
import {
  EufyCryptoError,
  PanTiltDirection,
  type DeviceInfo,
  type EufyPluginConfig,
  type IEufyClient,
  type StationInfo,
  type StreamMetadata,
} from "./types";
import { Logger, isCryptoPaddingError, makeRequestId } from "./utils";

/** Build the serialisable subset of config handed to the child process. */
function toChildConfig(config: EufyPluginConfig): ChildConfig {
  return {
    username: config.username,
    password: config.password,
    country: config.country,
    language: config.language,
    persistentDir: config.persistentDir,
    trustedDeviceName: config.trustedDeviceName,
    eventDurationSeconds: config.eventDurationSeconds,
    p2pConnectionSetupTimeout: config.p2pConnectionSetupTimeout,
  };
}

/**
 * In-process client backed directly by `eufy-security-client`.
 */
export class DirectEufyClient extends EventEmitter implements IEufyClient {
  // The heavy client is imported lazily so a missing optional dependency does
  // not crash module load.
  private client: import("eufy-security-client").EufySecurity | undefined;
  /** Active talkback writable streams keyed by device serial. */
  private readonly talkbackStreams = new Map<
    string,
    import("eufy-security-client").TalkbackStream
  >();

  constructor(private readonly config: EufyPluginConfig) {
    super();
  }

  async connect(): Promise<void> {
    try {
      const mod = await import("eufy-security-client");
      const clientConfig: import("eufy-security-client").EufySecurityConfig = {
        username: this.config.username,
        password: this.config.password,
        country: this.config.country,
        language: this.config.language,
        persistentDir: this.config.persistentDir,
        trustedDeviceName: this.config.trustedDeviceName,
        eventDurationSeconds: this.config.eventDurationSeconds,
        p2pConnectionSetup: this.config.p2pConnectionSetupTimeout,
        pollingIntervalMinutes: 10,
        enableEmbeddedPKCS1Support: true,
      };
      this.client = await mod.EufySecurity.initialize(clientConfig);
      this.registerEvents();

      if (this.config.tfaCode) {
        await this.client.connect({
          verifyCode: this.config.tfaCode,
          force: false,
        });
      } else if (this.config.captchaAnswer && this.config.captchaId) {
        await this.client.connect({
          captcha: {
            captchaId: this.config.captchaId,
            captchaCode: this.config.captchaAnswer,
          },
          force: false,
        });
      } else {
        await this.client.connect({ force: false });
      }
    } catch (err) {
      if (isCryptoPaddingError(err)) {
        throw new EufyCryptoError(
          "legacy PKCS1 padding rejected by runtime",
          err,
        );
      }
      throw err;
    }
  }

  /**
   * Reconnect the already-initialized client using the persisted token. Avoids
   * re-running {@link connect}, which would create a fresh `EufySecurity`
   * instance and re-authenticate with username/password.
   */
  async reconnect(): Promise<void> {
    if (!this.client) {
      await this.connect();
      return;
    }
    await this.client.connect({ force: false });
  }

  private registerEvents(): void {
    const client = this.requireClient();
    type Dev = import("eufy-security-client").Device;
    type Stat = import("eufy-security-client").Station;

    client.on("connect", () => this.emit("connected"));
    client.on("close", () => this.emit("disconnected"));
    // eufy-security-client's typed EventEmitter doesn't expose 'error' in its
    // event map, so attach via the base EventEmitter to avoid the TS error.
    // Without this listener Node.js turns unhandled 'error' events into
    // thrown exceptions that crash the plugin process.
    (client as unknown as import("events").EventEmitter).on(
      "error",
      (err: Error) => {
        console.warn(
          "[DirectEufyClient] eufy-security-client error:",
          err?.message ?? err,
        );
        this.emit("disconnected");
      },
    );
    client.on("tfa request", () => this.emit("tfaRequest"));
    client.on("captcha request", (id: string, captcha: string) =>
      this.emit("captchaRequest", id, captcha),
    );

    const motion = (device: Dev, state: boolean): void => {
      this.emit("motionDetected", device.getSerial(), state);
    };
    client.on("device motion detected", motion);
    client.on("device person detected", motion);
    client.on("device pet detected", motion);
    client.on("device vehicle detected", motion);

    client.on(
      "station livestream start",
      (
        _station: Stat,
        device: Dev,
        metadata: import("eufy-security-client").StreamMetadata,
        videoStream: Readable,
        audioStream: Readable,
      ) => {
        videoStream.on("error", (err) =>
          this.emit("livestreamError", device.getSerial(), err),
        );
        audioStream.on("error", (err) =>
          this.emit("livestreamError", device.getSerial(), err),
        );
        this.emit("livestreamStart", {
          deviceSerial: device.getSerial(),
          metadata: toStreamMetadata(metadata),
          videoStream,
          audioStream,
        });
      },
    );
    client.on("station livestream stop", (_station: Stat, device: Dev) =>
      this.emit("livestreamStop", device.getSerial()),
    );
    client.on("station guard mode", (station: Stat, mode: number) =>
      this.emit("guardMode", station.getSerial(), mode),
    );
    client.on(
      "station talkback start",
      (
        _station: Stat,
        device: Dev,
        talkbackStream: import("eufy-security-client").TalkbackStream,
      ) => {
        (talkbackStream as unknown as import("events").EventEmitter).on(
          "error",
          (err: Error) =>
            this.emit(
              "livestreamError",
              device.getSerial(),
              err,
            ),
        );
        this.talkbackStreams.set(device.getSerial(), talkbackStream);
        this.emit("talkbackStart", device.getSerial());
      },
    );
    client.on("station talkback stop", (_station: Stat, device: Dev) => {
      this.talkbackStreams.delete(device.getSerial());
    });
  }

  private requireClient(): import("eufy-security-client").EufySecurity {
    if (!this.client) {
      throw new Error("EufySecurity client not connected");
    }
    return this.client;
  }

  async disconnect(): Promise<void> {
    await this.client?.close();
  }

  async getStations(): Promise<StationInfo[]> {
    const stations = await this.requireClient().getStations();
    return stations.map((s) => ({
      serial: s.getSerial(),
      name: s.getName(),
      model: s.getModel(),
      guardMode: Number(s.getGuardMode() ?? 0),
    }));
  }

  async getDevices(): Promise<DeviceInfo[]> {
    const devices = await this.requireClient().getDevices();
    return devices.map((d) => ({
      serial: d.getSerial(),
      name: d.getName(),
      model: d.getModel(),
      stationSerial: d.getStationSerial(),
      hasPanAndTilt: d.hasCommand("devicePanAndTilt" as never),
      hasIntercom: d.hasCommand("deviceStartTalkback" as never),
      isCamera: d.isCamera(),
      isOnline: isDeviceOnline(d),
    }));
  }

  async startLivestream(deviceSerial: string): Promise<void> {
    await this.requireClient().startStationLivestream(deviceSerial);
  }

  async stopLivestream(deviceSerial: string): Promise<void> {
    await this.requireClient().stopStationLivestream(deviceSerial);
  }

  async isLiveStreaming(deviceSerial: string): Promise<boolean> {
    const client = this.requireClient();
    const device = await client.getDevice(deviceSerial);
    const station = await client.getStation(device.getStationSerial());
    return station.isLiveStreaming(device);
  }

  async panAndTilt(
    deviceSerial: string,
    direction: PanTiltDirection,
  ): Promise<void> {
    const client = this.requireClient();
    const device = await client.getDevice(deviceSerial);
    const station = await client.getStation(device.getStationSerial());
    station.panAndTilt(device, direction as unknown as number);
  }

  async rotate360(deviceSerial: string): Promise<void> {
    await this.panAndTilt(deviceSerial, PanTiltDirection.ROTATE360);
  }

  async startTalkback(deviceSerial: string): Promise<void> {
    await this.requireClient().startStationTalkback(deviceSerial);
  }

  async stopTalkback(deviceSerial: string): Promise<void> {
    this.talkbackStreams.delete(deviceSerial);
    await this.requireClient().stopStationTalkback(deviceSerial);
  }

  async transmitAudio(deviceSerial: string, buffer: Buffer): Promise<void> {
    const stream = this.talkbackStreams.get(deviceSerial);
    if (!stream) {
      throw new Error(`no active talkback stream for ${deviceSerial}`);
    }
    stream.write(buffer);
  }

  async setGuardMode(stationSerial: string, mode: number): Promise<void> {
    await this.requireClient().setStationProperty(
      stationSerial,
      "guardMode",
      mode,
    );
  }

  async setDeviceProperty(
    serial: string,
    name: string,
    value: unknown,
  ): Promise<void> {
    await this.requireClient().setDeviceProperty(serial, name, value);
  }

  async getSnapshot(deviceSerial: string): Promise<Buffer | undefined> {
    const device = await this.requireClient().getDevice(deviceSerial);
    return readPictureBuffer(device);
  }
}

/** Best-effort online check from the device `state` property (1 === online). */
function isDeviceOnline(
  device: import("eufy-security-client").Device,
): boolean {
  try {
    return Number(device.getPropertyValue("state")) === 1;
  } catch {
    return true;
  }
}

/** Convert the client's StreamMetadata into the plugin's serialisable shape. */
function toStreamMetadata(
  metadata: import("eufy-security-client").StreamMetadata,
): StreamMetadata {
  return {
    videoCodec: String(metadata.videoCodec ?? ""),
    audioCodec: String(metadata.audioCodec ?? ""),
    videoFPS: Number(metadata.videoFPS) || 0,
    videoWidth: Number(metadata.videoWidth) || 0,
    videoHeight: Number(metadata.videoHeight) || 0,
  };
}

/** Read the device's cached snapshot picture buffer, if present. */
function readPictureBuffer(
  device: import("eufy-security-client").Device,
): Buffer | undefined {
  try {
    const picture = device.getPropertyValue("picture") as
      | { data?: Buffer }
      | undefined;
    return picture?.data;
  } catch {
    return undefined;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface ChildStreamPair {
  video: PassThrough;
  audio: PassThrough;
}

/**
 * Out-of-process client that proxies every {@link IEufyClient} call to the
 * legacy-crypto child wrapper over IPC.
 */
export class ChildProcessEufyClient
  extends EventEmitter
  implements IEufyClient
{
  private readonly logger: Logger;
  private child?: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streams = new Map<string, ChildStreamPair>();
  private readyResolve?: () => void;
  private readyReject?: (err: Error) => void;

  constructor(private readonly config: EufyPluginConfig) {
    super();
    this.logger = new Logger("EufyChild");
  }

  async connect(): Promise<void> {
    await this.spawnChild();
    // Forward one-shot auth inputs so 2FA / CAPTCHA can complete over the
    // fallback path, mirroring DirectEufyClient.connect().
    if (this.config.tfaCode) {
      await this.request("verifyCode", { code: this.config.tfaCode });
    } else if (this.config.captchaAnswer && this.config.captchaId) {
      await this.request("verifyCaptcha", {
        captchaId: this.config.captchaId,
        captcha: this.config.captchaAnswer,
      });
    } else {
      await this.request("connect", {});
    }
  }

  /**
   * Reconnect over the existing child process if it is still alive, reusing the
   * persisted token; otherwise fall back to a full {@link connect}.
   */
  async reconnect(): Promise<void> {
    if (!this.child || this.child.killed) {
      await this.connect();
      return;
    }
    await this.request("connect", {});
  }

  /** Spawn the child wrapper and wait for its `ready` message. */
  private spawnChild(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      const childPath = path.join(__dirname, "fallback", "child-wrapper.js");
      this.child = fork(childPath, [], {
        execArgv: ["--openssl-legacy-provider"],
        env: {
          ...process.env,
          EUFY_CHILD_CONFIG: JSON.stringify(toChildConfig(this.config)),
        },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });

      this.child.on("message", (msg: ChildMessage) => this.onChildMessage(msg));
      this.child.on("exit", (code) => this.onChildExit(code));
      this.child.on("error", (err) => {
        this.logger.error("child process error", err);
        this.readyReject?.(err);
        this.readyResolve = undefined;
        this.readyReject = undefined;
        this.child?.removeAllListeners();
      });
    });
  }

  private onChildExit(code: number | null): void {
    this.logger.warn(
      `child exited (code ${code}); rejecting ${this.pending.size} pending`,
    );
    for (const [, p] of this.pending) {
      p.reject(new Error("child process exited"));
    }
    this.pending.clear();
    for (const pair of this.streams.values()) {
      pair.video.destroy();
      pair.audio.destroy();
    }
    this.streams.clear();
    this.child = undefined;
    this.emit("disconnected");
  }

  private onChildMessage(msg: ChildMessage): void {
    switch (msg.type) {
      case "ready":
        this.readyResolve?.();
        this.readyResolve = undefined;
        this.readyReject = undefined;
        break;
      case "result": {
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          p.resolve(msg.payload);
        }
        break;
      }
      case "error": {
        const err = new Error(msg.message);
        if (msg.code) {
          (err as Error & { code?: string }).code = msg.code;
        }
        if (msg.requestId) {
          const p = this.pending.get(msg.requestId);
          if (p) {
            this.pending.delete(msg.requestId);
            p.reject(err);
          }
        } else if (this.readyReject) {
          this.readyReject(err);
          this.readyReject = undefined;
        } else {
          this.logger.error("child error", err);
        }
        break;
      }
      case "event:connected":
        this.emit("connected");
        break;
      case "event:disconnected":
        this.emit("disconnected");
        break;
      case "tfa_request":
        this.emit("tfaRequest");
        break;
      case "captcha_request":
        this.emit("captchaRequest", msg.captchaId, msg.captchaB64);
        break;
      case "event:motionDetected":
      case "event:personDetected":
      case "event:petDetected":
      case "event:vehicleDetected":
      case "event:soundDetected":
        this.emit("motionDetected", msg.deviceSerial, msg.state);
        break;
      case "event:livestreamStart": {
        const pair: ChildStreamPair = {
          video: new PassThrough(),
          audio: new PassThrough(),
        };
        this.streams.set(msg.deviceSerial, pair);
        this.emit("livestreamStart", {
          deviceSerial: msg.deviceSerial,
          metadata: msg.metadata,
          videoStream: pair.video,
          audioStream: pair.audio,
        });
        break;
      }
      case "event:livestreamVideoChunk": {
        const pair = this.streams.get(msg.deviceSerial);
        pair?.video.write(Buffer.from(msg.chunkB64, "base64"));
        break;
      }
      case "event:livestreamAudioChunk": {
        const pair = this.streams.get(msg.deviceSerial);
        pair?.audio.write(Buffer.from(msg.chunkB64, "base64"));
        break;
      }
      case "event:livestreamStop": {
        const pair = this.streams.get(msg.deviceSerial);
        pair?.video.end();
        pair?.audio.end();
        this.streams.delete(msg.deviceSerial);
        this.emit("livestreamStop", msg.deviceSerial);
        break;
      }
      case "event:livestreamError":
        this.emit("livestreamError", msg.deviceSerial, new Error(msg.message));
        break;
      case "event:guardMode":
        this.emit("guardMode", msg.stationSerial, msg.mode);
        break;
      case "event:talkbackStart":
        this.emit("talkbackStart", msg.deviceSerial);
        break;
      case "event:stationAdded":
        this.emit("stationAdded", msg.station);
        break;
      case "event:deviceAdded":
        this.emit("deviceAdded", msg.device);
        break;
      default:
        this.logger.debug(
          "unhandled child message",
          (msg as { type: string }).type,
        );
    }
  }

  /** Send a request to the child and await its correlated reply. */
  private request(
    type: ParentMessage["type"],
    extra: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.child) {
        reject(new Error("child process not running"));
        return;
      }
      const requestId = makeRequestId();
      this.pending.set(requestId, { resolve, reject });
      const message = { type, requestId, ...extra } as ParentMessage;
      this.child.send(message, (err) => {
        if (err) {
          this.pending.delete(requestId);
          reject(err);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.child) {
      await this.request("disconnect", {}).catch(() => undefined);
      this.child.kill();
      this.child = undefined;
    }
  }

  async getStations(): Promise<StationInfo[]> {
    return (await this.request("getStations", {})) as StationInfo[];
  }

  async getDevices(): Promise<DeviceInfo[]> {
    return (await this.request("getDevices", {})) as DeviceInfo[];
  }

  async startLivestream(deviceSerial: string): Promise<void> {
    await this.request("startLivestream", { deviceSerial });
  }

  async stopLivestream(deviceSerial: string): Promise<void> {
    await this.request("stopLivestream", { deviceSerial });
  }

  async isLiveStreaming(deviceSerial: string): Promise<boolean> {
    return (await this.request("isLiveStreaming", { deviceSerial })) as boolean;
  }

  async panAndTilt(
    deviceSerial: string,
    direction: PanTiltDirection,
  ): Promise<void> {
    await this.request("panAndTilt", { deviceSerial, direction });
  }

  async rotate360(deviceSerial: string): Promise<void> {
    await this.request("rotate360", { deviceSerial });
  }

  async startTalkback(deviceSerial: string): Promise<void> {
    await this.request("startTalkback", { deviceSerial });
  }

  async stopTalkback(deviceSerial: string): Promise<void> {
    await this.request("stopTalkback", { deviceSerial });
  }

  async transmitAudio(deviceSerial: string, buffer: Buffer): Promise<void> {
    await this.request("transmitAudio", {
      deviceSerial,
      bufferB64: buffer.toString("base64"),
    });
  }

  async setGuardMode(stationSerial: string, mode: number): Promise<void> {
    await this.request("setGuardMode", { stationSerial, mode });
  }

  async setDeviceProperty(
    serial: string,
    name: string,
    value: unknown,
  ): Promise<void> {
    await this.request("setProperty", { serial, name, value });
  }

  async getSnapshot(deviceSerial: string): Promise<Buffer | undefined> {
    const b64 = (await this.request("getSnapshot", { deviceSerial })) as
      | string
      | null;
    return b64 ? Buffer.from(b64, "base64") : undefined;
  }
}

/**
 * Build a connected {@link IEufyClient}. Tries the in-process direct client
 * first; on a crypto-padding failure ({@link EufyCryptoError}) it transparently
 * falls back to the legacy-crypto child process.
 */
export async function createEufyClient(
  config: EufyPluginConfig,
): Promise<IEufyClient> {
  const log = new Logger("EufyFactory");
  try {
    const client = new DirectEufyClient(config);
    await client.connect();
    log.info("connected via in-process direct client");
    return client;
  } catch (err) {
    if (err instanceof EufyCryptoError) {
      log.warn("PKCS1 not supported natively, using child process fallback");
      const fallback = new ChildProcessEufyClient(config);
      await fallback.connect();
      log.info("connected via legacy-crypto child process");
      return fallback;
    }
    throw err;
  }
}
