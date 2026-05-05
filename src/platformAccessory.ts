import { CharacteristicValue, HAPStatus, PlatformAccessory, Service } from 'homebridge';

import AtombergApi from './atombergApi';
import { AtombergFanPlatform } from './platform';
import { AtombergFanCommand, AtombergFanCommandData, AtombergFanDeviceState } from './model';
import {
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  BRIGHTNESS_SERIES,
  COLOR_MODE_SERIES,
  COLOR_TEMP_COOL_MIRED,
  COLOR_TEMP_DAYLIGHT_MIRED,
  COLOR_TEMP_WARM_MIRED,
  COMMAND_DEBOUNCE_MS,
  FAN_SPEED_MAX,
  FAN_SPEED_MIN,
  LEGACY_FAN_SPEED_MAX,
  LIGHT_MODE_COOL,
  LIGHT_MODE_DAYLIGHT,
  LIGHT_MODE_WARM,
} from './settings';

/**
 * One AtombergFanPlatformAccessory instance per fan. Owns the Fanv2 service
 * and the accompanying Lightbulb service for the LED, registers HomeKit set
 * handlers, and reflects state changes pushed up from the UDP listener.
 *
 * Cloud API quota note: every set handler dispatches via sendDeviceUpdate,
 * which prefers the LAN UDP path when the broadcast listener has discovered
 * the device's IP. The cloud API is only used as a fallback.
 */
export class AtombergFanPlatformAccessory {
  private fanService: Service;
  private lightbulbService: Service;
  private readonly supportsBrightness: boolean;
  private readonly supportsColor: boolean;
  private readonly fanSpeedMax: number;

  // Command coalescer state. We accumulate the latest desired values per key
  // (power/speed/led/brightness/light_mode) and flush after COMMAND_DEBOUNCE_MS
  // of inactivity. Last-write-wins per key — a slider drag from 0%→100% sends
  // one final speed instead of dozens of intermediate ones.
  private pendingCommand: AtombergFanCommand = {};
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly platform: AtombergFanPlatform,
    private readonly atombergApi: AtombergApi,
    private readonly accessory: PlatformAccessory,
    private fanState: AtombergFanDeviceState,
  ) {
    // Tolerate the cloud state lookup not returning a row for this device
    // (offline at boot is common). Subsequent UDP messages will fill it in.
    if (!this.fanState) {
      this.fanState = {
        device_id: accessory.context.device.device_id,
        is_online: false,
        power: false,
        led: false,
        sleep_mode: false,
        last_recorded_speed: 0,
        timer_hours: 0,
        timer_time_elapsed_mins: 0,
      };
    }

    const series: string = accessory.context.device.series ?? '';
    const model: string = accessory.context.device.model ?? '';
    this.supportsBrightness = BRIGHTNESS_SERIES.includes(series);
    this.supportsColor = COLOR_MODE_SERIES.includes(series);
    this.fanSpeedMax = platform.platformConfig.legacy5Speed ? LEGACY_FAN_SPEED_MAX : FAN_SPEED_MAX;

    const modelName = [model, series].filter(Boolean).join(' ') || 'Unknown';

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Atomberg')
      .setCharacteristic(this.platform.Characteristic.Model, modelName)
      .setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name || 'Unknown')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.device_id || 'Unknown');

    // Fan service
    this.fanService = this.accessory.getService(this.platform.Service.Fanv2)
      || this.accessory.addService(this.platform.Service.Fanv2);
    this.fanService.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name || 'Unknown Fan');

    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.setActive.bind(this));

    // Atomberg supports speeds 1..6. We expose a continuous 0..100 slider so
    // HomeKit's UX is unchanged; sets quantize to the nearest speed level and
    // reads quantize back to a representative percentage.
    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet(this.setRotationSpeed.bind(this));

    // Lightbulb service (LED)
    this.lightbulbService = this.accessory.getService(this.platform.Service.Lightbulb)
      || this.accessory.addService(this.platform.Service.Lightbulb);
    this.lightbulbService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${accessory.context.device.name || 'Unknown'} LED`,
    );

    this.lightbulbService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setLED.bind(this));

    if (this.supportsBrightness) {
      this.lightbulbService.getCharacteristic(this.platform.Characteristic.Brightness)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onSet(this.setLEDBrightness.bind(this));
    }

    if (this.supportsColor) {
      // HomeKit ColorTemperature is in mireds. Atomberg has 3 modes — we span
      // cool..warm (154..370 mired) and quantize on set.
      this.lightbulbService.getCharacteristic(this.platform.Characteristic.ColorTemperature)
        .setProps({ minValue: COLOR_TEMP_COOL_MIRED, maxValue: COLOR_TEMP_WARM_MIRED, minStep: 1 })
        .onSet(this.setLEDTemperature.bind(this));
    }

    // Single-tile UI: surface as one fan accessory in the Home app, with the
    // LED reachable as a sub-control rather than a separate top-level tile.
    // setPrimaryService is only available on Homebridge ≥1.6 / hap-nodejs ≥0.10.
    if (typeof (this.fanService as unknown as { setPrimaryService?: (v: boolean) => void }).setPrimaryService === 'function') {
      (this.fanService as unknown as { setPrimaryService: (v: boolean) => void }).setPrimaryService(true);
    }
    this.fanService.addLinkedService(this.lightbulbService);

    this.refreshDeviceStatus(this.fanState);
  }

  async setActive(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    const powerOn = value === this.platform.Characteristic.Active.ACTIVE;
    this.fanState.power = powerOn;
    this.platform.log.debug(`Set Active -> ${powerOn}`);
    this.queueCommand({ power: powerOn });
  }

  async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    const pct = value as number;

    if (pct <= 0) {
      // HomeKit slid to 0 — treat as power-off rather than sending speed=0,
      // which is outside Atomberg's documented 1..6 range.
      this.fanState.power = false;
      this.platform.log.debug('Set RotationSpeed -> 0 (interpreted as power off)');
      this.queueCommand({ power: false });
      return;
    }

    const speed = this.percentageToSpeed(pct);
    this.fanState.last_recorded_speed = speed;
    this.fanState.power = true;
    this.platform.log.debug(`Set RotationSpeed -> ${pct}% (speed ${speed})`);
    this.queueCommand({ speed });
  }

  async setLED(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    const on = value as boolean;
    this.fanState.led = on;
    this.platform.log.debug(`Set LED -> ${on}`);
    this.queueCommand({ led: on });
  }

  async setLEDBrightness(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    let pct = value as number;
    if (pct <= 0) {
      // Brightness 0 from HomeKit is the slider hitting bottom — turn LED off.
      this.fanState.led = false;
      this.platform.log.debug('Set Brightness -> 0 (interpreted as LED off)');
      this.queueCommand({ led: false });
      return;
    }
    pct = clamp(pct, BRIGHTNESS_MIN, BRIGHTNESS_MAX);
    this.fanState.last_recorded_brightness = pct;
    this.fanState.led = true;
    this.platform.log.debug(`Set Brightness -> ${pct}`);
    // Per Atomberg docs the device auto-turns LED on when given a brightness
    // value, so we don't need to send {led: true} alongside.
    this.queueCommand({ brightness: pct });
  }

  async setLEDTemperature(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    const mode = miredToLightMode(value as number);
    this.fanState.last_recorded_color = mode;
    this.platform.log.debug(`Set ColorTemperature -> ${value} mired (${mode})`);
    this.queueCommand({ light_mode: mode });
  }

  /**
   * Push a fresh state snapshot from the broadcast listener back to HomeKit.
   * Updates every characteristic the device supports — earlier versions only
   * updated Active and RotationSpeed, which left the lightbulb out of sync
   * after manual fan-control changes.
   */
  public refreshDeviceStatus(deviceState: AtombergFanDeviceState): void {
    if (!deviceState) {
      return;
    }
    this.fanState = deviceState;

    if (!deviceState.is_online) {
      this.platform.log.debug(`Device ['${this.accessory.displayName}'] offline; skipping refresh`);
      return;
    }

    try {
      const active = deviceState.power
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE;
      this.fanService.updateCharacteristic(this.platform.Characteristic.Active, active);

      const speedPct = deviceState.power ? this.speedToPercentage(deviceState.last_recorded_speed) : 0;
      this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, speedPct);

      this.lightbulbService.updateCharacteristic(this.platform.Characteristic.On, !!deviceState.led);

      if (this.supportsBrightness && typeof deviceState.last_recorded_brightness === 'number') {
        const b = clamp(deviceState.last_recorded_brightness, 0, BRIGHTNESS_MAX);
        this.lightbulbService.updateCharacteristic(this.platform.Characteristic.Brightness, b);
      }

      if (this.supportsColor && deviceState.last_recorded_color) {
        this.lightbulbService.updateCharacteristic(
          this.platform.Characteristic.ColorTemperature,
          lightModeToMired(deviceState.last_recorded_color),
        );
      }
    } catch (error) {
      this.platform.log.error('Failed to refresh device status; enable debug for details');
      if (error) {
        this.platform.log.debug(JSON.stringify(error));
      }
    }
  }

  /**
   * Called when the broadcast listener sees a beacon for this device. Beacons
   * don't carry state, but their presence is proof the fan is reachable on the
   * LAN, so flip is_online to true. This avoids refusing HomeKit commands when
   * the cloud-side `is_online: false` at startup is stale.
   */
  public markOnline(): void {
    this.fanState.is_online = true;
  }

  /**
   * Called when the liveness watchdog sees the device fall silent. Flips
   * is_online to false (so HomeKit set handlers throw a comm-failure rather
   * than dispatching to a fan that won't receive the packet) and pushes the
   * inactive state to HomeKit so the tile shows greyed-out.
   */
  public markOffline(): void {
    if (!this.fanState.is_online) {
      return;
    }
    this.fanState.is_online = false;
    try {
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.Active,
        this.platform.Characteristic.Active.INACTIVE,
      );
    } catch {
      // Non-fatal — the tile will catch up on the next state push.
    }
  }

  private assertOnline(): void {
    if (!this.fanState.is_online) {
      this.platform.log.info(`Device ['${this.accessory.displayName}'] is offline`);
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Coalesce a HomeKit characteristic write into the pending command. Each call
   * resets the flush timer; after COMMAND_DEBOUNCE_MS of quiet, we ship one
   * combined payload. Last-write-wins per key — dragging the slider 0%→100%
   * collapses to a single `speed` value instead of dozens of intermediate
   * cloud calls.
   */
  private queueCommand(partial: AtombergFanCommand): void {
    Object.assign(this.pendingCommand, partial);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const command = this.pendingCommand;
      this.pendingCommand = {};
      if (Object.keys(command).length === 0) {
        return;
      }
      this.sendDeviceUpdate(command).catch(() => undefined);
    }, COMMAND_DEBOUNCE_MS);
  }

  /**
   * Dispatch a command, preferring the LAN UDP path when the device's IP is
   * known. Falls back to the cloud API on UDP failure or when LAN control is
   * disabled by the user (`useCloudOnly`).
   */
  private async sendDeviceUpdate(command: AtombergFanCommand): Promise<void> {
    const deviceId = this.accessory.context.device.device_id;
    const cloudPayload: AtombergFanCommandData = { device_id: deviceId, command };

    if (!this.platform.platformConfig.useCloudOnly) {
      const sentLocally = await this.platform.broadcastListener.sendLocalCommand(deviceId, command);
      if (sentLocally) {
        return;
      }
    }

    try {
      await this.atombergApi.sendCommand(cloudPayload);
    } catch (error) {
      this.platform.log.error('Failed to send device update; enable debug for details');
      if (error) {
        this.platform.log.debug(JSON.stringify(error));
      }
    }
  }

  /** Per-instance percentageToSpeed that respects legacy5Speed. */
  private percentageToSpeed(pct: number): number {
    const clamped = clamp(pct, 1, 100);
    return clamp(Math.ceil(clamped * this.fanSpeedMax / 100), FAN_SPEED_MIN, this.fanSpeedMax);
  }

  /** Per-instance speedToPercentage that respects legacy5Speed. */
  private speedToPercentage(speed: number): number {
    if (speed <= 0) {
      return 0;
    }
    return clamp(Math.round(speed * 100 / this.fanSpeedMax), 0, 100);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function miredToLightMode(mired: number): 'cool' | 'daylight' | 'warm' {
  // Boundaries at the midpoints of the representative mireds: 154/200/370.
  // 177 = (154+200)/2 (rounded), 285 = (200+370)/2 (rounded).
  if (mired < 177) {
    return LIGHT_MODE_COOL;
  }
  if (mired < 285) {
    return LIGHT_MODE_DAYLIGHT;
  }
  return LIGHT_MODE_WARM;
}

function lightModeToMired(mode: string): number {
  switch (mode.toLowerCase()) {
    case LIGHT_MODE_COOL: return COLOR_TEMP_COOL_MIRED;
    case LIGHT_MODE_DAYLIGHT: return COLOR_TEMP_DAYLIGHT_MIRED;
    case LIGHT_MODE_WARM: return COLOR_TEMP_WARM_MIRED;
    default: return COLOR_TEMP_DAYLIGHT_MIRED;
  }
}
