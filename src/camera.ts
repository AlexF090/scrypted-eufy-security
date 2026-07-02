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
  label: string,
): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      log.info(`[${label}] consumer connected from :${socket.remotePort}`);
      let bytes = 0;
      let firstChunk = true;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (firstChunk) {
          firstChunk = false;
          log.info(`[${label}] first chunk: ${chunk.length} bytes`);
        }
      });
      stream.pipe(socket);
      socket.on("error", (err) =>
        log.info(`[${label}] consumer socket error: ${err.message}`),
      );
      socket.on("close", () =>
        log.info(`[${label}] consumer socket closed after ${bytes} bytes`),
      );
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        log.info(`[${label}] hosting on tcp://127.0.0.1:${address.port}`);
        resolve({ port: address.port, server });
      } else {
        server.close();
        reject(new Error("failed to bind TCP server"));
      }
    });
    // Close on end, close, or error — PassThrough emits "end" without "close".
    const closeServer = (reason: string) => (): void => {
      log.info(`[${label}] source stream ${reason}`);
      try {
        server.close();
      } catch {
        // server may already be closed
      }
    };
    stream.once("end", closeServer("ended"));
    stream.once("close", closeServer("closed"));
    stream.once("error", closeServer("errored"));
  });
}

/**
 * Spawn an internal FFmpeg muxer that reads raw H.264/HEVC + AAC ADTS from two
 * TCP sockets and outputs a single MPEG-TS stream on stdout.
 *
 * This is necessary because:
 * - Live TCP streams default to analyzeduration=0, causing FFmpeg to give up
 *   before finding the H.264 SPS (which carries resolution information).
 *
 * AAC stays ADTS-framed end to end: MPEG-TS requires per-frame ADTS headers,
 * unlike MP4/MOV containers which want the bare "ASC" bitstream. Running
 * `aac_adtstoasc` here strips those headers before the mpegts muxer writes
 * them, which corrupts every AAC frame downstream (Rebroadcast Plugin's
 * FFmpeg then fails to parse the stream at all — no output arguments hook
 * exists to fix this on the consumer side, so it must not be applied here).
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
    private readonly isPrebufferCamera: () => boolean = () => false,
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
    this.logger.info(
      `getVideoStream requested (destination=${options?.destination ?? "<none>"}, id=${options?.id ?? "<none>"})`,
    );
    // Serialise concurrent callers so only one TCP-server setup runs at a time.
    let release!: () => void;
    const prev = this.streamRequestLock;
    this.streamRequestLock = new Promise<void>((res) => {
      release = res;
    });
    await prev;

    try {
      const result = await this.doGetVideoStream(options?.destination);
      this.logger.info("getVideoStream fulfilled");
      return result;
    } catch (err) {
      this.logger.error(
        `getVideoStream failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      throw err;
    } finally {
      release();
    }
  }

  /**
   * The Rebroadcast plugin's prebuffer session calls getVideoStream() with no
   * destination at all, and recorder requests use "local-recorder" /
   * "remote-recorder" — both are background consumers that must not pre-empt
   * a running stream (force=false, StreamBusyError if the slot is taken).
   * Interactive viewers (WebRTC, HomeKit) always set an explicit destination
   * such as "local" or "remote" — those pass force=true and pre-empt.
   */
  private isInteractiveDestination(
    destination?: MediaStreamDestination,
  ): boolean {
    return (
      destination !== undefined &&
      destination !== "local-recorder" &&
      destination !== "remote-recorder"
    );
  }

  private async doGetVideoStream(
    destination?: MediaStreamDestination,
  ): Promise<MediaObject> {
    const force = this.isInteractiveDestination(destination);
    this.logger.info(
      `doGetVideoStream: destination=${destination ?? "<none>"} force=${force}`,
    );

    // Release any previous session so we don't accumulate TCP servers.
    if (this.activeSession) {
      this.logger.info("releasing previous stream session and TCP servers");
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
        this.logger.info(
          `stream slot busy for ${this.deviceInfo.serial}; Rebroadcast will retry`,
        );
      }
      throw err;
    }
    this.activeSession = session;
    this.logger.info(
      `stream session acquired: metadata=${JSON.stringify(session.metadata)}`,
    );

    const videoCodec = /hevc|h265/i.test(session.metadata.videoCodec)
      ? "hevc"
      : "h264";

    let videoResult: { port: number; server: net.Server };
    let audioResult: { port: number; server: net.Server };
    try {
      videoResult = await hostStreamOnTcp(
        session.videoStream,
        this.logger,
        "video-in",
      );
      try {
        audioResult = await hostStreamOnTcp(
          session.audioStream,
          this.logger,
          "audio-in",
        );
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
    this.logger.info(
      `muxer spawned: pid=${muxProcess.pid} ffmpeg=${ffmpegPath} videoCodec=${videoCodec} videoPort=${videoResult.port} audioPort=${audioResult.port}`,
    );
    muxProcess.stderr?.on("data", (chunk: Buffer) => {
      this.logger.info(`[muxer] ${chunk.toString().trim()}`);
    });
    muxProcess.on("exit", (code, signal) => {
      this.logger.info(`[muxer] exited: code=${code} signal=${signal}`);
    });
    muxProcess.on("error", (err) => {
      this.logger.error(`[muxer] spawn error: ${err.message}`);
    });

    let muxResult: { port: number; server: net.Server };
    try {
      muxResult = await hostStreamOnTcp(
        muxProcess.stdout!,
        this.logger,
        "mux-out",
      );
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
    this.logger.info(
      `returning FFmpegInput: tcp://127.0.0.1:${muxResult.port} (mpegts)`,
    );

    return mediaManager.createFFmpegMediaObject(ffmpegInput);
  }

  private buildStreamOptions(): ResponseMediaStreamOptions {
    const { width, height } = resolutionHint(this.deviceInfo.model);
    return {
      id: "p2p",
      name: "P2P Stream",
      prebuffer: 0,
      // HomeBase 3 allows a single stream, so the Rebroadcast plugin must not
      // auto-prebuffer every camera. source "cloud" disables its default
      // prebuffer; only the user-selected prebuffer camera omits it.
      ...(this.isPrebufferCamera() ? {} : { source: "cloud" as const }),
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
