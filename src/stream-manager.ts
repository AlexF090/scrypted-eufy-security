/**
 * Manages the lifecycle of physical livestream sessions on top of an
 * {@link IEufyClient}.
 *
 * Responsibilities:
 *  - **HomeBase single-stream limit**: HomeBase 2/older and HomeBase 3 allow
 *    only one physical camera stream at a time. A forced (interactive) request
 *    pre-empts the running one (with a short grace pause); a non-forced
 *    (prebuffer) request fails fast with StreamBusyError while another camera
 *    holds the slot.
 *  - **Session reuse / reference counting**: multiple consumers (HomeKit + NVR)
 *    share one physical stream.
 *  - **Auto-cleanup**: a stream with zero consumers is stopped after a grace
 *    period.
 *  - **Start timeout**: starting a stream must yield a `livestreamStart` within
 *    a bounded time, otherwise it rejects.
 *  - **Auto-restart**: an unexpected stop while consumers remain triggers a
 *    bounded number of restarts.
 */
import { EventEmitter } from "events";
import { PassThrough, type Readable } from "stream";
import {
  StreamBusyError,
  StreamInterruptedError,
  StreamTimeoutError,
  type IEufyClient,
  type LivestreamStartPayload,
  type StreamMetadata,
} from "./types";
import { Logger, delay, makeRequestId, withTimeout } from "./utils";

/** Tunable timing constants (milliseconds). */
export interface StreamManagerOptions {
  startTimeoutMs: number;
  cleanupGraceMs: number;
  preemptPauseMs: number;
  maxRestarts: number;
  /** Maximum number of concurrent physical streams. 1 for single-stream HomeBases; Infinity for all others. */
  maxConcurrentStreams: number;
}

const DEFAULTS: StreamManagerOptions = {
  startTimeoutMs: 60000,
  cleanupGraceMs: 30000,
  preemptPauseMs: 500,
  maxRestarts: 3,
  maxConcurrentStreams: 1,
};

/**
 * Pipe a raw eufy Readable into a PassThrough buffer so that SPS/PPS NAL
 * units emitted before FFmpeg connects to the TCP socket are not lost.
 * eufy-security-client streams may already be in flowing mode when handed
 * to us (internal listeners attached), so piping immediately is the only
 * safe way to preserve the initial bitstream header.
 */
function bufferStream(source: Readable, highWaterMark: number): Readable {
  const pt = new PassThrough({ highWaterMark });
  source.pipe(pt);
  source.on("error", (err) => pt.destroy(err));
  return pt;
}

/** A handle handed to a single stream consumer. */
export interface StreamSession {
  deviceSerial: string;
  videoStream: Readable;
  audioStream: Readable;
  metadata: StreamMetadata;
  consumerId: string;
  /** Release this consumer's hold on the shared physical stream. */
  release: () => Promise<void>;
}

interface PhysicalStream {
  deviceSerial: string;
  videoStream: Readable;
  audioStream: Readable;
  metadata: StreamMetadata;
  consumers: Set<string>;
  cleanupTimer?: NodeJS.Timeout;
  restarts: number;
}

interface StartWaiter {
  resolve: (payload: LivestreamStartPayload) => void;
  reject: (err: Error) => void;
}

/**
 * Coordinates physical streams and consumer reference counts.
 */
export class StreamManager extends EventEmitter {
  private readonly log: Logger;
  private readonly opts: StreamManagerOptions;
  private readonly streams = new Map<string, PhysicalStream>();
  /** Waiters for the next `livestreamStart` per device, with reject support. */
  private readonly startWaiters = new Map<string, StartWaiter>();
  /** Serialises requestStream() so enforceSingleStream + start are atomic. */
  private requestLock: Promise<void> = Promise.resolve();

  private disconnected = false;

  private readonly onLivestreamStartBound = (p: LivestreamStartPayload): void =>
    this.onLivestreamStart(p);
  private readonly onLivestreamStopBound = (s: string): void =>
    this.onLivestreamStop(s);
  private readonly onDisconnectedBound = (): void => this.onDisconnected();

  constructor(
    private readonly client: IEufyClient,
    options: Partial<StreamManagerOptions> = {},
  ) {
    super();
    this.log = new Logger("StreamManager");
    this.opts = { ...DEFAULTS, ...options };

    this.client.on("livestreamStart", this.onLivestreamStartBound);
    this.client.on("livestreamStop", this.onLivestreamStopBound);
    this.client.on("disconnected", this.onDisconnectedBound);
  }

  /** Remove client event listeners (call before discarding this instance). */
  destroy(): void {
    this.client.removeListener("livestreamStart", this.onLivestreamStartBound);
    this.client.removeListener("livestreamStop", this.onLivestreamStopBound);
    this.client.removeListener("disconnected", this.onDisconnectedBound);
  }

  /** Reset the disconnected flag after a successful client reconnect. */
  reset(): void {
    this.disconnected = false;
  }

  private onDisconnected(): void {
    this.disconnected = true;
    const err = new Error("client disconnected");
    for (const [serial, waiter] of this.startWaiters) {
      this.startWaiters.delete(serial);
      waiter.reject(err);
    }
  }

  private onLivestreamStart(payload: LivestreamStartPayload): void {
    // Wrap both streams synchronously here — still inside the event callback,
    // before any async gap — so pipe() is established immediately. HomeBase
    // cameras send SPS/PPS/VPS only once at stream start; if bufferStream is
    // called after an await (e.g. after waiter.resolve resolves) those initial
    // NAL units may already have been drained from the source PassThrough.
    const buffered: LivestreamStartPayload = {
      ...payload,
      videoStream: bufferStream(payload.videoStream, 1024 * 1024),
      audioStream: bufferStream(payload.audioStream, 256 * 1024),
    };

    const waiter = this.startWaiters.get(payload.deviceSerial);
    if (waiter) {
      this.startWaiters.delete(payload.deviceSerial);
      waiter.resolve(buffered);
    } else {
      // Unsolicited (re)start: refresh the stored streams if we already track it.
      const existing = this.streams.get(payload.deviceSerial);
      if (existing) {
        existing.videoStream = buffered.videoStream;
        existing.audioStream = buffered.audioStream;
        existing.metadata = buffered.metadata;
      }
    }
  }

  private onLivestreamStop(deviceSerial: string): void {
    const physical = this.streams.get(deviceSerial);
    if (!physical) {
      return;
    }
    if (physical.consumers.size > 0) {
      this.log.warn(
        `unexpected stop for ${deviceSerial} with active consumers; restarting`,
      );
      void this.restartStream(physical).catch((err) =>
        this.log.error("restartStream failed", err),
      );
    }
  }

  /**
   * Request a shared stream for `deviceSerial`. Returns a per-consumer
   * {@link StreamSession}; the underlying physical stream is started on first
   * consumer and reused thereafter.
   *
   * @param force When true, pre-empts any running stream of another camera.
   *   Pass true for interactive (user-viewing) requests; false (default) for
   *   background prebuffer requests, which never pre-empt and instead fail
   *   fast with {@link StreamBusyError} while the slot is taken.
   */
  async requestStream(
    deviceSerial: string,
    force = false,
  ): Promise<StreamSession> {
    this.log.info(
      `requestStream: ${deviceSerial} force=${force} tracked=[${this.describeStreams()}]`,
    );
    // Fast-path: a non-forced (background) request never pre-empts. Reject
    // immediately without acquiring the mutex so the Rebroadcast plugin's
    // startup burst cannot queue all cameras and cycle through pre-emptions.
    // Only applies when the station has a single-stream hardware limit.
    if (
      !force &&
      !this.streams.has(deviceSerial) &&
      this.hasActiveForeignStream(deviceSerial) &&
      this.opts.maxConcurrentStreams <= 1
    ) {
      throw new StreamBusyError(deviceSerial);
    }

    // Serialise so enforceSingleStream + startPhysicalStream are atomic across
    // concurrent callers (e.g. HomeKit + NVR arriving at the same time).
    let release!: () => void;
    const prev = this.requestLock;
    this.requestLock = new Promise<void>((res) => {
      release = res;
    });
    await prev;

    let session: StreamSession;
    try {
      let physical = this.streams.get(deviceSerial);
      if (!physical) {
        // Re-check under the lock: a foreign stream may have started while
        // this request was waiting on the mutex.
        if (
          this.hasForeignStream(deviceSerial) &&
          this.opts.maxConcurrentStreams <= 1
        ) {
          if (this.hasActiveForeignStream(deviceSerial)) {
            if (!force) {
              throw new StreamBusyError(deviceSerial);
            }
            await this.enforceSingleStream(deviceSerial);
          } else {
            await this.stopIdleForeignStreams(deviceSerial);
          }
        }
        physical = await this.startPhysicalStream(deviceSerial);
      }

      if (physical.cleanupTimer) {
        clearTimeout(physical.cleanupTimer);
        physical.cleanupTimer = undefined;
      }

      const consumerId = makeRequestId();
      physical.consumers.add(consumerId);
      this.log.debug(
        `consumer ${consumerId} added to ${deviceSerial} (${physical.consumers.size})`,
      );

      session = {
        deviceSerial,
        videoStream: physical.videoStream,
        audioStream: physical.audioStream,
        metadata: physical.metadata,
        consumerId,
        release: () => this.releaseStream(deviceSerial, consumerId),
      };
    } finally {
      release();
    }

    return session;
  }

  /**
   * Release a consumer's hold. When the last consumer leaves, the physical
   * stream is scheduled for cleanup after the grace period.
   */
  async releaseStream(deviceSerial: string, consumerId: string): Promise<void> {
    const physical = this.streams.get(deviceSerial);
    if (!physical) {
      return;
    }
    physical.consumers.delete(consumerId);
    this.log.debug(
      `consumer ${consumerId} left ${deviceSerial} (${physical.consumers.size})`,
    );

    if (physical.consumers.size === 0) {
      physical.cleanupTimer = setTimeout(() => {
        void this.stopPhysicalStream(deviceSerial);
      }, this.opts.cleanupGraceMs);
      physical.cleanupTimer.unref();
    }
  }

  private describeStreams(): string {
    return [...this.streams.values()]
      .map((s) => `${s.deviceSerial}:${s.consumers.size}`)
      .join(",");
  }

  /** True when a physical stream of a *different* camera is tracked. */
  private hasForeignStream(deviceSerial: string): boolean {
    return [...this.streams.keys()].some((s) => s !== deviceSerial);
  }

  /** True when another camera has at least one active consumer. */
  private hasActiveForeignStream(deviceSerial: string): boolean {
    return [...this.streams.values()].some(
      (s) => s.deviceSerial !== deviceSerial && s.consumers.size > 0,
    );
  }

  /** Stop zero-consumer streams that are only being held during cleanup grace. */
  private async stopIdleForeignStreams(incomingSerial: string): Promise<void> {
    let stopped = false;
    for (const [serial, physical] of this.streams) {
      if (serial === incomingSerial || physical.consumers.size > 0) {
        continue;
      }
      this.log.info(
        `stopping idle stream ${serial} before starting ${incomingSerial} (HomeBase single-stream limit)`,
      );
      await this.stopPhysicalStream(serial);
      stopped = true;
    }
    if (stopped) {
      await delay(this.opts.preemptPauseMs);
    }
  }

  /** Stop any other running stream to honour the single-stream limit. */
  private async enforceSingleStream(incomingSerial: string): Promise<void> {
    for (const [serial, physical] of this.streams) {
      if (serial === incomingSerial) {
        continue;
      }
      this.log.warn(
        `pre-empting stream ${serial} for ${incomingSerial} (HomeBase single-stream limit)`,
      );
      for (const consumerId of physical.consumers) {
        this.emit(
          "interrupted",
          serial,
          consumerId,
          new StreamInterruptedError(serial),
        );
      }
      await this.stopPhysicalStream(serial);
      await delay(this.opts.preemptPauseMs);
    }
  }

  /** Start a physical stream and wait for its `livestreamStart` event. */
  private async startPhysicalStream(
    deviceSerial: string,
  ): Promise<PhysicalStream> {
    const startPromise = new Promise<LivestreamStartPayload>(
      (resolve, reject) => {
        this.startWaiters.set(deviceSerial, { resolve, reject });
      },
    );

    // Guard: onDisconnected() may have run before this call reached us (e.g. when
    // restartStream() is scheduled but the disconnect event fires first). In that
    // case the waiter above was never seen by onDisconnected() and would hang until
    // the 20 s start-timeout. Fail fast instead.
    if (this.disconnected) {
      this.startWaiters.delete(deviceSerial);
      throw new Error("client disconnected");
    }

    try {
      this.log.info(`startLivestream(${deviceSerial}) → P2P request sent`);
      await this.client.startLivestream(deviceSerial);
      this.log.info(
        `startLivestream(${deviceSerial}) acknowledged; waiting up to ${this.opts.startTimeoutMs}ms for livestreamStart event`,
      );

      const payload = await withTimeout(
        startPromise,
        this.opts.startTimeoutMs,
        () => new StreamTimeoutError(deviceSerial),
      );

      const physical: PhysicalStream = {
        deviceSerial,
        videoStream: payload.videoStream,
        audioStream: payload.audioStream,
        metadata: payload.metadata,
        consumers: new Set(),
        restarts: 0,
      };
      this.streams.set(deviceSerial, physical);
      this.log.info(`physical stream started for ${deviceSerial}`);
      return physical;
    } catch (err) {
      this.startWaiters.delete(deviceSerial);
      await this.client.stopLivestream(deviceSerial).catch(() => undefined);
      throw err;
    }
  }

  /** Stop and forget a physical stream. */
  private async stopPhysicalStream(deviceSerial: string): Promise<void> {
    const physical = this.streams.get(deviceSerial);
    if (!physical) {
      return;
    }
    if (physical.cleanupTimer) {
      clearTimeout(physical.cleanupTimer);
    }
    this.streams.delete(deviceSerial);
    this.startWaiters.delete(deviceSerial);
    await this.client.stopLivestream(deviceSerial).catch((err) => {
      this.log.warn(`stopLivestream(${deviceSerial}) failed`, err);
    });
    this.log.info(`physical stream stopped for ${deviceSerial}`);
  }

  /** Attempt to restart a stream that dropped while consumers remain. */
  private async restartStream(physical: PhysicalStream): Promise<void> {
    if (physical.restarts >= this.opts.maxRestarts) {
      this.log.error(
        `max restarts reached for ${physical.deviceSerial}; giving up`,
      );
      for (const consumerId of physical.consumers) {
        this.emit(
          "interrupted",
          physical.deviceSerial,
          consumerId,
          new StreamInterruptedError(physical.deviceSerial),
        );
      }
      this.streams.delete(physical.deviceSerial);
      return;
    }

    physical.restarts += 1;
    const consumers = new Set(physical.consumers);
    this.streams.delete(physical.deviceSerial);

    try {
      const restarted = await this.startPhysicalStream(physical.deviceSerial);
      restarted.consumers = consumers;
      restarted.restarts = physical.restarts;
      this.emit("restarted", physical.deviceSerial, {
        videoStream: restarted.videoStream,
        audioStream: restarted.audioStream,
        metadata: restarted.metadata,
      });
    } catch (err) {
      this.log.error(`restart of ${physical.deviceSerial} failed`, err);
      physical.consumers = consumers;
      this.streams.set(physical.deviceSerial, physical);
      await delay(this.opts.preemptPauseMs);
      void this.restartStream(physical).catch((err) =>
        this.log.error("restartStream (retry) failed", err),
      );
    }
  }

  /** Stop every physical stream (used on plugin shutdown). */
  async stopAll(): Promise<void> {
    let release!: () => void;
    const prev = this.requestLock;
    this.requestLock = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      // Mark as disconnected so any concurrent requestStream() call that is
      // waiting on the lock fails fast instead of starting a new stream after
      // we've finished stopping everything.
      this.disconnected = true;
      const serials = [...this.streams.keys()];
      await Promise.all(serials.map((s) => this.stopPhysicalStream(s)));
    } finally {
      release();
    }
  }
}
