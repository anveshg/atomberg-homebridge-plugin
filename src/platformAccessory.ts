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
  FAN_SPEED_MAX,
  FAN_SPEED_MIN,
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

    this.refreshDeviceStatus(this.fanState);
  }

  async setActive(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    const powerOn = value === this.platform.Characteristic.Active.ACTIVE;
    this.fanState.power = powerOn;
    this.platform.log.debug(`Set Active -> ${powerOn}`);
    await this.sendDeviceUpdate({ power: powerOn });
  }

  async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    const pct = value as number;

    if (pct <= 0) {
      // HomeKit slid to 0 — treat as power-off rather than sending speed=0,
      // which is outside Atomberg's documented 1..6 range.
      this.fanState.power = false;
      this.platform.log.debug('Set RotationSpeed -> 0 (interpreted as power off)');
      await this.sendDeviceUpdate({ power: false });
      return;
    }

    const speed = percentageToSpeed(pct);
    this.fanState.last_recorded_speed = speed;
    this.fanState.power = true;
    this.platform.log.debug(`Set RotationSpeed -> ${pct}% (speed ${speed})`);
    await this.sendDeviceUpdate({ speed });
  }

  async setLED(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    const on = value as boolean;
    this.fanState.led = on;
    this.platform.log.debug(`Set LED -> ${on}`);
    await this.sendDeviceUpdate({ led: on });
  }

  async setLEDBrightness(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    let pct = value as number;
    if (pct <= 0) {
      // Brightness 0 from HomeKit is the slider hitting bottom — turn LED off.
      this.fanState.led = false;
      this.platform.log.debug('Set Brightness -> 0 (interpreted as LED off)');
      await this.sendDeviceUpdate({ led: false });
      return;
    }
    pct = clamp(pct, BRIGHTNESS_MIN, BRIGHTNESS_MAX);
    this.fanState.last_recorded_brightness = pct;
    this.fanState.led = true;
    this.platform.log.debug(`Set Brightness -> ${pct}`);
    // Per Atomberg docs the device auto-turns LED on when given a brightness
    // value, so we don't need to send {led: true} alongside.
    await this.sendDeviceUpdate({ brightness: pct });
  }

  async setLEDTemperature(value: CharacteristicValue): Promise<void> {
    this.assertOnline();
    const mode = miredToLightMode(value as number);
    this.fanState.last_recorded_color = mode;
    this.platform.log.debug(`Set ColorTemperature -> ${value} mired (${mode})`);
    await this.sendDeviceUpdate({ light_mode: mode });
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

      const speedPct = deviceState.power ? speedToPercentage(deviceState.last_recorded_speed) : 0;
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

  private assertOnline(): void {
    if (!this.fanState.is_online) {
      this.platform.log.info(`Device ['${this.accessory.displayName}'] is offline`);
      throw new this.platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
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
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Map a HomeKit 0..100 percentage to an Atomberg fan speed in 1..6.
 * Mirrors the ordered-list mapping used in the Home Assistant integration so
 * the same physical "speed N" lines up across both ecosystems.
 */
function percentageToSpeed(pct: number): number {
  const clamped = clamp(pct, 1, 100);
  // ceil ensures any positive percentage maps to at least speed 1.
  return clamp(Math.ceil(clamped * FAN_SPEED_MAX / 100), FAN_SPEED_MIN, FAN_SPEED_MAX);
}

function speedToPercentage(speed: number): number {
  if (speed <= 0) {
    return 0;
  }
  return clamp(Math.round(speed * 100 / FAN_SPEED_MAX), 0, 100);
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
