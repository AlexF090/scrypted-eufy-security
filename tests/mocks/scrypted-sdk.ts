/**
 * Test mock for the `@scrypted/sdk` module. Provides just enough runtime
 * surface (base class, enums, manager singletons) for the plugin to load and
 * be exercised under Jest. Type-only exports are erased at compile time so they
 * need no runtime counterpart.
 */
class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export class ScryptedDeviceBase {
  nativeId?: string;
  storage = new FakeStorage();
  motionDetected?: boolean;
  securitySystemState?: unknown;
  constructor(nativeId?: string) {
    this.nativeId = nativeId;
  }
  onDeviceEvent(_iface: string, _data: unknown): Promise<void> {
    return Promise.resolve();
  }
}

export enum ScryptedInterface {
  Camera = "Camera",
  VideoCamera = "VideoCamera",
  MotionSensor = "MotionSensor",
  Intercom = "Intercom",
  PanTiltZoom = "PanTiltZoom",
  SecuritySystem = "SecuritySystem",
  Settings = "Settings",
}

export enum ScryptedDeviceType {
  Camera = "Camera",
  SecuritySystem = "SecuritySystem",
}

export enum ScryptedMimeTypes {
  FFmpegInput = "x-scrypted/x-ffmpeg-input",
}

export enum SecuritySystemMode {
  Disarmed = "Disarmed",
  HomeArmed = "HomeArmed",
  AwayArmed = "AwayArmed",
  NightArmed = "NightArmed",
}

export enum SecuritySystemObstruction {
  Error = "Error",
  Time = "Time",
  Sensor = "Sensor",
  None = "None",
}

export const deviceManager = {
  onDeviceDiscovered: jest.fn(async () => undefined),
  onDevicesChanged: jest.fn(async () => undefined),
};

export const mediaManager = {
  createMediaObject: jest.fn(async (data: unknown, mimeType: string) => ({
    data,
    mimeType,
  })),
  createMediaObjectFromUrl: jest.fn(async (url: string) => ({ url })),
  createFFmpegMediaObject: jest.fn(async (input: unknown) => ({ input })),
  convertMediaObjectToJSON: jest.fn(async () => ({ inputArguments: [] })),
  getFFmpegPath: jest.fn(async () => "ffmpeg"),
};

const sdk = { deviceManager, mediaManager };
export default sdk;
