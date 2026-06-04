/**
 * Plugin entry class. Owns the Eufy client connection, discovers stations and
 * cameras into Scrypted, routes client events to the right device instances and
 * exposes the account/connection settings in the Scrypted UI.
 */
import sdk, {
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  type AdoptDevice,
  type Device,
  type DeviceDiscovery,
  type DeviceProvider,
  type DiscoveredDevice,
  type ScryptedDevice,
  type Setting,
  type SettingValue,
  type Settings,
} from "@scrypted/sdk";
import path from "path";
import { EufyCamera } from "./camera";
import { createEufyClient } from "./eufy-client";
import { EufyStation } from "./station";
import { StreamManager } from "./stream-manager";
import {
  type DeviceInfo,
  type EufyPluginConfig,
  type IEufyClient,
  type StationInfo,
} from "./types";
import { Logger, backoffDelay, delay } from "./utils";

const { deviceManager } = sdk;

/**
 * The Scrypted plugin singleton.
 */
export class EufySecurityPlugin
  extends ScryptedDeviceBase
  implements DeviceProvider, Settings, DeviceDiscovery
{
  private readonly logger = new Logger("EufyPlugin");
  private client?: IEufyClient;
  private streamManager?: StreamManager;
  private readonly cameras = new Map<string, EufyCamera>();
  private readonly stations = new Map<string, EufyStation>();
  private deviceInfos = new Map<string, DeviceInfo>();
  private stationInfos = new Map<string, StationInfo>();
  private connecting = false;
  private reconnecting = false;
  private reconnectAttempt = 0;
  private stableResetTimer?: ReturnType<typeof setTimeout>;
  private captchaId?: string;
  private captchaImageB64?: string;

  constructor(nativeId?: string) {
    super(nativeId);
    // Attempt to connect on startup if credentials are already stored.
    if (this.storage.getItem("username") && this.storage.getItem("password")) {
      this.connect().catch((err) =>
        this.logger.error("initial connect failed", err),
      );
    }
  }

  // ---- Configuration ---------------------------------------------------------

  /** Build the typed config object from persisted storage. */
  private buildConfig(): EufyPluginConfig {
    const persistentDir = path.join(
      process.env.SCRYPTED_PLUGIN_VOLUME ?? process.cwd(),
      "eufy-persistent",
    );
    return {
      username: (this.storage.getItem("username") ?? "").trim(),
      password: this.storage.getItem("password") ?? "",
      country: (this.storage.getItem("country") || "DE").trim().toUpperCase(),
      language: (this.storage.getItem("language") || "de").trim().toLowerCase(),
      persistentDir,
      trustedDeviceName:
        this.storage.getItem("trustedDeviceName") ?? "scrypted-plugin",
      eventDurationSeconds: Number(
        this.storage.getItem("eventDuration") ?? "30",
      ),
      p2pConnectionSetupTimeout: 120000,
      tfaCode: this.storage.getItem("tfa_code") || undefined,
      captchaAnswer: this.storage.getItem("captcha_answer") || undefined,
      captchaId: this.captchaId,
    };
  }

  // ---- Connection lifecycle --------------------------------------------------

  /** Connect (or reconnect) the Eufy client and wire up events. */
  private async connect(): Promise<void> {
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      const config = this.buildConfig();
      if (!config.username || !config.password) {
        this.logger.warn("missing credentials; skipping connect");
        return;
      }

      this.client = await createEufyClient(config);
      this.registerClientEvents(this.client);
      this.streamManager = new StreamManager(this.client);
      this.markStable();

      // Clear one-shot auth inputs after a successful connect.
      this.storage.removeItem("tfa_code");
      this.storage.removeItem("captcha_answer");
      this.captchaId = undefined;
      this.captchaImageB64 = undefined;

      await this.discoverDevices();
    } finally {
      this.connecting = false;
    }
  }

  private registerClientEvents(client: IEufyClient): void {
    client.on("motionDetected", (serial: string, state: boolean) => {
      this.cameras.get(serial)?.setMotion(state);
    });
    client.on("guardMode", (serial: string, mode: number) => {
      this.stations.get(serial)?.updateState(mode);
    });
    client.on("tfaRequest", () => {
      this.logger.warn("2FA required — enter the code in plugin settings");
    });
    client.on("captchaRequest", (id: string, captchaB64: string) => {
      this.captchaId = id;
      this.captchaImageB64 = captchaB64;
      this.logger.warn("CAPTCHA required — answer it in plugin settings");
    });
    client.on("disconnected", () => {
      this.logger.warn("client disconnected; scheduling reconnect");
      void this.scheduleReconnect();
    });
    client.on("deviceAdded", (device: DeviceInfo) => {
      this.deviceInfos.set(device.serial, device);
      void this.discoverDevices();
    });
    client.on("stationAdded", (station: StationInfo) => {
      this.stationInfos.set(station.serial, station);
      void this.discoverDevices();
    });
  }

  /**
   * Mark the current connection as healthy. The backoff counter is only reset
   * once the link has stayed up for a while, so a flapping connection keeps
   * backing off instead of hammering the Eufy cloud (which triggers CAPTCHA).
   */
  private markStable(): void {
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer);
    }
    this.stableResetTimer = setTimeout(() => {
      this.reconnectAttempt = 0;
    }, 120_000);
    // Don't let this background timer keep the process (or test runner) alive.
    this.stableResetTimer.unref?.();
  }

  /**
   * Reconnect with exponential backoff (2s → 60s cap). Single-flight: only one
   * reconnect chain runs at a time, so a burst of `disconnected` events cannot
   * spawn parallel re-login attempts. Reuses the existing client (token reuse)
   * rather than re-authenticating with username/password.
   */
  private async scheduleReconnect(): Promise<void> {
    if (this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    const wait = backoffDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.logger.info(`reconnect attempt ${this.reconnectAttempt} in ${wait}ms`);
    await delay(wait);
    try {
      await this.streamManager?.stopAll().catch(() => undefined);
      if (this.client) {
        await this.client.reconnect();
      } else {
        await this.connect();
      }
      this.markStable();
      this.reconnecting = false;
    } catch (err) {
      this.logger.error("reconnect failed", err);
      this.reconnecting = false;
      void this.scheduleReconnect();
    }
  }

  // ---- DeviceDiscovery -------------------------------------------------------

  async discoverDevices(_scan?: boolean): Promise<DiscoveredDevice[]> {
    if (!this.client) {
      throw new Error("client not connected");
    }

    const stations = await this.client.getStations();
    const devices = await this.client.getDevices();

    const manifest: Device[] = [];

    for (const device of devices) {
      this.deviceInfos.set(device.serial, device);
      const interfaces: ScryptedInterface[] = [
        ScryptedInterface.Camera,
        ScryptedInterface.VideoCamera,
        ScryptedInterface.MotionSensor,
        ScryptedInterface.Settings,
      ];
      if (device.hasIntercom) {
        interfaces.push(ScryptedInterface.Intercom);
      }
      if (device.hasPanAndTilt) {
        interfaces.push(ScryptedInterface.PanTiltZoom);
      }
      manifest.push({
        nativeId: device.serial,
        name: device.name,
        type: ScryptedDeviceType.Camera,
        interfaces,
      });
    }

    for (const station of stations) {
      this.stationInfos.set(station.serial, station);
      manifest.push({
        nativeId: station.serial,
        name: station.name,
        type: ScryptedDeviceType.SecuritySystem,
        interfaces: [ScryptedInterface.SecuritySystem],
      });
    }

    for (const device of manifest) {
      await deviceManager.onDeviceDiscovered(device);
    }
    this.logger.info(
      `discovered ${devices.length} cameras, ${stations.length} stations`,
    );
    return [];
  }

  /**
   * Devices are surfaced automatically via {@link discoverDevices}; manual
   * adoption is therefore not supported.
   */
  async adoptDevice(_device: AdoptDevice): Promise<string> {
    throw new Error("manual device adoption is not supported");
  }

  // ---- DeviceProvider --------------------------------------------------------

  async getDevice(nativeId: string): Promise<ScryptedDevice> {
    if (this.cameras.has(nativeId)) {
      return this.cameras.get(nativeId) as unknown as ScryptedDevice;
    }
    if (this.stations.has(nativeId)) {
      return this.stations.get(nativeId) as unknown as ScryptedDevice;
    }

    if (!this.client || !this.streamManager) {
      throw new Error("client not connected");
    }

    const deviceInfo = this.deviceInfos.get(nativeId);
    if (deviceInfo) {
      const config = this.buildConfig();
      const camera = new EufyCamera(
        nativeId,
        this.client,
        this.streamManager,
        deviceInfo,
        config.eventDurationSeconds,
      );
      this.cameras.set(nativeId, camera);
      return camera as unknown as ScryptedDevice;
    }

    const stationInfo = this.stationInfos.get(nativeId);
    if (stationInfo) {
      const station = new EufyStation(
        nativeId,
        this.client,
        stationInfo.serial,
        stationInfo.guardMode,
      );
      this.stations.set(nativeId, station);
      return station as unknown as ScryptedDevice;
    }

    throw new Error(`unknown nativeId: ${nativeId}`);
  }

  async releaseDevice(_id: string, nativeId: string): Promise<void> {
    const camera = this.cameras.get(nativeId);
    if (camera) {
      await camera.cleanup().catch(() => undefined);
      this.cameras.delete(nativeId);
    }
    this.stations.delete(nativeId);
  }

  // ---- Settings --------------------------------------------------------------

  async getSettings(): Promise<Setting[]> {
    const settings: Setting[] = [
      {
        key: "username",
        title: "Eufy E-Mail",
        type: "string",
        value: this.storage.getItem("username") ?? "",
      },
      {
        key: "password",
        title: "Eufy Passwort",
        type: "password",
        value: this.storage.getItem("password") ?? "",
      },
      {
        key: "country",
        title: "Land (z.B. DE)",
        type: "string",
        value: this.storage.getItem("country") ?? "DE",
      },
      {
        key: "language",
        title: "Sprache (z.B. de)",
        type: "string",
        value: this.storage.getItem("language") ?? "de",
      },
      {
        key: "eventDuration",
        title: "Bewegung Reset (Sek.)",
        type: "number",
        value: this.storage.getItem("eventDuration") ?? "30",
      },
      {
        key: "tfa_code",
        title: "2FA Code (falls nötig)",
        type: "string",
        value: "",
      },
    ];

    if (this.captchaImageB64) {
      settings.push({
        key: "captcha_image",
        title: "CAPTCHA",
        description: "Löse das angezeigte CAPTCHA",
        type: "html",
        readonly: true,
        value: `<img src="data:image/png;base64,${this.captchaImageB64}" alt="captcha" />`,
      });
      settings.push({
        key: "captcha_answer",
        title: "CAPTCHA Antwort",
        type: "string",
        value: "",
      });
    }

    return settings;
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    this.storage.setItem(key, String(value ?? ""));

    // Credential / auth changes trigger a (re)connect.
    const reconnectKeys = [
      "username",
      "password",
      "country",
      "language",
      "tfa_code",
      "captcha_answer",
    ];
    if (reconnectKeys.includes(key)) {
      await this.client?.disconnect().catch(() => undefined);
      this.client = undefined;
      await this.connect().catch((err) =>
        this.logger.error("connect after setting failed", err),
      );
    }
    await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
  }
}
