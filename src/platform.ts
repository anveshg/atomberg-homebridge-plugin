import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { AtombergFanDevice, AtombergFanDeviceState, AtombergFanPlatformConfig } from './model';
import { AtombergFanPlatformAccessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME, SUPPORTED_SERIES } from './settings';
import BroadcastListener from './broadcastListener';
import AtombergApi from './atombergApi';

export class AtombergFanPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public readonly atombergApi: AtombergApi;
  public readonly broadcastListener: BroadcastListener;
  public readonly platformConfig: AtombergFanPlatformConfig;
  private readonly accessoryInstances: Map<string, AtombergFanPlatformAccessory> = new Map();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.platformConfig = config as AtombergFanPlatformConfig;
    this.atombergApi = new AtombergApi(this.log, this.platformConfig);
    this.broadcastListener = BroadcastListener.getInstance(this.log);

    // Homebridge <1.8 didn't have log.success
    if (!log.success) {
      log.success = log.info;
    }

    this.api.on('didFinishLaunching', () => {
      if (!this.platformConfig.apiKey) {
        this.log.error('apiKey is not configured — aborting plugin start. ' +
          'Set the `API Key` field and restart Homebridge.');
        return;
      }
      if (!this.platformConfig.refreshToken) {
        this.log.error('refreshToken is not configured — aborting plugin start. ' +
          'Set the `Refresh Token` field and restart Homebridge.');
        return;
      }

      this.log.info('Logging into Atomberg cloud API…');
      this.atombergApi.login()
        .then((ok) => {
          if (!ok) {
            this.log.error('Login failed; skipping device discovery.');
            return;
          }
          this.log.info('Logged in to Atomberg.');
          this.discoverDevices();
        })
        .catch((error) => {
          this.log.error('Login failed; skipping device discovery.');
          this.log.debug(error);
        });
    });

    this.api.on('shutdown', () => {
      this.log.debug('Homebridge shutdown — releasing Atomberg resources.');
      this.broadcastListener.close();
      this.atombergApi.shutdown();
    });

    this.broadcastListener.listen();

    // Decoded state messages — push directly to the matching accessory.
    this.broadcastListener.on('stateChange', (state: AtombergFanDeviceState) => {
      const accessoryInstance = this.accessoryInstances.get(state.device_id);
      if (accessoryInstance) {
        accessoryInstance.refreshDeviceStatus(state);
      }
    });

    // Beacons don't carry state but prove the device is reachable on the LAN.
    // Use them to flip is_online to true so commands aren't refused after a
    // stale cloud-side `is_online: false` from startup.
    this.broadcastListener.on('beacon', (msg: { device_id: string }) => {
      const accessoryInstance = this.accessoryInstances.get(msg.device_id);
      if (accessoryInstance) {
        accessoryInstance.markOnline();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  async discoverDevices() {
    this.log.info('Discovering devices on Atomberg platform…');
    let devices: AtombergFanDevice[];
    try {
      devices = await this.atombergApi.getAllDevices();
    } catch (error) {
      this.log.error('Device discovery failed; enable debug for details.');
      this.log.debug(JSON.stringify(error));
      return;
    }

    if (!devices || devices.length === 0) {
      this.log.info('No devices found on Atomberg account.');
      return;
    }

    let deviceStates: AtombergFanDeviceState[] = [];
    try {
      deviceStates = await this.atombergApi.getDeviceState();
    } catch (error) {
      this.log.warn('Initial state fetch failed — will rely on UDP broadcasts.');
      this.log.debug(JSON.stringify(error));
    }

    for (const device of devices) {
      if (!SUPPORTED_SERIES.includes(device.series)) {
        this.log.warn(
          `Skipping device '${device.name}' (${device.device_id}): unsupported series '${device.series}'. ` +
          'If you believe this device should be supported, please open an issue with the model name.',
        );
        continue;
      }

      const uuid = this.api.hap.uuid.generate(device.device_id);
      const existingAccessory = this.accessories.find(a => a.UUID === uuid);
      const deviceState = deviceStates.find(s => s.device_id === device.device_id) as AtombergFanDeviceState;

      if (existingAccessory) {
        this.log.info(`Restoring '${existingAccessory.displayName}' (${device.device_id}) from cache.`);
        existingAccessory.context.device = device;
        existingAccessory.context.deviceDisplayName = device.name;
        this.api.updatePlatformAccessories([existingAccessory]);
        const inst = new AtombergFanPlatformAccessory(this, this.atombergApi, existingAccessory, deviceState);
        this.accessoryInstances.set(device.device_id, inst);
      } else {
        this.log.info(`Adding new accessory: ${device.name}`);
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        const inst = new AtombergFanPlatformAccessory(this, this.atombergApi, accessory, deviceState);
        this.accessoryInstances.set(device.device_id, inst);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Drop cached accessories for devices that no longer exist on the account
    // (or have been swapped to an unsupported series).
    for (const cached of this.accessories) {
      const id = cached.context.device?.device_id;
      const stillPresent = id && devices.find(d => d.device_id === id && SUPPORTED_SERIES.includes(d.series));
      if (!stillPresent) {
        this.log.info(`Removing accessory '${cached.displayName}' (${id ?? 'unknown'}).`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cached]);
      }
    }
  }
}
