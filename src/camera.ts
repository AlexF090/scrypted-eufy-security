/**
 * Scrypted device representing a single Eufy camera. Implements the camera,
 * streaming, motion, intercom and (optionally) PTZ interfaces, delegating the
 * actual work to the {@link StreamManager}, {@link TalkbackController} and
 * {@link PtzController}.
 */
import sdk, {
  ScryptedDeviceBase,
  ScryptedMimeTypes,
  SecuritySystemMode,
  type Camera,
  type FFmpegInput,
  type Intercom,
  type MediaObject,
  type MotionSensor,
  type PictureOptions,
  type RequestMediaStreamOptions,
  type ResponseMediaStreamOptions,
  type SecuritySystem,
  type SecuritySystemState,
  type Setting,
  type Settings,
  type VideoCamera,
} from "@scrypted/sdk";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import { Transform, type Readable } from "stream";
import { PtzController, type PanTiltZoomCommand } from "./ptz";
import type { StreamManager, StreamSession } from "./stream-manager";
import { TalkbackController } from "./talkback";
import { GuardMode, StreamBusyError, type DeviceInfo, type IEufyClient, type StationInfo, type StreamMetadata } from "./types";
import { Logger, withTimeout } from "./utils";

const { mediaManager } = sdk;
const DISABLE_AUDIO_KEY = "disableAudio";

function safeClose(server: net.Server): void {
  try {
    server.close();
  } catch {
    // already closed
  }
}

function imageMimeType(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  return undefined;
}

function byteSignature(buffer: Buffer): string {
  return buffer.subarray(0, 12).toString("hex") || "<empty>";
}

interface NalUnit {
  offset: number;
  type: number;
}

function isParameterSetNal(type: number, isHevc: boolean): boolean {
  return isHevc ? type === 32 || type === 33 || type === 34 : type === 7 || type === 8;
}

function isSyncFrameNal(type: number, isHevc: boolean): boolean {
  return isHevc ? type === 19 || type === 20 || type === 21 : type === 5;
}

function getNalType(data: Buffer, offset: number, isHevc: boolean): number {
  return isHevc ? (data[offset] >> 1) & 0x3f : data[offset] & 0x1f;
}

function findAnnexBNals(data: Buffer, isHevc: boolean): NalUnit[] {
  const nals: NalUnit[] = [];
  for (let i = 0; i <= data.length - 4; i++) {
    // 4-byte start code: 00 00 00 01
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      if (i + 4 >= data.length) break;
      nals.push({ offset: i, type: getNalType(data, i + 4, isHevc) });
      i += 3;
      continue;
    }
    // 3-byte start code: 00 00 01
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (i + 3 >= data.length) break;
      nals.push({ offset: i, type: getNalType(data, i + 3, isHevc) });
      i += 2;
    }
  }
  return nals;
}

/**
 * Scan an Annex B buffer for a self-contained decode point. Returns the byte
 * offset of the first nearby parameter set before the first IDR/CRA frame.
 */
function findSyncFrameStart(data: Buffer, isHevc: boolean): number {
  const nals = findAnnexBNals(data, isHevc);
  let parameterSetOffset = -1;
  for (const nal of nals) {
    if (isParameterSetNal(nal.type, isHevc)) {
      if (parameterSetOffset < 0) {
        parameterSetOffset = nal.offset;
      }
      continue;
    }
    if (isSyncFrameNal(nal.type, isHevc) && parameterSetOffset >= 0) {
      return parameterSetOffset;
    }
  }
  return -1;
}

/**
 * Wrap a video stream in a keyframe gate that discards all data until the
 * first parameter-set + IDR/CRA region, then passes everything through.
 *
 * This is necessary when a physical stream is reused across mux restarts: the
 * underlying PassThrough has been accumulating live P-frames in its buffer.
 * If a new FFmpeg mux connects mid-GOP it receives P-frames before SPS/PPS,
 * causing "non-existing PPS 0 referenced" parse errors and leaving dump_extra
 * with no parameter sets to prepend. Gating to the next keyframe boundary
 * guarantees the mux starts on a real sync frame with codec parameter sets.
 */
function createKeyframeGate(source: Readable, isHevc: boolean, log: Logger): Transform {
  let synced = false;
  let pending = Buffer.alloc(0);

  const gate = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (synced) {
        cb(null, chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const offset = findSyncFrameStart(pending, isHevc);
      if (offset >= 0) {
        synced = true;
        log.info(`[keyframe-gate] synced at offset ${offset} (${isHevc ? "HEVC" : "H.264"})`);
        cb(null, pending.subarray(offset));
        pending = Buffer.alloc(0);
      } else {
        // Keep last 8 bytes in case a start code spans chunk boundaries
        if (pending.length > 4 * 1024 * 1024) pending = pending.subarray(pending.length - 8);
        cb();
      }
    },
    flush(cb) { cb(); },
  });

  source.pipe(gate);
  source.on("error", (err) => gate.destroy(err));
  return gate;
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
      const dumpLimit = 64 * 1024;
      const shouldDump =
        label === "video-in" && process.env.EUFY_DEBUG_DUMP_VIDEO === "1";
      let dumpFile: fs.WriteStream | undefined;
      let dumpBytes = 0;
      if (shouldDump) {
        const dumpPath = `/tmp/eufy-hevc-dump-${Date.now()}.h265`;
        dumpFile = fs.createWriteStream(dumpPath);
        log.info(`[${label}] debug dump enabled: ${dumpPath}`);
      }
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (firstChunk) {
          firstChunk = false;
          log.info(`[${label}] first chunk: ${chunk.length} bytes`);
        }
        if (dumpFile && dumpBytes < dumpLimit) {
          const remaining = dumpLimit - dumpBytes;
          const slice =
            chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          dumpFile.write(slice);
          dumpBytes += slice.length;
          if (dumpBytes >= dumpLimit) {
            log.info(`[${label}] debug dump reached ${dumpBytes} bytes, closing`);
            dumpFile.end();
            dumpFile = undefined;
          }
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
 * Spawn an FFmpeg process that reads raw H.264/HEVC + AAC ADTS from two TCP
 * sockets and writes a fragmented MP4 stream to stdout.
 *
 * fMP4 carries full codec parameters (video dimensions, AAC AudioSpecificConfig)
 * in the initial `moov` box. When Rebroadcast reads fMP4, it has all codec info
 * and can write a proper RTSP SDP — meaning WebRTC's FFmpeg (which probes with
 * probesize=512, analyzeduration=0) can decode the audio without any probing.
 * This avoids the "AAC with no global headers" and "0 channels" errors that
 * MPEG-TS + MP2/AAC combinations cause downstream.
 *
 * The bitstream filter normalizes the sample aspect ratio to the intended
 * display shape and prepends SPS/PPS before every IDR so consumers that join
 * mid-stream can decode without waiting for the next keyframe interval.
 */
function spawnMuxer(
  ffmpegPath: string,
  videoCodec: string,
  videoPort: number,
  audioPort: number,
  displayAspectRatio: string,
  sampleAspectRatio: string,
): ChildProcess {
  const videoBitstreamFilter =
    videoCodec === "hevc"
      ? `hevc_metadata=sample_aspect_ratio=${sampleAspectRatio},dump_extra`
      : `h264_metadata=sample_aspect_ratio=${sampleAspectRatio},dump_extra`;

  return spawn(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-analyzeduration",
      "10000000",
      "-thread_queue_size",
      "1024",
      "-f",
      videoCodec,
      "-i",
      `tcp://127.0.0.1:${videoPort}`,
      "-thread_queue_size",
      "1024",
      "-f",
      "aac",
      "-i",
      `tcp://127.0.0.1:${audioPort}`,
      "-vcodec",
      "copy",
      "-bsf:v",
      videoBitstreamFilter,
      "-acodec",
      "aac",
      "-b:a",
      "32k",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-aspect",
      displayAspectRatio,
      "-f",
      "mp4",
      "-movflags",
      "frag_keyframe+default_base_moof",
      "-frag_duration",
      "500000",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function modelResolutionHint(model: string): { width: number; height: number } {
  // E330 / Professional -> 4K, everything else -> 1080p. These are only hints:
  // FFmpeg still parses the real codec dimensions from the stream headers.
  if (/e330|professional|t8600/i.test(model)) {
    return { width: 3840, height: 2160 };
  }
  return { width: 1920, height: 1080 };
}

function modelAllowsPortraitAspect(model: string): boolean {
  return /doorbell|t82/i.test(model);
}

function hasPlausibleDisplayAspect(
  model: string,
  width: number,
  height: number,
): boolean {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return false;
  }

  const ratio = width / height;
  // Common camera display shapes. HomeBase 2 cameras may report odd
  // dimensions/SAR that make Scrypted lay them out as a skinny rectangle.
  const commonAspects = [16 / 9, 4 / 3, 1];
  if (modelAllowsPortraitAspect(model)) {
    commonAspects.push(3 / 4, 9 / 16);
  }
  return commonAspects.some(
    (known) => Math.abs(ratio - known) / known < 0.08,
  );
}

/** Resolution/AR hints for Scrypted layout and Rebroadcast stream selection. */
function resolutionHint(
  model: string,
  metadata?: StreamMetadata,
): { width: number; height: number } {
  if (
    metadata?.videoWidth &&
    metadata?.videoHeight &&
    hasPlausibleDisplayAspect(
      model,
      metadata.videoWidth,
      metadata.videoHeight,
    )
  ) {
    return {
      width: metadata.videoWidth,
      height: metadata.videoHeight,
    };
  }

  return modelResolutionHint(model);
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

function ratioString(numerator: number, denominator: number): string {
  const divisor = greatestCommonDivisor(numerator, denominator);
  return `${Math.round(numerator / divisor)}/${Math.round(denominator / divisor)}`;
}

function displayAspectRatio({ width, height }: { width: number; height: number }): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function sampleAspectRatio(
  coded: { width: number; height: number },
  display: { width: number; height: number },
): string {
  if (
    coded.width <= 0 ||
    coded.height <= 0 ||
    display.width <= 0 ||
    display.height <= 0
  ) {
    return "1/1";
  }

  return ratioString(display.width * coded.height, display.height * coded.width);
}

function streamShape(
  model: string,
  metadata?: StreamMetadata,
): {
  coded: { width: number; height: number };
  display: { width: number; height: number };
  displayAspectRatio: string;
  sampleAspectRatio: string;
} {
  const display = resolutionHint(model, metadata);
  const coded =
    metadata?.videoWidth && metadata?.videoHeight
      ? { width: metadata.videoWidth, height: metadata.videoHeight }
      : display;

  return {
    coded,
    display,
    displayAspectRatio: displayAspectRatio(display),
    sampleAspectRatio: sampleAspectRatio(coded, display),
  };
}

/**
 * One instance per Eufy camera.
 */
export class EufyCamera
  extends ScryptedDeviceBase
  implements Camera, VideoCamera, MotionSensor, Intercom, Settings, SecuritySystem
{
  private readonly logger: Logger;
  private readonly ptz?: PtzController;
  private readonly talkback: TalkbackController;
  private motionTimer?: NodeJS.Timeout;
  private activeSession?: StreamSession;
  private activeTcpServers: net.Server[] = [];
  private activeMuxProcess?: ChildProcess;
  /** Dimensions and codec from the most recent livestream start payload. */
  private streamMetadata?: StreamMetadata;
  /** Serialises concurrent getVideoStream() calls. */
  private streamRequestLock: Promise<void> = Promise.resolve();

  constructor(
    nativeId: string,
    private readonly client: IEufyClient,
    private readonly streamManager: StreamManager,
    private readonly deviceInfo: DeviceInfo,
    private readonly eventDurationSeconds: number,
    private readonly isPrebufferCamera: () => boolean = () => false,
    private readonly stationInfo?: StationInfo,
  ) {
    super(nativeId);
    this.logger = new Logger("Camera").child(deviceInfo.serial);
    this.talkback = new TalkbackController(client, deviceInfo.serial);
    if (deviceInfo.hasPanAndTilt) {
      this.ptz = new PtzController(client, deviceInfo.serial);
    }
    this.motionDetected = false;
    if (stationInfo) {
      this.updateGuardState(stationInfo.guardMode);
    }
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
    const mimeType = imageMimeType(buffer);
    if (!mimeType) {
      throw new Error(
        `snapshot for ${this.deviceInfo.serial} was not an image (signature=${byteSignature(buffer)})`,
      );
    }
    return mediaManager.createMediaObject(buffer, mimeType);
  }

  async getPictureOptions(): Promise<PictureOptions[]> {
    return [];
  }

  // ---- VideoCamera -----------------------------------------------------------

  async getVideoStream(
    options?: RequestMediaStreamOptions,
  ): Promise<MediaObject> {
    this.logger.info(
      `getVideoStream requested (destination=${options?.destination ?? "<none>"}, id=${options?.id ?? "<none>"}, route=${options?.route ?? "<none>"}, refresh=${options?.refresh ?? "<none>"}, prebuffer=${options?.prebuffer ?? "<none>"})`,
    );
    // Serialise concurrent callers so only one TCP-server setup runs at a time.
    let release!: () => void;
    const prev = this.streamRequestLock;
    this.streamRequestLock = new Promise<void>((res) => {
      release = res;
    });
    await prev;

    try {
      const result = await this.doGetVideoStream(options);
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
   * Recorder requests are background consumers that must not pre-empt a
   * running stream (force=false, StreamBusyError if the slot is taken).
   * Interactive viewers set an explicit destination. Rebroadcast on-demand
   * requests pass the selected stream option back to us with id/source but no
   * destination; non-prebuffer cameras should treat that as user-visible and
   * pre-empt the selected prebuffer camera.
   */
  private isInteractiveRequest(options?: RequestMediaStreamOptions): boolean {
    const destination = options?.destination;
    if (
      destination === "local-recorder" ||
      destination === "remote-recorder"
    ) {
      return false;
    }
    if (destination !== undefined) {
      return true;
    }

    return options?.id === "p2p" && !this.isPrebufferCamera();
  }

  private async doGetVideoStream(
    options?: RequestMediaStreamOptions,
  ): Promise<MediaObject> {
    const force = this.isInteractiveRequest(options);
    this.logger.info(
      `doGetVideoStream: destination=${options?.destination ?? "<none>"} id=${options?.id ?? "<none>"} force=${force}`,
    );

    // Always restart the mux on each getVideoStream() call so Rebroadcast
    // receives a fresh fMP4 stream starting with a new moov box. Reusing
    // a running mux causes Rebroadcast to reconnect mid-stream, missing the
    // moov and failing to detect video codec parameters on the second call.
    // The physical P2P stream stays alive via StreamManager's grace period.
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
    this.streamMetadata = session.metadata;
    this.logger.info(
      `stream session acquired: metadata=${JSON.stringify(session.metadata)}`,
    );

    const videoCodec =
      session.metadata.videoCodec === "h265" ? "hevc" : "h264";
    const shape = streamShape(this.deviceInfo.model, session.metadata);

    const gatedVideo = createKeyframeGate(session.videoStream, videoCodec === "hevc", this.logger);

    let videoResult: { port: number; server: net.Server };
    let audioResult: { port: number; server: net.Server };
    try {
      videoResult = await hostStreamOnTcp(
        gatedVideo,
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
      shape.displayAspectRatio,
      shape.sampleAspectRatio,
    );
    this.activeMuxProcess = muxProcess;
    this.logger.info(
      `muxer spawned: pid=${muxProcess.pid} ffmpeg=${ffmpegPath} videoCodec=${videoCodec} videoPort=${videoResult.port} audioPort=${audioResult.port} coded=${shape.coded.width}x${shape.coded.height} display=${shape.display.width}x${shape.display.height} dar=${shape.displayAspectRatio} sar=${shape.sampleAspectRatio}`,
    );
    muxProcess.stderr?.on("data", (chunk: Buffer) => {
      this.logger.info(`[muxer] ${chunk.toString().trim()}`);
    });
    muxProcess.on("exit", (code, signal) => {
      this.logger.info(`[muxer] exited: code=${code} signal=${signal}`);
      // Auto-release the stream slot so the HomeBase single-stream limit doesn't
      // stay permanently blocked if FFmpeg exits before the next getVideoStream call.
      if (this.activeMuxProcess === muxProcess) {
        this.activeMuxProcess = undefined;
        for (const srv of this.activeTcpServers) safeClose(srv);
        this.activeTcpServers = [];
        void this.activeSession?.release().catch(() => undefined);
        this.activeSession = undefined;
      }
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
      container: "mp4",
      mediaStreamOptions: this.buildStreamOptions(),
      inputArguments: [
        "-analyzeduration",
        "15000000",
        "-probesize",
        "10000000",
        "-f",
        "mp4",
        "-i",
        `tcp://127.0.0.1:${muxResult.port}`,
      ],
    };
    this.logger.info(
      `returning FFmpegInput: tcp://127.0.0.1:${muxResult.port}`,
    );

    return mediaManager.createFFmpegMediaObject(ffmpegInput);
  }

  private buildStreamOptions(): ResponseMediaStreamOptions {
    const meta = this.streamMetadata;
    const { width, height } = resolutionHint(this.deviceInfo.model, meta);
    const videoCodec =
      meta
        ? meta.videoCodec === "h265" || meta.videoCodec === "hevc"
          ? "h265"
          : "h264"
        : /e330|professional|t8600/i.test(this.deviceInfo.model)
          ? "h265"
          : "h264";
    const options = {
      id: "p2p",
      name: "P2P Stream",
      container: "mp4",
      prebuffer: 0,
      // Single-stream HomeBases must not auto-prebuffer every camera. source
      // "cloud" disables Rebroadcast's default prebuffer; only the
      // user-selected prebuffer camera omits it.
      ...(this.isPrebufferCamera() ? {} : { source: "cloud" as const }),
      video: {
        codec: videoCodec,
        width,
        height,
      },
      audio: this.isAudioDisabled()
        ? null
        : {
            codec: "aac",
          },
    };
    return options as ResponseMediaStreamOptions;
  }

  async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
    return [this.buildStreamOptions()];
  }

  private isAudioDisabled(): boolean {
    return this.storage.getItem(DISABLE_AUDIO_KEY) === "true";
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
        key: DISABLE_AUDIO_KEY,
        title: "Disable Stream Audio",
        description:
          "Disables audio in the advertised P2P stream. Useful when HomeKit/WebRTC hit RTSP audio transport errors.",
        type: "boolean",
        value: this.isAudioDisabled(),
      },
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
    if (key === DISABLE_AUDIO_KEY) {
      this.storage.setItem(DISABLE_AUDIO_KEY, String(value === true || value === "true"));
      return;
    }
    // Device-level toggles map straight onto Eufy properties.
    await this.client.setDeviceProperty(this.deviceInfo.serial, key, value);
  }

  // ---- SecuritySystem (only when this camera is also its own station) ----------

  private scryptedToGuardMode(mode: SecuritySystemMode): GuardMode {
    switch (mode) {
      case SecuritySystemMode.AwayArmed:
        return GuardMode.AWAY;
      case SecuritySystemMode.HomeArmed:
      case SecuritySystemMode.NightArmed:
        return GuardMode.HOME;
      default:
        return GuardMode.OFF;
    }
  }

  private guardModeToScrypted(mode: number): SecuritySystemMode {
    switch (mode) {
      case GuardMode.AWAY:
        return SecuritySystemMode.AwayArmed;
      case GuardMode.HOME:
        return SecuritySystemMode.HomeArmed;
      default:
        return SecuritySystemMode.Disarmed;
    }
  }

  /** Update guard-mode state; called from plugin event routing. */
  updateGuardState(guardMode: number): void {
    const state: SecuritySystemState = {
      mode: this.guardModeToScrypted(guardMode),
      triggered: false,
      supportedModes: [
        SecuritySystemMode.Disarmed,
        SecuritySystemMode.HomeArmed,
        SecuritySystemMode.AwayArmed,
        SecuritySystemMode.NightArmed,
      ],
    };
    this.securitySystemState = state;
  }

  async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
    if (!this.stationInfo) return;
    const guardMode = this.scryptedToGuardMode(mode);
    await this.client.setGuardMode(this.deviceInfo.serial, guardMode);
    this.updateGuardState(guardMode);
  }

  async disarmSecuritySystem(): Promise<void> {
    if (!this.stationInfo) return;
    await this.client.setGuardMode(this.deviceInfo.serial, GuardMode.OFF);
    this.updateGuardState(GuardMode.OFF);
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
