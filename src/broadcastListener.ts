import dgram from 'dgram';
import { Logger } from 'homebridge';
import { EventEmitter } from 'events';
import { AtombergFanDeviceState } from './model';
import {
  BRIGHTNESS_SERIES,
  COLOR_MODE_SERIES,
  DEVICE_AVAILABILITY_TIMEOUT_MS,
  LIGHT_MODE_COOL,
  LIGHT_MODE_DAYLIGHT,
  LIGHT_MODE_WARM,
  LIVENESS_PROBE_INTERVAL_MS,
  UDP_BROADCAST_PORT,
  UDP_COMMAND_PORT,
} from './settings';

interface DeviceRoute {
  ip: string;
  series: string | null;
  lastSeen: number;
}

/**
 * BroadcastListener
 *
 * Listens for UDP traffic from Atomberg fans on UDP/5625:
 *   - Beacons (~1/s, short ASCII "<mac>_<series>") — used for IP discovery only.
 *   - State messages (hex-encoded JSON with `state_string`) — decoded to update
 *     HomeKit characteristics without burning cloud-API quota.
 *
 * Also exposes sendLocalCommand() so the rest of the plugin can target a fan
 * directly on UDP/5600 instead of going through the cloud.
 *
 * The socket binds with reuseAddr so a Home Assistant instance on the same host
 * (which uses the same broadcast port) can listen alongside Homebridge.
 */
class BroadcastListener extends EventEmitter {
  private static instance: BroadcastListener;
  private readonly socket: dgram.Socket;
  private readonly log: Logger;
  private readonly routes: Map<string, DeviceRoute> = new Map();
  // Devices we've previously emitted 'offline' for. Avoids spamming the same
  // event every probe tick while the device stays silent.
  private readonly offlineSet: Set<string> = new Set();
  private livenessTimer: NodeJS.Timeout | undefined;
  private bound = false;

  private constructor(log: Logger) {
    super();
    this.log = log;
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  }

  public static getInstance(log: Logger): BroadcastListener {
    if (!BroadcastListener.instance) {
      BroadcastListener.instance = new BroadcastListener(log);
    }
    return BroadcastListener.instance;
  }

  public listen(): void {
    if (this.bound) {
      return;
    }
    this.bound = true;

    this.log.debug(`Listening for Atomberg broadcasts on UDP/${UDP_BROADCAST_PORT}`);
    this.socket.on('listening', () => {
      const addr = this.socket.address();
      this.log.debug(`UDP socket listening on ${addr.address}:${addr.port}`);
    });
    this.socket.on('message', this.onMessage.bind(this));
    this.socket.on('error', (err) => {
      this.log.error('UDP socket error: ', err);
    });
    this.socket.bind(UDP_BROADCAST_PORT);

    this.livenessTimer = setInterval(() => this.runLivenessProbe(), LIVENESS_PROBE_INTERVAL_MS);
    // Don't keep the Homebridge process alive just to run this probe.
    if (typeof this.livenessTimer.unref === 'function') {
      this.livenessTimer.unref();
    }
  }

  public close(): void {
    if (!this.bound) {
      return;
    }
    this.bound = false;
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
    try {
      this.socket.close();
    } catch (e) {
      this.log.debug('Error closing UDP socket: ', e);
    }
  }

  /**
   * Sweep the routes map and emit 'offline' for any device whose last UDP
   * traffic is older than DEVICE_AVAILABILITY_TIMEOUT_MS. Re-emit 'online' once
   * fresh traffic arrives. Cheap — runs every LIVENESS_PROBE_INTERVAL_MS.
   */
  private runLivenessProbe(): void {
    const now = Date.now();
    for (const [deviceId, route] of this.routes) {
      const stale = now - route.lastSeen > DEVICE_AVAILABILITY_TIMEOUT_MS;
      const wasOffline = this.offlineSet.has(deviceId);
      if (stale && !wasOffline) {
        this.offlineSet.add(deviceId);
        this.log.debug(`Device ${deviceId} offline (no UDP traffic for ${Math.round((now - route.lastSeen) / 1000)}s)`);
        this.emit('offline', { device_id: deviceId });
      } else if (!stale && wasOffline) {
        this.offlineSet.delete(deviceId);
      }
    }
  }

  /** Last known LAN IP for a device, or null if we haven't heard a beacon yet. */
  public getDeviceIp(deviceId: string): string | null {
    return this.routes.get(deviceId)?.ip ?? null;
  }

  /**
   * Fire-and-forget UDP command on port 5600 per Atomberg's local-control docs.
   * Returns true if the datagram was handed off to the OS (no app-level ack
   * exists). Callers should fall back to the cloud API on false.
   */
  public sendLocalCommand(deviceId: string, command: object): Promise<boolean> {
    const route = this.routes.get(deviceId);
    if (!route) {
      return Promise.resolve(false);
    }
    if (!this.bound) {
      return Promise.resolve(false);
    }

    const payload = Buffer.from(JSON.stringify(command), 'utf8');
    return new Promise<boolean>((resolve) => {
      this.socket.send(payload, UDP_COMMAND_PORT, route.ip, (err) => {
        if (err) {
          this.log.debug(`Local UDP command to ${deviceId} (${route.ip}) failed: ${err.message}`);
          resolve(false);
          return;
        }
        this.log.debug(`Local UDP command to ${deviceId} (${route.ip}): ${JSON.stringify(command)}`);
        resolve(true);
      });
    });
  }

  private onMessage(message: Buffer, remote: dgram.RemoteInfo): void {
    const text = message.toString('utf8');

    // Beacon: short ASCII "<mac>_<series>". Use to learn IPs.
    if (text.length <= 32 && /^[0-9a-fA-F]{12}(_[A-Za-z0-9]+)?\s*$/.test(text)) {
      this.handleBeacon(text.trim(), remote.address);
      return;
    }

    // State message. Payload is *usually* hex-encoded JSON, but some firmware
    // versions send plain JSON directly. Try plain first when it looks like
    // JSON, then fall through to hex decoding.
    let parsed: { device_id?: string; state_string?: string } | null = null;
    if (text.startsWith('{')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      try {
        const json = Buffer.from(text, 'hex').toString('utf8');
        parsed = JSON.parse(json);
      } catch (err) {
        this.log.debug(`Failed to parse UDP message from ${remote.address}: ${(err as Error).message}`);
        return;
      }
    }
    if (!parsed?.device_id) {
      return;
    }
    this.touchRoute(parsed.device_id, remote.address, null);
    const state = this.decodeStateString(parsed.device_id, parsed.state_string);
    if (state) {
      this.emit('stateChange', state);
    }
  }

  private handleBeacon(payload: string, ip: string): void {
    const [deviceId, series] = payload.split('_');
    if (!deviceId) {
      return;
    }
    this.touchRoute(deviceId, ip, series ?? null);
    this.emit('beacon', { device_id: deviceId, ip, series: series ?? null });
  }

  private touchRoute(deviceId: string, ip: string, series: string | null): void {
    const existing = this.routes.get(deviceId);
    if (!existing || existing.ip !== ip || (series && existing.series !== series)) {
      this.log.debug(`Routing for ${deviceId}: ip=${ip}${series ? `, series=${series}` : ''}`);
    }
    this.routes.set(deviceId, {
      ip,
      series: series ?? existing?.series ?? null,
      lastSeen: Date.now(),
    });
    if (this.offlineSet.delete(deviceId)) {
      this.log.debug(`Device ${deviceId} back online`);
      this.emit('recovered', { device_id: deviceId });
    }
  }

  /**
   * Decode the first comma-separated field of `state_string`, which is a
   * decimal-encoded bitfield. The exact bit layout is documented at
   * https://developer.atomberg-iot.com/ under "Get Device State".
   *
   * Implementation follows the Home Assistant integration's decoder, with
   * unsigned right-shifts so timer-elapsed minutes don't underflow when the
   * top bit of the 32-bit value is set.
   */
  private decodeStateString(deviceId: string, stateString: string | undefined): AtombergFanDeviceState | null {
    if (!stateString) {
      return null;
    }
    const head = stateString.split(',')[0]?.trim();
    if (!head || !/^\d+$/.test(head)) {
      return null;
    }
    const value = parseInt(head, 10);
    if (!Number.isFinite(value)) {
      return null;
    }

    const power = (value & 0x10) > 0;
    const led = (value & 0x20) > 0;
    const sleep = (value & 0x80) > 0;
    const speed = value & 0x07;
    const timerHours = (value & 0x0F0000) >>> 16;
    // Top byte holds elapsed-minutes / 4. Use unsigned shift so values with
    // the high bit set don't go negative.
    const timerElapsedMins = ((value & 0xFF000000) >>> 24) * 4;

    const series = this.routes.get(deviceId)?.series ?? null;
    const supportsBrightness = series ? BRIGHTNESS_SERIES.includes(series) : true;
    const supportsColor = series ? COLOR_MODE_SERIES.includes(series) : true;

    const state: AtombergFanDeviceState = {
      device_id: deviceId,
      is_online: true,
      power,
      led,
      sleep_mode: sleep,
      last_recorded_speed: speed,
      timer_hours: timerHours,
      timer_time_elapsed_mins: timerElapsedMins,
    };

    if (supportsBrightness) {
      state.last_recorded_brightness = (value & 0x7F00) >>> 8;
    }
    if (supportsColor) {
      const cool = (value & 0x08) > 0;
      const warm = (value & 0x8000) > 0;
      if (cool && warm) {
        state.last_recorded_color = LIGHT_MODE_DAYLIGHT;
      } else if (cool) {
        state.last_recorded_color = LIGHT_MODE_COOL;
      } else {
        state.last_recorded_color = LIGHT_MODE_WARM;
      }
    }

    return state;
  }
}

export default BroadcastListener;
