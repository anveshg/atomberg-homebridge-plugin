export const PLATFORM_NAME = 'Atomberg Fan';

export const PLUGIN_NAME = 'homebridge-atomberg-fan';

export const LOGIN_RETRY_DELAY = 360 * 1000;

// Fallback only — preferred path is JWT-exp aware refresh in atombergApi.ts
export const LOGIN_TOKEN_REFRESH_INTERVAL = 23 * 60 * 60 * 1000;

export const ATOMBERG_API_HOST = 'https://api.developer.atomberg-iot.com';

export const ATOMBERG_API_ENDPOINTS = {
  GET_ACCESS_TOKEN: '/v1/get_access_token',
  GET_DEVICES: '/v1/get_list_of_devices',
  SEND_COMMAND: '/v1/send_command',
  GET_DEVICE_STATE: '/v1/get_device_state',
};

export const ATOMBERG_ERROR_CODES: { [code: number]: string } = {
  401: 'Access token expired',
  403: 'Forbidden, please make sure Developer mode is enabled and correct token is provided',
  404: 'Device not found',
  429: 'API limit Reached',
};

// UDP ports per Atomberg developer docs.
//   5625: device → LAN broadcasts (beacons every ~1s + state messages on change)
//   5600: LAN → device for direct commands (no ack)
export const UDP_BROADCAST_PORT = 5625;
export const UDP_COMMAND_PORT = 5600;

// Series the plugin will register as accessories. Anything outside this list is
// likely either non-fan hardware or unverified — skip with a warning rather than
// crashing the platform. Aligned with the dasshubham762/atomberg-integration HA list.
export const SUPPORTED_SERIES: ReadonlyArray<string> = [
  'R1', 'R2', 'K1', 'I1', 'I2', 'I3', 'M1', 'S1', 'S2',
];

// Series whose lightbulb supports dimming. Per Atomberg docs: I1 (Aris Starlight)
// and M1 (Aris Contour); S1 covers Renesa Elite and Studio Nexus. S2 is included
// to match the HA integration's working list.
export const BRIGHTNESS_SERIES: ReadonlyArray<string> = ['I1', 'M1', 'S1', 'S2'];

// Series whose lightbulb supports color modes. Only Aris Starlight (I1).
export const COLOR_MODE_SERIES: ReadonlyArray<string> = ['I1'];

// Atomberg accepts 1..6 fan speeds.
export const FAN_SPEED_MIN = 1;
export const FAN_SPEED_MAX = 6;

// Atomberg accepts 10..100 brightness per OpenAPI; the working HA integration uses
// 1..100. We expose 1..100 to HomeKit and let the device handle low values, but
// clamp anything below 1 to 1 to avoid outright invalid commands.
export const BRIGHTNESS_MIN = 1;
export const BRIGHTNESS_MAX = 100;

// HomeKit ColorTemperature is in mireds (1e6 / Kelvin). Atomberg only exposes
// three discrete modes; we map them to representative mireds inside HomeKit's
// 140..500 range so the slider works naturally.
export const COLOR_TEMP_COOL_MIRED = 154;       // ~6500K
export const COLOR_TEMP_DAYLIGHT_MIRED = 200;   // ~5000K
export const COLOR_TEMP_WARM_MIRED = 370;       // ~2700K

// Atomberg light_mode strings. The cloud API returns these in lowercase, so we
// normalize everywhere to match.
export const LIGHT_MODE_COOL = 'cool';
export const LIGHT_MODE_DAYLIGHT = 'daylight';
export const LIGHT_MODE_WARM = 'warm';

// Treat a device as offline if no UDP broadcast/beacon was seen within this window.
// Atomberg fans beacon every ~1s, so 30s is conservative.
export const DEVICE_AVAILABILITY_TIMEOUT_MS = 30 * 1000;
