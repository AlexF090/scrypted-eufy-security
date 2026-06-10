import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { StreamManager } from "../src/stream-manager";
import type { IEufyClient } from "../src/types";
import { StreamBusyError } from "../src/types";

/** Minimal fake client that emits `livestreamStart` synchronously on start. */
class FakeClient extends EventEmitter {
  startLivestream = jest.fn(async (serial: string) => {
    this.emit("livestreamStart", {
      deviceSerial: serial,
      metadata: {
        videoCodec: "h264",
        audioCodec: "aac",
        videoFPS: 15,
        videoWidth: 1920,
        videoHeight: 1080,
      },
      videoStream: new PassThrough(),
      audioStream: new PassThrough(),
    });
  });
  stopLivestream = jest.fn(async () => undefined);
}

function makeManager(
  opts: Partial<ConstructorParameters<typeof StreamManager>[1]> = {},
): { client: FakeClient; manager: StreamManager } {
  const client = new FakeClient();
  const manager = new StreamManager(client as unknown as IEufyClient, {
    startTimeoutMs: 1000,
    cleanupGraceMs: 30000,
    preemptPauseMs: 10,
    maxRestarts: 3,
    minStreamDurationMs: 0, // disabled by default so existing tests are unaffected
    ...opts,
  });
  return { client, manager };
}

describe("StreamManager", () => {
  it("shares one physical stream between two consumers", async () => {
    const { client, manager } = makeManager();
    const a = await manager.requestStream("CAM1");
    const b = await manager.requestStream("CAM1");

    expect(client.startLivestream).toHaveBeenCalledTimes(1);
    expect(a.deviceSerial).toBe("CAM1");
    expect(b.deviceSerial).toBe("CAM1");
  });

  it("auto-cleans the stream after the grace period with no consumers", async () => {
    jest.useFakeTimers();
    try {
      const { client, manager } = makeManager();
      const session = await manager.requestStream("CAM1");
      await session.release();

      expect(client.stopLivestream).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(30000);
      expect(client.stopLivestream).toHaveBeenCalledWith("CAM1");
    } finally {
      jest.useRealTimers();
    }
  });

  it("pre-empts the running stream for a different device (HomeBase 3 limit)", async () => {
    const { client, manager } = makeManager();
    await manager.requestStream("CAM1");
    await manager.requestStream("CAM2");

    expect(client.stopLivestream).toHaveBeenCalledWith("CAM1");
    expect(client.startLivestream).toHaveBeenCalledWith("CAM2");
  });

  it("restarts the stream when it stops while a consumer is active", async () => {
    const { client, manager } = makeManager();
    await manager.requestStream("CAM1");
    expect(client.startLivestream).toHaveBeenCalledTimes(1);

    client.emit("livestreamStop", "CAM1");
    // Allow the async restart microtasks to settle.
    await new Promise((r) => setImmediate(r));

    expect(client.startLivestream).toHaveBeenCalledTimes(2);
  });

  it("allows new streams after reset() following stopAll()", async () => {
    const { client, manager } = makeManager();
    await manager.requestStream("CAM1");

    await manager.stopAll();
    await expect(manager.requestStream("CAM1")).rejects.toThrow(/disconnected/);

    manager.reset();
    const session = await manager.requestStream("CAM1");
    expect(session.deviceSerial).toBe("CAM1");
  });

  it("times out when the stream never starts", async () => {
    const client = new FakeClient();
    client.startLivestream = jest.fn(async (_serial: string) => undefined); // never emits start
    const manager = new StreamManager(client as unknown as IEufyClient, {
      startTimeoutMs: 50,
      cleanupGraceMs: 30000,
      preemptPauseMs: 10,
      maxRestarts: 3,
      minStreamDurationMs: 0,
    });
    await expect(manager.requestStream("CAM1")).rejects.toThrow(
      /did not start/,
    );
  });

  describe("minStreamDurationMs cooldown", () => {
    it("throws StreamBusyError when a background request arrives within the cooldown", async () => {
      const { manager } = makeManager({ minStreamDurationMs: 60000 });
      // CAM1 starts → sets lastStreamStartTime
      await manager.requestStream("CAM1");
      // CAM2 background request (force=false) → cooldown not expired → busy
      await expect(manager.requestStream("CAM2", false)).rejects.toBeInstanceOf(
        StreamBusyError,
      );
    });

    it("allows a forced (interactive) request to pre-empt within the cooldown", async () => {
      const { client, manager } = makeManager({ minStreamDurationMs: 60000 });
      await manager.requestStream("CAM1");
      // force=true bypasses the cooldown
      await manager.requestStream("CAM2", true);

      expect(client.stopLivestream).toHaveBeenCalledWith("CAM1");
      expect(client.startLivestream).toHaveBeenCalledWith("CAM2");
    });

    it("allows a background request once the cooldown has elapsed", async () => {
      const { client, manager } = makeManager({ minStreamDurationMs: 20 });
      await manager.requestStream("CAM1");

      // Within cooldown → busy
      await expect(manager.requestStream("CAM2", false)).rejects.toBeInstanceOf(
        StreamBusyError,
      );

      // Wait for cooldown to expire (real timers, small value)
      await new Promise((r) => setTimeout(r, 30));

      // Now the background request should succeed (pre-empts CAM1)
      await manager.requestStream("CAM2", false);
      expect(client.stopLivestream).toHaveBeenCalledWith("CAM1");
      expect(client.startLivestream).toHaveBeenCalledWith("CAM2");
    });

    it("does not apply the cooldown when no other stream is running", async () => {
      const { client, manager } = makeManager({ minStreamDurationMs: 60000 });
      // No stream running → background request should start immediately
      const session = await manager.requestStream("CAM1", false);
      expect(session.deviceSerial).toBe("CAM1");
      expect(client.startLivestream).toHaveBeenCalledWith("CAM1");
    });

    it("does not apply the cooldown when requesting the same device that is already streaming", async () => {
      const { client, manager } = makeManager({ minStreamDurationMs: 60000 });
      await manager.requestStream("CAM1");
      // Second consumer for the same device → reuse, no cooldown check
      const b = await manager.requestStream("CAM1", false);
      expect(client.startLivestream).toHaveBeenCalledTimes(1);
      expect(b.deviceSerial).toBe("CAM1");
    });
  });
});
