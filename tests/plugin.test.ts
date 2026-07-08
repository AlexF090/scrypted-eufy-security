import { EventEmitter } from "events";
import type { DeviceInfo, IEufyClient, StationInfo, StreamMetadata } from "../src/types";

// --- Fake client returned by the mocked factory -------------------------------
class FakeClient extends EventEmitter {
  getStations = jest.fn(async (): Promise<StationInfo[]> => this.stations);
  getDevices = jest.fn(async (): Promise<DeviceInfo[]> => this.devices);
  disconnect = jest.fn(async () => undefined);
  triggerSnapshot = jest.fn(async () => undefined);
  getSnapshot = jest.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  setDeviceProperty = jest.fn(async () => undefined);
  setGuardMode = jest.fn(async () => undefined);
  constructor(
    public devices: DeviceInfo[],
    public stations: StationInfo[],
  ) {
    super();
  }
}

let fakeClient: FakeClient;
jest.mock("../src/eufy-client", () => ({
  createEufyClient: jest.fn(async () => fakeClient as unknown as IEufyClient),
}));

// Avoid spawning a real StreamManager event wiring beyond what we need.
import sdk, { ScryptedDeviceType, ScryptedInterface } from "@scrypted/sdk";
import { EufySecurityPlugin } from "../src/plugin";

const baseDevice = (over: Partial<DeviceInfo>): DeviceInfo => ({
  serial: "CAM1",
  name: "Camera 1",
  model: "T8600",
  stationSerial: "HB3",
  hasPanAndTilt: false,
  hasIntercom: false,
  isCamera: true,
  isOnline: true,
  ...over,
});

const station: StationInfo = { serial: "HB3", name: "HomeBase 3", model: "S380", guardMode: 0, isSingleStreamStation: true };

async function bootPlugin(devices: DeviceInfo[]): Promise<EufySecurityPlugin> {
  fakeClient = new FakeClient(devices, [station]);
  const plugin = new EufySecurityPlugin("eufy");
  plugin.storage.setItem("username", "u@example.com");
  plugin.storage.setItem("password", "pw");
  plugin.storage.setItem("eventDuration", "2");
  // Triggers connect → discoverDevices via the mocked factory.
  await plugin.putSetting("password", "pw");
  return plugin;
}

/** Flatten all devices reported via onDevicesChanged across all calls. */
function discoveredDevices(): Array<{ nativeId: string; interfaces: string[]; type: string }> {
  return (sdk.deviceManager.onDevicesChanged as jest.Mock).mock.calls.flatMap(
    (c) => (c[0] as { devices: unknown[] }).devices ?? [],
  ) as Array<{ nativeId: string; interfaces: string[]; type: string }>;
}

describe("EufySecurityPlugin discovery", () => {
  it("registers camera interfaces for a plain camera", async () => {
    await bootPlugin([baseDevice({})]);
    const cam = discoveredDevices().find((d) => d.nativeId === "CAM1");
    expect(cam?.interfaces).toEqual(
      expect.arrayContaining([
        ScryptedInterface.Camera,
        ScryptedInterface.VideoCamera,
        ScryptedInterface.MotionSensor,
      ]),
    );
    expect(cam?.interfaces).not.toContain(ScryptedInterface.Intercom);
    expect(cam?.interfaces).not.toContain(ScryptedInterface.PanTiltZoom);
  });

  it("adds the PanTiltZoom interface only for PT cameras", async () => {
    await bootPlugin([baseDevice({ hasPanAndTilt: true })]);
    const cam = discoveredDevices().find((d) => d.nativeId === "CAM1");
    expect(cam?.interfaces).toContain(ScryptedInterface.PanTiltZoom);
  });

  it("adds the Intercom interface only for intercom cameras", async () => {
    await bootPlugin([baseDevice({ hasIntercom: true })]);
    const cam = discoveredDevices().find((d) => d.nativeId === "CAM1");
    expect(cam?.interfaces).toContain(ScryptedInterface.Intercom);
  });

  it("registers the station as a security system", async () => {
    await bootPlugin([baseDevice({})]);
    const hb = discoveredDevices().find((d) => d.nativeId === "HB3");
    expect(hb?.interfaces).toEqual([ScryptedInterface.SecuritySystem]);
  });

  it("sends all devices in a single onDevicesChanged call", async () => {
    await bootPlugin([baseDevice({})]);
    const mock = sdk.deviceManager.onDevicesChanged as jest.Mock;
    expect(mock).toHaveBeenCalledTimes(1);
    const { devices } = mock.mock.calls[0][0] as { devices: { nativeId: string }[] };
    expect(devices.map((d) => d.nativeId)).toEqual(
      expect.arrayContaining(["CAM1", "HB3"]),
    );
  });

  it("getVideoStreamOptions declares MP4 and AR dimensions for Rebroadcast", async () => {
    const plugin = await bootPlugin([baseDevice({})]);
    const camera = (await plugin.getDevice("CAM1")) as unknown as {
      getVideoStreamOptions(): Promise<
        Array<{
          container?: string;
          source?: string;
          video?: { width?: number; height?: number };
        }>
      >;
    };
    const [opts] = await camera.getVideoStreamOptions();
    expect(opts.container).toBe("mp4");
    expect(opts.source).toBe("cloud");
    expect(opts.video?.width).toBe(3840);
    expect(opts.video?.height).toBe(2160);
  });

  it("ignores suspiciously narrow livestream dimensions in stream options", async () => {
    const plugin = await bootPlugin([baseDevice({ model: "T8142" })]);
    const camera = (await plugin.getDevice("CAM1")) as unknown as {
      streamMetadata?: StreamMetadata;
      getVideoStreamOptions(): Promise<
        Array<{
          video?: { width?: number; height?: number };
        }>
      >;
    };
    camera.streamMetadata = {
      videoCodec: "h264",
      audioCodec: "aac",
      videoFPS: 15,
      videoWidth: 608,
      videoHeight: 1080,
    };

    const [opts] = await camera.getVideoStreamOptions();

    expect(opts.video?.width).toBe(1920);
    expect(opts.video?.height).toBe(1080);
  });

  it("can advertise the P2P stream without audio", async () => {
    const plugin = await bootPlugin([baseDevice({})]);
    const camera = (await plugin.getDevice("CAM1")) as unknown as {
      putSetting(key: string, value: boolean): Promise<void>;
      getVideoStreamOptions(): Promise<Array<{ audio?: unknown }>>;
    };

    await camera.putSetting("disableAudio", true);
    const [opts] = await camera.getVideoStreamOptions();

    expect(opts.audio).toBeNull();
  });

  it("rejects invalid cached snapshot bytes instead of labelling them JPEG", async () => {
    (sdk.mediaManager.createMediaObject as jest.Mock).mockClear();
    const plugin = await bootPlugin([baseDevice({})]);
    fakeClient.getSnapshot.mockResolvedValueOnce(Buffer.from("not an image"));
    const camera = (await plugin.getDevice("CAM1")) as unknown as {
      takePicture(): Promise<unknown>;
    };

    await expect(camera.takePicture()).rejects.toThrow(/was not an image/);
    expect(sdk.mediaManager.createMediaObject).not.toHaveBeenCalled();
  });
});

describe("EufySecurityPlugin startup race", () => {
  it("getDevice waits for discoverDevices even when client is already set", async () => {
    let resolveDiscover!: () => void;
    const discoverBlocker = new Promise<void>((res) => {
      resolveDiscover = res;
    });

    // Resolved once getStations() is first called, meaning doConnect() has
    // already set this.client and discoverDevices() has started.
    let resolveDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((res) => {
      resolveDiscoveryStarted = res;
    });

    fakeClient = new FakeClient([], [station]);
    fakeClient.getDevices = jest.fn(async () => {
      await discoverBlocker;
      return [baseDevice({})];
    });
    fakeClient.getStations = jest.fn(async () => {
      resolveDiscoveryStarted();
      await discoverBlocker;
      return [station];
    });

    const plugin = new EufySecurityPlugin("eufy");
    plugin.storage.setItem("username", "u@example.com");
    plugin.storage.setItem("password", "pw");
    plugin.storage.setItem("eventDuration", "2");

    // Start connect without awaiting — connect runs asynchronously.
    const connectResult = plugin.putSetting("password", "pw");

    // Wait until discoverDevices has started so this.client is definitely set.
    await discoveryStarted;

    // Call getDevice in the race window (discoverDevices still blocked).
    const devicePromise = plugin.getDevice("CAM1");

    // Unblock discoverDevices.
    resolveDiscover();

    await connectResult;
    const device = await devicePromise;
    expect(device).toBeDefined();
  });
});

describe("EufySecurityPlugin device routing", () => {
  it("resets motion after the configured duration", async () => {
    jest.useFakeTimers();
    try {
      const plugin = await bootPlugin([baseDevice({})]);
      const camera = (await plugin.getDevice("CAM1")) as unknown as {
        motionDetected?: boolean;
      };

      fakeClient.emit("motionDetected", "CAM1", true);
      expect(camera.motionDetected).toBe(true);

      await jest.advanceTimersByTimeAsync(2000);
      expect(camera.motionDetected).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("EufySecurityPlugin standalone camera (same serial as station)", () => {
  it("merges same-serial device and station into one manifest entry with both interfaces", async () => {
    (sdk.deviceManager.onDevicesChanged as jest.Mock).mockClear();
    const soloDevice = baseDevice({ serial: "CAM_SOLO", stationSerial: "CAM_SOLO" });
    const soloStation: StationInfo = { serial: "CAM_SOLO", name: "Solo Cam", model: "T8200", guardMode: 0, isSingleStreamStation: false };
    fakeClient = new FakeClient([soloDevice], [soloStation]);
    const plugin = new EufySecurityPlugin("eufy");
    plugin.storage.setItem("username", "u@example.com");
    plugin.storage.setItem("password", "pw");
    plugin.storage.setItem("eventDuration", "2");
    await plugin.putSetting("password", "pw");

    const mock = sdk.deviceManager.onDevicesChanged as jest.Mock;
    const allDevices = mock.mock.calls.flatMap(
      (c) => (c[0] as { devices: unknown[] }).devices ?? [],
    ) as Array<{ nativeId: string; interfaces: string[]; type: string }>;

    const entries = allDevices.filter((d) => d.nativeId === "CAM_SOLO");
    expect(entries).toHaveLength(1);
    expect(entries[0].interfaces).toContain(ScryptedInterface.Camera);
    expect(entries[0].interfaces).toContain(ScryptedInterface.SecuritySystem);
    expect(entries[0].type).toBe(ScryptedDeviceType.Camera);
  });

  it("getDevice returns a single instance for the merged serial", async () => {
    (sdk.deviceManager.onDevicesChanged as jest.Mock).mockClear();
    const soloDevice = baseDevice({ serial: "CAM_SOLO", stationSerial: "CAM_SOLO" });
    const soloStation: StationInfo = { serial: "CAM_SOLO", name: "Solo Cam", model: "T8200", guardMode: 0, isSingleStreamStation: false };
    fakeClient = new FakeClient([soloDevice], [soloStation]);
    const plugin = new EufySecurityPlugin("eufy");
    plugin.storage.setItem("username", "u@example.com");
    plugin.storage.setItem("password", "pw");
    plugin.storage.setItem("eventDuration", "2");
    await plugin.putSetting("password", "pw");

    const device = await plugin.getDevice("CAM_SOLO");
    expect(device).toBeDefined();
    // Both calls must return the same cached instance.
    const device2 = await plugin.getDevice("CAM_SOLO");
    expect(device2).toBe(device);
  });
});
