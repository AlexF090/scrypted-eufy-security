import { EventEmitter } from "events";
import type { DeviceInfo, IEufyClient, StationInfo } from "../src/types";

// --- Fake client returned by the mocked factory -------------------------------
class FakeClient extends EventEmitter {
  getStations = jest.fn(async (): Promise<StationInfo[]> => this.stations);
  getDevices = jest.fn(async (): Promise<DeviceInfo[]> => this.devices);
  disconnect = jest.fn(async () => undefined);
  triggerSnapshot = jest.fn(async () => undefined);
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
import sdk, { ScryptedInterface } from "@scrypted/sdk";
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

const station: StationInfo = { serial: "HB3", name: "HomeBase 3", model: "S380", guardMode: 0 };

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

describe("EufySecurityPlugin discovery", () => {
  it("registers camera interfaces for a plain camera", async () => {
    await bootPlugin([baseDevice({})]);
    const calls = (sdk.deviceManager.onDeviceDiscovered as jest.Mock).mock.calls.map((c) => c[0]);
    const cam = calls.find((d) => d.nativeId === "CAM1");
    expect(cam.interfaces).toEqual(
      expect.arrayContaining([
        ScryptedInterface.Camera,
        ScryptedInterface.VideoCamera,
        ScryptedInterface.MotionSensor,
      ]),
    );
    expect(cam.interfaces).not.toContain(ScryptedInterface.Intercom);
    expect(cam.interfaces).not.toContain(ScryptedInterface.PanTiltZoom);
  });

  it("adds the PanTiltZoom interface only for PT cameras", async () => {
    await bootPlugin([baseDevice({ hasPanAndTilt: true })]);
    const calls = (sdk.deviceManager.onDeviceDiscovered as jest.Mock).mock.calls.map((c) => c[0]);
    const cam = calls.find((d) => d.nativeId === "CAM1");
    expect(cam.interfaces).toContain(ScryptedInterface.PanTiltZoom);
  });

  it("adds the Intercom interface only for intercom cameras", async () => {
    await bootPlugin([baseDevice({ hasIntercom: true })]);
    const calls = (sdk.deviceManager.onDeviceDiscovered as jest.Mock).mock.calls.map((c) => c[0]);
    const cam = calls.find((d) => d.nativeId === "CAM1");
    expect(cam.interfaces).toContain(ScryptedInterface.Intercom);
  });

  it("registers the station as a security system", async () => {
    await bootPlugin([baseDevice({})]);
    const calls = (sdk.deviceManager.onDeviceDiscovered as jest.Mock).mock.calls.map((c) => c[0]);
    const hb = calls.find((d) => d.nativeId === "HB3");
    expect(hb.interfaces).toEqual([ScryptedInterface.SecuritySystem]);
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
