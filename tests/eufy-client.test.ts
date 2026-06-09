import { EventEmitter } from "events";

// --- Mock eufy-security-client ------------------------------------------------
class FakeEufySecurity extends EventEmitter {
  static initialize = jest.fn();
  connect = jest.fn(async () => undefined);
  close = jest.fn(async () => undefined);
  getStations = jest.fn(async () => []);
  getDevices = jest.fn(async () => []);
  getDevice = jest.fn(async (serial: string) => ({
    getSerial: () => serial,
    getStationSerial: () => "HB3",
  }));
  getStation = jest.fn(async (serial: string) => ({
    getSerial: () => serial,
    isLiveStreaming: () => true,
    panAndTilt: jest.fn(),
  }));
  startStationLivestream = jest.fn(async () => undefined);
  stopStationLivestream = jest.fn(async () => undefined);
  panAndTilt = jest.fn(async () => undefined);
  setStationProperty = jest.fn(async () => undefined);
  setDeviceProperty = jest.fn(async () => undefined);
  startStationTalkback = jest.fn(async () => undefined);
  stopStationTalkback = jest.fn(async () => undefined);
  transmitStationTalkbackAudio = jest.fn(async () => undefined);
}

jest.mock(
  "eufy-security-client",
  () => ({
    EufySecurity: FakeEufySecurity,
  }),
  { virtual: true },
);

// --- Mock child_process.fork for the fallback path ----------------------------
class FakeChild extends EventEmitter {
  killed = false;
  send = jest.fn((msg: { type: string; requestId: string }, cb?: (err?: Error) => void) => {
    // Auto-reply to every request with a null result on the next tick.
    setImmediate(() => this.emit("message", { type: "result", requestId: msg.requestId, payload: null }));
    cb?.();
    return true;
  });
  kill = jest.fn(() => {
    this.killed = true;
    return true;
  });
}

let lastChild: FakeChild;
jest.mock("child_process", () => ({
  fork: jest.fn(() => {
    lastChild = new FakeChild();
    // Emit ready shortly after spawn.
    setImmediate(() => lastChild.emit("message", { type: "ready" }));
    return lastChild;
  }),
}));

import {
  ChildProcessEufyClient,
  createEufyClient,
  DirectEufyClient,
} from "../src/eufy-client";
import { EufyCryptoError, type EufyPluginConfig } from "../src/types";
import { isCryptoPaddingError } from "../src/utils";

const config: EufyPluginConfig = {
  username: "u@example.com",
  password: "pw",
  country: "DE",
  language: "de",
  persistentDir: "/tmp/eufy",
  trustedDeviceName: "test",
  eventDurationSeconds: 10,
  p2pConnectionSetupTimeout: 120000,
};

describe("createEufyClient", () => {
  beforeEach(() => {
    FakeEufySecurity.initialize.mockReset();
  });

  it("uses the in-process direct client on the happy path", async () => {
    FakeEufySecurity.initialize.mockImplementation(async () => new FakeEufySecurity());
    const client = await createEufyClient(config);
    expect(client).toBeInstanceOf(DirectEufyClient);
    await client.disconnect();
  });

  it("falls back to the child process on a crypto error", async () => {
    FakeEufySecurity.initialize.mockImplementation(async () => {
      const err = new Error("digital envelope routines::unsupported") as Error & { code: string };
      err.code = "ERR_OSSL_EVP_UNSUPPORTED";
      throw err;
    });
    const client = await createEufyClient(config);
    expect(client).toBeInstanceOf(ChildProcessEufyClient);
    await client.disconnect();
  });

  it("rethrows non-crypto errors without falling back", async () => {
    FakeEufySecurity.initialize.mockImplementation(async () => {
      throw new Error("invalid credentials");
    });
    await expect(createEufyClient(config)).rejects.toThrow("invalid credentials");
  });
});

describe("DirectEufyClient", () => {
  it("wraps a crypto padding failure in EufyCryptoError", async () => {
    FakeEufySecurity.initialize.mockImplementation(async () => {
      throw new Error("error:0308010C:digital envelope routines::unsupported");
    });
    const client = new DirectEufyClient(config);
    await expect(client.connect()).rejects.toBeInstanceOf(EufyCryptoError);
  });

  it("proxies livestream control to the underlying client", async () => {
    const fake = new FakeEufySecurity();
    FakeEufySecurity.initialize.mockImplementation(async () => fake);
    const client = new DirectEufyClient(config);
    await client.connect();

    await client.startLivestream("CAM1");
    expect(fake.startStationLivestream).toHaveBeenCalledWith("CAM1");

    await client.stopLivestream("CAM1");
    expect(fake.stopStationLivestream).toHaveBeenCalledWith("CAM1");

    expect(await client.isLiveStreaming("CAM1")).toBe(true);
  });

  it("re-emits motion events with the device serial", async () => {
    const fake = new FakeEufySecurity();
    FakeEufySecurity.initialize.mockImplementation(async () => fake);
    const client = new DirectEufyClient(config);
    await client.connect();

    const seen: Array<[string, boolean]> = [];
    client.on("motionDetected", (serial: string, state: boolean) => seen.push([serial, state]));
    fake.emit("device motion detected", { getSerial: () => "CAM1" }, true);

    expect(seen).toEqual([["CAM1", true]]);
  });
});

describe("DirectEufyClient error event handling", () => {
  it("emits disconnected without throwing when inner client emits error", async () => {
    const fake = new FakeEufySecurity();
    FakeEufySecurity.initialize.mockImplementation(async () => fake);

    const client = new DirectEufyClient(config);
    await client.connect();

    const disconnectedEvents: unknown[] = [];
    client.on("disconnected", () => disconnectedEvents.push(true));

    expect(() => {
      (fake as unknown as import("events").EventEmitter).emit(
        "error",
        new Error("internal eufy error"),
      );
    }).not.toThrow();

    expect(disconnectedEvents).toHaveLength(1);
  });
});

describe("ChildProcessEufyClient", () => {
  it("connects and proxies commands over IPC", async () => {
    const client = new ChildProcessEufyClient(config);
    await client.connect();
    // Should resolve via the auto-replying fake child.
    await expect(client.startLivestream("CAM1")).resolves.toBeUndefined();
    expect(lastChild.send).toHaveBeenCalled();
    await client.disconnect();
  });
});

describe("isCryptoPaddingError", () => {
  it("detects OpenSSL unsupported errors", () => {
    expect(isCryptoPaddingError({ code: "ERR_OSSL_EVP_UNSUPPORTED" })).toBe(true);
    expect(isCryptoPaddingError(new Error("legacy pkcs1 padding"))).toBe(true);
    expect(isCryptoPaddingError(new Error("totally unrelated"))).toBe(false);
  });
});
