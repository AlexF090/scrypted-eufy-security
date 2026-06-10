/**
 * Scrypted device representing a single Eufy camera. Implements the camera,
 * streaming, motion, intercom and (optionally) PTZ interfaces, delegating the
 * actual work to the {@link StreamManager}, {@link TalkbackController} and
 * {@link PtzController}.
 */
import sdk, {
  ScryptedDeviceBase,
  ScryptedMimeTypes,
  type Camera,
  type FFmpegInput,
  type Intercom,
  type MediaObject,
  type MediaStreamDestination,
  type MotionSensor,
  type PictureOptions,
  type RequestMediaStreamOptions,
  type ResponseMediaStreamOptions,
  type Setting,
  type Settings,
  type VideoCamera,
} from "@scrypted/sdk";
import { spawn, type ChildProcess } from "child_process";
import net from "net";
import type { Readable } from "stream";
import { PtzController, type PanTiltZoomCommand } from "./ptz";
import type { StreamManager, StreamSession } from "./stream-manager";
import { TalkbackController } from "./talkback";
import type { DeviceInfo, IEufyClient } from "./types";
import { StreamBusyError } from "./types";
import { Logger, withTimeout } from "./utils";

const { mediaManager } = sdk;

function safeClose(server: net.Server): void {
  try {
    server.close();
  } catch {
    // already closed
  }
}

/** Host a raw stream on an ephemeral localhost TCP port. */
function hostStreamOnTcp(
  stream: Readable,
  log: Logger,
): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      stream.pipe(socket);
      socket.on("error", () => undefined);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        log.debug(`hosting stream on tcp ${address.port}`);
        resolve({ port: address.port, server });
      } else {
        server.close();
        reject(new Error("failed to bind TCP server"));
      }
    });
    // Close on end, close, or error — PassThrough emits "end" without "close".
    const closeServer = (): void => {
      try {
        server.close();
      } catch {
        // server may already be closed
      }
    };
    stream.once("end", closeServer);
    stream.once("close", closeServer);
    stream.once("error", closeServer);
  });
}

/**
 * Spawn an internal FFmpeg muxer that reads raw H.264/HEVC + AAC ADTS from two
 * TCP sockets and outputs a single MPEG-TS stream on stdout.
 *
 * This is necessary because:
 * - Scrypted's FFmpegInput has no outputArguments field, so we cannot add
 *   -bsf:a aac_adtstoasc to the Rebroadcast Plugin's FFmpeg command directly.
 * - Live TCP streams default to analyzeduration=0, causing FFmpeg to give up
 *   before finding the H.264 SPS (which carries resolution information).
 */
function spawnMuxer(
  ffmpegPath: string,
  videoCodec: string,
  videoPort: number,
  audioPort: number,
): ChildProcess {
  return spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-analyzeduration",
      "10000000",
      "-f",
      videoCodec,
      "-i",
      `tcp://127.0.0.1:${videoPort}`,
      "-f",
      "aac",
      "-i",
      `tcp://127.0.0.1:${audioPort}`,
      "-vcodec",
      "copy",
      "-acodec",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      "-f",
      "mpegts",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Resolution hints by model family for {@link getVideoStreamOptions}. */
function resolutionHint(model: string): { width: number; height: number } {
  // E330 / Professional → 4K, everything else → 1080p.
  if (/e330|professional|t8600/i.test(model)) {
    return { width: 3840, height: 2160 };
  }
  return { width: 1920, height: 1080 };
}

/**
 * One instance per Eufy camera.
 */
export class EufyCamera
  extends ScryptedDeviceBase
  implements Camera, VideoCamera, MotionSensor, Intercom, Settings
{
  private readonly logger: Logger;
  private readonly ptz?: PtzController;
  private readonly talkback: TalkbackController;
  private motionTimer?: NodeJS.Timeout;
  private activeSession?: StreamSession;
  private activeTcpServers: net.Server[] = [];
  private activeMuxProcess?: ChildProcess;
  /** Serialises concurrent getVideoStream() calls. */
  private streamRequestLock: Promise<void> = Promise.resolve();

  constructor(
    nativeId: string,
    private readonly client: IEufyClient,
    private readonly streamManager: StreamManager,
    private readonly deviceInfo: DeviceInfo,
    private readonly eventDurationSeconds: number,
  ) {
    super(nativeId);
    this.logger = new Logger("Camera").child(deviceInfo.serial);
    this.talkback = new TalkbackController(client, deviceInfo.serial);
    if (deviceInfo.hasPanAndTilt) {
      this.ptz = new PtzController(client, deviceInfo.serial);
    }
    this.motionDetected = false;
  }

  // ---- MotionSensor ----------------------------------------------------------

  /** Set motion state and schedule an auto-reset after the configured delay. */
  setMotion(state: boolean): void {
    this.motionDetected = state;
    if (this.motionTimer) {
      clearTimeout(this.motionTimer);
      this.motionTimer = undefined;
    }
    if (state) {
      this.motionTimer = setTimeout(() => {
        this.motionDetected = false;
        this.motionTimer = undefined;
      }, this.eventDurationSeconds * 1000);
    }
  }

  // ---- Camera ----------------------------------------------------------------

  async takePicture(_options?: PictureOptions): Promise<MediaObject> {
    const buffer = await withTimeout(
      this.client.getSnapshot(this.deviceInfo.serial),
      5000,
      () => new Error(`snapshot for ${this.deviceInfo.serial} timed out`),
    );
    if (!buffer) {
      throw new Error(`no snapshot available for ${this.deviceInfo.serial}`);
    }
    return mediaManager.createMediaObject(buffer, "image/jpeg");
  }

  async getPictureOptions(): Promise<PictureOptions[]> {
    return [];
  }

  // ---- VideoCamera -----------------------------------------------------------

  async getVideoStream(
    options?: RequestMediaStreamOptions,
  ): Promise<MediaObject> {
    // Serialise concurrent callers so only one TCP-server setup runs at a time.
    let release!: () => void;
    const prev = this.streamRequestLock;
    this.streamRequestLock = new Promise<void>((res) => {
      release = res;
    });
    await prev;

    try {
      return await this.doGetVideoStream(options?.destination);
    } finally {
      release();
    }
  }

  /**
   * Background prebuffer requests (destination "local-recorder" /
   * "remote-recorder") must not pre-empt a running stream — they pass
   * force=false and get StreamBusyError if the slot is taken.
   * Interactive viewing requests (any other destination, including undefined)
   * pass force=true and pre-empt immediately.
   */
  private isInteractiveDestination(
    destination?: MediaStreamDestination,
  ): boolean {
    return (
      destination !== "local-recorder" && destination !== "remote-recorder"
    );
  }

  private async doGetVideoStream(
    destination?: MediaStreamDestination,
  ): Promise<MediaObject> {
    const force = this.isInteractiveDestination(destination);

    // Release any previous session so we don't accumulate TCP servers.
    if (this.activeSession) {
      await this.activeSession.release().catch(() => undefined);
      this.activeSession = undefined;
      this.activeMuxProcess?.kill();
      this.activeMuxProcess = undefined;
      for (const srv of this.activeTcpServers) safeClose(srv);
      this.activeTcpServers = [];
    }

    let session;
    try {
      session = await this.streamManager.requestStream(
        this.deviceInfo.serial,
        force,
      );
    } catch (err) {
      if (err instanceof StreamBusyError) {
        this.logger.debug(
          `stream slot busy for ${this.deviceInfo.serial}; Rebroadcast will retry`,
        );
      }
      throw err;
    }
    this.activeSession = session;

    const videoCodec = /hevc|h265/i.test(session.metadata.videoCodec)
      ? "hevc"
      : "h264";

    let videoResult: { port: number; server: net.Server };
    let audioResult: { port: number; server: net.Server };
    try {
      videoResult = await hostStreamOnTcp(session.videoStream, this.logger);
      try {
        audioResult = await hostStreamOnTcp(session.audioStream, this.logger);
      } catch (err) {
        safeClose(videoResult.server);
        throw err;
      }
    } catch (err) {
      await session.release().catch(() => undefined);
      this.activeSession = undefined;
      throw err;
    }

    const ffmpegPath = await mediaManager.getFFmpegPath();
    const muxProcess = spawnMuxer(
      ffmpegPath,
      videoCodec,
      videoResult.port,
      audioResult.port,
    );
    this.activeMuxProcess = muxProcess;
    muxProcess.stderr?.on("data", (chunk: Buffer) => {
      this.logger.debug(`[muxer] ${chunk.toString().trim()}`);
    });

    let muxResult: { port: number; server: net.Server };
    try {
      muxResult = await hostStreamOnTcp(muxProcess.stdout!, this.logger);
    } catch (err) {
      muxProcess.kill();
      this.activeMuxProcess = undefined;
      safeClose(videoResult.server);
      safeClose(audioResult.server);
      await session.release().catch(() => undefined);
      this.activeSession = undefined;
      throw err;
    }

    this.activeTcpServers = [
      videoResult.server,
      audioResult.server,
      muxResult.server,
    ];

    const ffmpegInput: FFmpegInput = {
      url: undefined,
      mediaStreamOptions: this.buildStreamOptions(),
      inputArguments: [
        "-f",
        "mpegts",
        "-i",
        `tcp://127.0.0.1:${muxResult.port}`,
      ],
    };

    return mediaManager.createFFmpegMediaObject(ffmpegInput);
  }

  private buildStreamOptions(): ResponseMediaStreamOptions {
    const { width, height } = resolutionHint(this.deviceInfo.model);
    return {
      id: "p2p",
      name: "P2P Stream",
      prebuffer: 0,
      video: {
        codec: /e330|professional|t8600/i.test(this.deviceInfo.model)
          ? "h265"
          : "h264",
        width,
        height,
      },
      audio: {},
    };
  }

  async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
    return [this.buildStreamOptions()];
  }

  // ---- Intercom --------------------------------------------------------------

  async startIntercom(media: MediaObject): Promise<void> {
    if (!this.deviceInfo.hasIntercom) {
      this.logger.debug("startIntercom on camera without intercom; ignored");
      return;
    }
    const ffmpegInput =
      (await mediaManager.convertMediaObjectToJSON<FFmpegInput>(
        media,
        ScryptedMimeTypes.FFmpegInput,
      )) as FFmpegInput;

    const ffmpegPath = await mediaManager.getFFmpegPath();
    const inputArguments = ffmpegInput.inputArguments ?? [];
    await this.talkback.start({ ffmpegPath, inputArguments });
  }

  async stopIntercom(): Promise<void> {
    await this.talkback.stop();
  }

  // ---- PanTiltZoom (only present when hasPanAndTilt) --------------------------

  async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
    if (!this.ptz) {
      this.logger.debug("ptzCommand on non-PTZ camera; ignored");
      return;
    }
    await this.ptz.ptzCommand(command);
  }

  // ---- Settings --------------------------------------------------------------

  async getSettings(): Promise<Setting[]> {
    return [
      {
        key: "model",
        title: "Modell",
        readonly: true,
        value: this.deviceInfo.model,
      },
      {
        key: "serial",
        title: "Seriennummer",
        readonly: true,
        value: this.deviceInfo.serial,
      },
      {
        key: "online",
        title: "Online",
        readonly: true,
        type: "boolean",
        value: this.deviceInfo.isOnline,
      },
    ];
  }

  async putSetting(
    key: string,
    value: string | number | boolean,
  ): Promise<void> {
    // Device-level toggles map straight onto Eufy properties.
    await this.client.setDeviceProperty(this.deviceInfo.serial, key, value);
  }

  /** Release any active stream session held by this camera (shutdown). */
  async cleanup(): Promise<void> {
    if (this.motionTimer) {
      clearTimeout(this.motionTimer);
    }
    await this.talkback.stop().catch(() => undefined);
    await this.activeSession?.release().catch(() => undefined);
    this.activeSession = undefined;
    this.activeMuxProcess?.kill();
    this.activeMuxProcess = undefined;
    for (const srv of this.activeTcpServers) safeClose(srv);
    this.activeTcpServers = [];
  }
}
