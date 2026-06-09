/**
 * Manages the lifecycle of physical livestream sessions on top of an
 * {@link IEufyClient}.
 *
 * Responsibilities:
 *  - **HomeBase 3 single-stream limit**: only one physical stream may run at a
 *    time. A new request pre-empts the running one (with a short grace pause).
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
import type { Readable } from "stream";
import {
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
}

const DEFAULTS: StreamManagerOptions = {
  startTimeoutMs: 20000,
  cleanupGraceMs: 30000,
  preemptPauseMs: 500,
  maxRestarts: 3,
};

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

  private onDisconnected(): void {
    const err = new Error("client disconnected");
    for (const [serial, waiter] of this.startWaiters) {
      this.startWaiters.delete(serial);
      waiter.reject(err);
    }
  }

  private onLivestreamStart(payload: LivestreamStartPayload): void {
    const waiter = this.startWaiters.get(payload.deviceSerial);
    if (waiter) {
      this.startWaiters.delete(payload.deviceSerial);
      waiter.resolve(payload);
    } else {
      // Unsolicited (re)start: refresh the stored streams if we already track it.
      const existing = this.streams.get(payload.deviceSerial);
      if (existing) {
        existing.videoStream = payload.videoStream;
        existing.audioStream = payload.audioStream;
        existing.metadata = payload.metadata;
      }
    }
  }

  private onLivestreamStop(deviceSerial: string): void {
    const physical = this.streams.get(deviceSerial);
    if (!physical) {
      return;
    }
    if (physical.consumers.size > 0) {
      this.log.warn(`unexpected stop for ${deviceSerial} with active consumers; restarting`);
      void this.restartStream(physical).catch((err) =>
        this.log.error("restartStream failed", err),
      );
    }
  }

  /**
   * Request a shared stream for `deviceSerial`. Returns a per-consumer
   * {@link StreamSession}; the underlying physical stream is started on first
   * consumer and reused thereafter.
   */
  async requestStream(deviceSerial: string): Promise<StreamSession> {
    // Serialise so enforceSingleStream + startPhysicalStream are atomic across
    // concurrent callers (e.g. HomeKit + NVR arriving at the same time).
    let release!: () => void;
    const prev = this.requestLock;
    this.requestLock = new Promise<void>((res) => {
      release = res;
    });
    await prev;

    let physical: PhysicalStream;
    try {
      physical = this.streams.get(deviceSerial) ?? (await (async () => {
        await this.enforceSingleStream(deviceSerial);
        return this.startPhysicalStream(deviceSerial);
      })());
    } finally {
      release();
    }

    if (physical.cleanupTimer) {
      clearTimeout(physical.cleanupTimer);
      physical.cleanupTimer = undefined;
    }

    const consumerId = makeRequestId();
    physical.consumers.add(consumerId);
    this.log.debug(`consumer ${consumerId} added to ${deviceSerial} (${physical.consumers.size})`);

    return {
      deviceSerial,
      videoStream: physical.videoStream,
      audioStream: physical.audioStream,
      metadata: physical.metadata,
      consumerId,
      release: () => this.releaseStream(deviceSerial, consumerId),
    };
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
    this.log.debug(`consumer ${consumerId} left ${deviceSerial} (${physical.consumers.size})`);

    if (physical.consumers.size === 0) {
      physical.cleanupTimer = setTimeout(() => {
        void this.stopPhysicalStream(deviceSerial);
      }, this.opts.cleanupGraceMs);
      physical.cleanupTimer.unref();
    }
  }

  /** Stop any other running stream to honour the single-stream limit. */
  private async enforceSingleStream(incomingSerial: string): Promise<void> {
    for (const [serial, physical] of this.streams) {
      if (serial === incomingSerial) {
        continue;
      }
      this.log.warn(`pre-empting stream ${serial} for ${incomingSerial} (HomeBase 3 limit)`);
      for (const consumerId of physical.consumers) {
        this.emit("interrupted", serial, consumerId, new StreamInterruptedError(serial));
      }
      await this.stopPhysicalStream(serial);
      await delay(this.opts.preemptPauseMs);
    }
  }

  /** Start a physical stream and wait for its `livestreamStart` event. */
  private async startPhysicalStream(deviceSerial: string): Promise<PhysicalStream> {
    const startPromise = new Promise<LivestreamStartPayload>((resolve, reject) => {
      this.startWaiters.set(deviceSerial, { resolve, reject });
    });

    await this.client.startLivestream(deviceSerial);

    let payload: LivestreamStartPayload;
    try {
      payload = await withTimeout(
        startPromise,
        this.opts.startTimeoutMs,
        () => new StreamTimeoutError(deviceSerial),
      );
    } catch (err) {
      this.startWaiters.delete(deviceSerial);
      await this.client.stopLivestream(deviceSerial).catch(() => undefined);
      throw err;
    }

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
      this.log.error(`max restarts reached for ${physical.deviceSerial}; giving up`);
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
    const serials = [...this.streams.keys()];
    await Promise.all(serials.map((s) => this.stopPhysicalStream(s)));
  }
}
