import axios, { AxiosError } from 'axios';
import { Logger } from 'homebridge';
import {
  ATOMBERG_API_ENDPOINTS,
  ATOMBERG_API_HOST,
  ATOMBERG_ERROR_CODES,
  LOGIN_RETRY_DELAY,
  LOGIN_TOKEN_REFRESH_INTERVAL,
} from './settings';
import {
  AtombergFanCommandData,
  AtombergFanDevice,
  AtombergFanDeviceState,
  AtombergFanPlatformConfig,
} from './model';

/**
 * Atomberg cloud API client.
 *
 * Auth flow per Atomberg developer docs:
 *   refresh_token  ── GET /v1/get_access_token ──▶ access_token (24h JWT)
 *   access_token   ── all subsequent calls
 *
 * The plugin uses the cloud API only for: (1) initial device discovery,
 * (2) initial state seeding, and (3) fallback when the LAN UDP path is
 * unavailable. Routine state updates ride on UDP broadcasts to stay well
 * below the 100 calls/day quota.
 */
export default class AtombergApi {
  private accessToken = '';
  private accessTokenExpiresAt = 0;
  private refreshTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly config: AtombergFanPlatformConfig,
  ) {}

  public getAccessToken(): string {
    return this.accessToken;
  }

  public async login(): Promise<boolean> {
    this.clearTimers();

    return axios.request({
      method: 'get',
      url: ATOMBERG_API_HOST + ATOMBERG_API_ENDPOINTS.GET_ACCESS_TOKEN,
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'Authorization': `Bearer ${this.config.refreshToken}`,
      },
    })
      .then((response) => {
        if (response.data.status !== 'Success') {
          this.accessToken = '';
          this.scheduleRetry(JSON.stringify(response.data.message));
          return false;
        }
        this.accessToken = response.data.message.access_token;
        this.accessTokenExpiresAt = this.readJwtExpMs(this.accessToken);
        this.scheduleProactiveRefresh();
        return true;
      })
      .catch((error: AxiosError) => {
        this.handleNetworkRequestError(error);
        return false;
      });
  }

  public async getAllDevices(): Promise<AtombergFanDevice[]> {
    this.logger.debug('AtombergFanApi: fetching device list');
    if (!this.accessToken) {
      return Promise.reject('No auth token available (login probably failed). ' +
        'Check your credentials and restart Homebridge.');
    }

    return axios.request({
      method: 'get',
      url: ATOMBERG_API_HOST + ATOMBERG_API_ENDPOINTS.GET_DEVICES,
      headers: this.authHeaders(),
    })
      .then((response) => {
        if (response.data.status !== 'Success') {
          return Promise.reject(response.data?.message ?? response.data);
        }
        return response.data.message.devices_list as AtombergFanDevice[];
      })
      .catch((error: AxiosError) => {
        this.handleNetworkRequestError(error);
        return Promise.reject();
      });
  }

  /**
   * Cloud state lookup. Used once on startup; routine updates flow over UDP.
   */
  public async getDeviceState(): Promise<AtombergFanDeviceState[]> {
    this.logger.debug('AtombergFanApi: fetching device state');
    if (!this.accessToken) {
      return Promise.reject('No auth token available (login probably failed). ' +
        'Check your credentials and restart Homebridge.');
    }

    return axios.request({
      method: 'get',
      url: ATOMBERG_API_HOST + ATOMBERG_API_ENDPOINTS.GET_DEVICE_STATE,
      headers: this.authHeaders(),
      params: { device_id: 'all' },
    })
      .then((response) => {
        if (response.data.status !== 'Success') {
          return Promise.reject(response.data?.message ?? response.data);
        }
        return response.data.message.device_state as AtombergFanDeviceState[];
      })
      .catch((error: AxiosError) => {
        this.handleNetworkRequestError(error);
        return Promise.reject();
      });
  }

  public async sendCommand(data: AtombergFanCommandData): Promise<boolean> {
    if (!this.accessToken) {
      return Promise.reject('No auth token available (login probably failed). ' +
        'Check your credentials and restart Homebridge.');
    }

    return axios.request({
      method: 'post',
      url: ATOMBERG_API_HOST + ATOMBERG_API_ENDPOINTS.SEND_COMMAND,
      headers: this.authHeaders(),
      data,
    })
      .then((response) => {
        if (response.data.status !== 'Success') {
          return Promise.reject(response.data?.message ?? response.data);
        }
        return true;
      })
      .catch((error: AxiosError) => {
        this.logger.error('AtombergFanApi: sendCommand failed');
        this.handleNetworkRequestError(error);
        return Promise.reject();
      });
  }

  public shutdown(): void {
    this.clearTimers();
  }

  private authHeaders() {
    return {
      'accept': 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'Authorization': `Bearer ${this.accessToken}`,
    };
  }

  private clearTimers() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private scheduleProactiveRefresh() {
    // Refresh 5 minutes before the JWT actually expires; fall back to the
    // documented 23h cadence if we can't read the exp claim.
    let delay = LOGIN_TOKEN_REFRESH_INTERVAL;
    if (this.accessTokenExpiresAt > 0) {
      delay = Math.max(60_000, this.accessTokenExpiresAt - Date.now() - 5 * 60_000);
    }
    this.refreshTimer = setTimeout(() => {
      this.login().catch(() => undefined);
    }, delay);
  }

  private scheduleRetry(error: string) {
    this.logger.debug('AtombergFanApi: login failed: ' + error);
    this.logger.error(
      `Login failed. Homebridge will retry in ${LOGIN_RETRY_DELAY / 1000}s. ` +
      'If the issue persists, verify the API key and refresh token in your config.',
    );
    this.retryTimer = setTimeout(() => {
      this.login().catch(() => undefined);
    }, LOGIN_RETRY_DELAY);
  }

  /**
   * Read JWT `exp` (seconds since epoch) without verifying the signature.
   * Returns 0 if the token is malformed — callers fall back to a fixed cadence.
   */
  private readJwtExpMs(token: string): number {
    const parts = token.split('.');
    if (parts.length < 2) {
      return 0;
    }
    try {
      const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
      const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
      return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
    } catch {
      return 0;
    }
  }

  private handleNetworkRequestError(error: AxiosError) {
    if (error.response) {
      this.logger.debug(JSON.stringify(error.response.data ?? 'Some error occurred'));
      if (error.response.status === 401) {
        // Access token rejected — re-authenticate.
        this.retryTimer = setTimeout(() => {
          this.login().catch(() => undefined);
        }, LOGIN_RETRY_DELAY);
      } else if (ATOMBERG_ERROR_CODES[error.response.status]) {
        this.logger.error(ATOMBERG_ERROR_CODES[error.response.status]);
      }
    } else if (error.request) {
      this.logger.debug('No response from Atomberg API');
    } else {
      this.logger.debug(error.message);
    }
  }
}
