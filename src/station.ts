/**
 * Scrypted device representing a Eufy station (HomeBase). Exposes the station's
 * guard mode as a Scrypted {@link SecuritySystem}.
 */
import {
  ScryptedDeviceBase,
  type SecuritySystem,
  type SecuritySystemState,
  SecuritySystemMode,
} from "@scrypted/sdk";
import { GuardMode, type IEufyClient } from "./types";
import { Logger } from "./utils";

/** Map a Scrypted arming mode to the matching Eufy guard mode. */
function scryptedToGuardMode(mode: SecuritySystemMode): GuardMode {
  switch (mode) {
    case SecuritySystemMode.AwayArmed:
      return GuardMode.AWAY;
    case SecuritySystemMode.HomeArmed:
    case SecuritySystemMode.NightArmed:
      return GuardMode.HOME;
    case SecuritySystemMode.Disarmed:
    default:
      return GuardMode.OFF;
  }
}

/** Map a Eufy guard mode back to the Scrypted arming mode for status display. */
function guardModeToScrypted(mode: number): SecuritySystemMode {
  switch (mode) {
    case GuardMode.AWAY:
      return SecuritySystemMode.AwayArmed;
    case GuardMode.HOME:
      return SecuritySystemMode.HomeArmed;
    case GuardMode.OFF:
    case GuardMode.DISARMED:
      return SecuritySystemMode.Disarmed;
    default:
      return SecuritySystemMode.Disarmed;
  }
}

/**
 * One instance per HomeBase. Bridges Scrypted SecuritySystem arming to Eufy
 * guard modes and reflects guard-mode change events back into Scrypted state.
 */
export class EufyStation extends ScryptedDeviceBase implements SecuritySystem {
  private readonly logger: Logger;

  constructor(
    nativeId: string,
    private readonly client: IEufyClient,
    private readonly stationSerial: string,
    initialGuardMode: number,
  ) {
    super(nativeId);
    this.logger = new Logger("Station").child(stationSerial);
    this.updateState(initialGuardMode);
  }

  /** Update the exposed Scrypted security state from a Eufy guard mode. */
  updateState(guardMode: number): void {
    const state: SecuritySystemState = {
      mode: guardModeToScrypted(guardMode),
      triggered: false,
      supportedModes: [
        SecuritySystemMode.Disarmed,
        SecuritySystemMode.HomeArmed,
        SecuritySystemMode.AwayArmed,
        SecuritySystemMode.NightArmed,
      ],
    };
    this.securitySystemState = state;
  }

  async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
    const guardMode = scryptedToGuardMode(mode);
    this.logger.info(`arm → guard mode ${guardMode}`);
    // Update local state only after the device confirms the change.
    await this.client.setGuardMode(this.stationSerial, guardMode);
    this.updateState(guardMode);
  }

  async disarmSecuritySystem(): Promise<void> {
    this.logger.info("disarm → guard mode OFF");
    await this.client.setGuardMode(this.stationSerial, GuardMode.OFF);
    this.updateState(GuardMode.OFF);
  }
}
