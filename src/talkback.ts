/**
 * Two-way audio (talkback) controller.
 *
 * Eufy expects raw PCM audio frames. Scrypted hands us an arbitrary audio
 * `MediaObject` (typically an FFmpeg input), so we spawn FFmpeg to transcode it
 * to signed 16-bit little-endian mono PCM at 16 kHz and stream the output chunks
 * to the camera via {@link IEufyClient.transmitAudio}.
 */
import { type ChildProcess, spawn } from "child_process";
import type { IEufyClient } from "./types";
import { Logger } from "./utils";

/** FFmpeg input description used to start talkback. */
export interface TalkbackInput {
  /** Absolute path to the ffmpeg binary. */
  ffmpegPath: string;
  /** Input arguments produced by Scrypted (e.g. from an FFmpegInput object). */
  inputArguments: string[];
}

/** PCM format Eufy talkback expects. */
const PCM_ARGS = [
  "-f",
  "s16le",
  "-acodec",
  "pcm_s16le",
  "-ac",
  "1",
  "-ar",
  "16000",
  "pipe:1",
];

/**
 * Drives a single talkback session for one camera.
 */
export class TalkbackController {
  private readonly log: Logger;
  private ffmpeg?: ChildProcess;
  private active = false;

  constructor(
    private readonly client: IEufyClient,
    private readonly deviceSerial: string,
  ) {
    this.log = new Logger("Talkback").child(deviceSerial);
  }

  /**
   * Begin a talkback session: open the Eufy talkback channel, spawn FFmpeg to
   * produce PCM, and forward each PCM chunk to the camera.
   */
  async start(input: TalkbackInput): Promise<void> {
    if (this.active) {
      this.log.debug("talkback already active; restarting");
      await this.stop();
    }
    this.active = true;

    try {
      await this.client.startTalkback(this.deviceSerial);
    } catch (err) {
      this.active = false;
      throw err;
    }

    this.ffmpeg = spawn(input.ffmpegPath, [...input.inputArguments, ...PCM_ARGS], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.ffmpeg.stdout?.on("data", (chunk: Buffer) => {
      if (!this.active) {
        return;
      }
      this.client.transmitAudio(this.deviceSerial, chunk).catch((err) => {
        this.log.warn("transmitAudio failed", err);
      });
    });

    this.ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      this.log.debug("ffmpeg:", chunk.toString().trim());
    });

    this.ffmpeg.on("exit", (code) => {
      this.log.debug(`ffmpeg exited (code ${code})`);
      // active is already false when stop() initiates the kill; only
      // trigger cleanup when the exit is unexpected.
      if (this.active) {
        void this.stop();
      }
    });
  }

  /** End the talkback session and clean up FFmpeg + the Eufy channel. */
  async stop(): Promise<void> {
    if (!this.active) {
      return;
    }
    // Set active = false BEFORE the kill so the exit handler does not re-enter.
    this.active = false;

    if (this.ffmpeg) {
      this.ffmpeg.removeAllListeners();
      this.ffmpeg.kill("SIGKILL");
      this.ffmpeg = undefined;
    }
    await this.client.stopTalkback(this.deviceSerial).catch((err) => {
      this.log.warn("stopTalkback failed", err);
    });
  }

  /** Whether a session is currently active. */
  get isActive(): boolean {
    return this.active;
  }
}
