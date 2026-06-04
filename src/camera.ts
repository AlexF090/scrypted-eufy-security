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
  type MotionSensor,
  type PictureOptions,
  type RequestMediaStreamOptions,
  type ResponseMediaStreamOptions,
  type Setting,
  type Settings,
  type VideoCamera,
} from "@scrypted/sdk";
import net from "net";
import type { Readable } from "stream";
import type { IEufyClient, DeviceInfo } from "./types";
import type { StreamManager, StreamSession } from "./stream-manager";
import { PtzController, type PanTiltZoomCommand } from "./ptz";
import { TalkbackController } from "./talkback";
import { Logger, withTimeout } from "./utils";

const { mediaManager } = sdk;

/** Host a raw stream on an ephemeral localhost TCP port; resolves with the port. */
function hostStreamOnTcp(stream: Readable, log: Logger): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer((socket) => {
      stream.pipe(socket);
      socket.on("error", () => undefined);
      stream.on("end", () => socket.end());
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        log.debug(`hosting stream on tcp ${address.port}`);
        resolve(address.port);
      } else {
        reject(new Error("failed to bind TCP server"));
      }
    });
    // Close the server once the source ends; the socket already has the data.
    stream.on("close", () => server.close());
  });
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

  async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
    void options;
    const session = await this.streamManager.requestStream(this.deviceInfo.serial);
    this.activeSession = session;

    const videoCodec = /hevc|h265/i.test(session.metadata.videoCodec) ? "hevc" : "h264";
    const videoPort = await hostStreamOnTcp(session.videoStream, this.logger);
    const audioPort = await hostStreamOnTcp(session.audioStream, this.logger);

    const ffmpegInput: FFmpegInput = {
      url: undefined,
      mediaStreamOptions: this.buildStreamOptions(),
      inputArguments: [
        "-f",
        videoCodec,
        "-i",
        `tcp://127.0.0.1:${videoPort}`,
        "-f",
        "aac",
        "-i",
        `tcp://127.0.0.1:${audioPort}`,
      ],
    };

    return mediaManager.createFFmpegMediaObject(ffmpegInput);
  }

  private buildStreamOptions(): ResponseMediaStreamOptions {
    const { width, height } = resolutionHint(this.deviceInfo.model);
    return {
      id: "p2p",
      name: "P2P Stream",
      container: "rawvideo",
      video: {
        codec: /e330|professional|t8600/i.test(this.deviceInfo.model) ? "h265" : "h264",
        width,
        height,
      },
      audio: {
        codec: "aac",
      },
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
    const ffmpegInput = (await mediaManager.convertMediaObjectToJSON<FFmpegInput>(
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

  async putSetting(key: string, value: string | number | boolean): Promise<void> {
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
  }
}
