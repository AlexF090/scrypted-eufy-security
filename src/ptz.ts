/**
 * Pan/Tilt/Zoom command translation for Eufy PT cameras (e.g. Indoor Cam C210).
 *
 * Only instantiated when `Device.hasPanAndTilt(device) === true`. Eufy exposes
 * discrete directional steps rather than continuous coordinates, so Scrypted's
 * vector {@link PanTiltZoomCommand} is mapped to the nearest discrete step(s).
 */
import { PanTiltDirection, type IEufyClient } from "./types";
import { Logger } from "./utils";

/** Minimal shape of Scrypted's `PanTiltZoomCommand` (avoids hard SDK coupling). */
export interface PanTiltZoomCommand {
  pan?: number;
  tilt?: number;
  zoom?: number;
  /** Some clients send a `movement` hint; ignored for discrete PTZ. */
  movement?: unknown;
}

/**
 * Translates Scrypted PTZ commands into Eufy directional calls.
 */
export class PtzController {
  private readonly log: Logger;

  constructor(
    private readonly client: IEufyClient,
    private readonly deviceSerial: string,
  ) {
    this.log = new Logger("Ptz").child(deviceSerial);
  }

  /**
   * Execute a PTZ command. Pan/tilt magnitudes are treated as direction hints
   * (sign matters, magnitude does not). Zoom is unsupported on these cameras
   * and silently ignored.
   */
  async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
    const moves: PanTiltDirection[] = [];

    if (typeof command.pan === "number" && command.pan !== 0) {
      moves.push(command.pan < 0 ? PanTiltDirection.LEFT : PanTiltDirection.RIGHT);
    }
    if (typeof command.tilt === "number" && command.tilt !== 0) {
      moves.push(command.tilt > 0 ? PanTiltDirection.UP : PanTiltDirection.DOWN);
    }

    if (moves.length === 0) {
      this.log.debug("ptzCommand with no actionable pan/tilt; ignored");
      return;
    }

    for (const direction of moves) {
      await this.client.panAndTilt(this.deviceSerial, direction);
    }
  }

  /** Trigger a full 360° rotation scan. */
  async rotate360(): Promise<void> {
    await this.client.rotate360(this.deviceSerial);
  }
}
