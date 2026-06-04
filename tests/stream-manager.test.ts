import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { StreamManager } from "../src/stream-manager";
import type { IEufyClient } from "../src/types";

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

function makeManager(): { client: FakeClient; manager: StreamManager } {
  const client = new FakeClient();
  const manager = new StreamManager(client as unknown as IEufyClient, {
    startTimeoutMs: 1000,
    cleanupGraceMs: 30000,
    preemptPauseMs: 10,
    maxRestarts: 3,
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

  it("times out when the stream never starts", async () => {
    const client = new FakeClient();
    client.startLivestream = jest.fn(async (_serial: string) => undefined); // never emits start
    const manager = new StreamManager(client as unknown as IEufyClient, {
      startTimeoutMs: 50,
      cleanupGraceMs: 30000,
      preemptPauseMs: 10,
      maxRestarts: 3,
    });
    await expect(manager.requestStream("CAM1")).rejects.toThrow(/did not start/);
  });
});
