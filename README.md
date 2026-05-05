<span align="center">

# homebridge-atomberg-plugin

</span>

[![npm version](https://img.shields.io/npm/v/homebridge-atomberg-plugin?color=%23cb3837&label=npm)](https://www.npmjs.com/package/homebridge-atomberg-plugin)

Homebridge plugin for [Atomberg](https://atomberg.com/) smart fans and lights, with LAN-first UDP control, full LED triad (on / brightness / colour temperature), single-tile Home app UI, command throttling, and Home Assistant coexistence.

## How it works

The plugin uses the [Atomberg public APIs](https://developer.atomberg-iot.com/) for initial device discovery and as a fallback transport, and listens for the fan's UDP broadcasts on port 5625 for live state updates. When a fan's IP address is known from those broadcasts, **commands are sent directly to it on UDP/5600** instead of going through the cloud — this keeps the plugin well under Atomberg's 100 calls/day quota.

Supported series (per the Atomberg developer docs and the upstream Home Assistant integration): R1, R2, K1, I1, I2, I3, M1, S1, S2. Brightness control is offered for I1/M1/S1/S2; colour temperature for I1 (Aris Starlight). Speeds 1–6 are mapped onto HomeKit's 0–100 rotation slider; legacy 5-speed fans can opt in via `legacy5Speed: true` in config.

### What's different vs `homebridge-atomberg-fan*` on npm

- **LAN-first UDP control** with cloud-API fallback — minutes-old cloud caches stop being your source of truth.
- **Single Home app tile per fan** (Fan v2 primary, LED Lightbulb linked) instead of two separate accessories.
- **Command coalescing**: HomeKit slider drags collapse to one outbound call (250 ms debounce, last-write-wins per command key).
- **Liveness watchdog**: device falls silent → tile flips to off in HomeKit; first beacon back → tile recovers immediately.
- **Plain-JSON UDP** decoder in addition to hex-encoded — works with all firmware variants seen in the wild.
- **Home Assistant coexistence** via `SO_REUSEADDR` — the [`atomberg-integration`](https://github.com/dasshubham762/atomberg-integration) HA component can run on the same host and receive the same broadcasts.

## Homebridge Setup

### Step 1: Generate API Key

Go to Atomberg Home App and enable Developer Options to get your `API Key` and `Refresh Token`, as mentioned in Step 1 of Quickstart section on [Atomberg Developer Portal](https://developer.atomberg-iot.com/#overview).

### Step 2: Install Plugin

In the Homebridge UI Plugins tab, search for `homebridge-atomberg-plugin` and install it. Or from the CLI: `npm install -g homebridge-atomberg-plugin`.

### Step 3: Configure

Once Installed configure the plugin. Enter you API Key and Refresh Token which you got from Atomberg Home App.
You can even enter the details directly to config file incase you aren't using UI.

```
{
  "platforms": [
    {
      "platform": "Atomberg Fan",
      "name": "Homebridge Atomberg",
      "apiKey": "tw******",
      "refreshToken": "ey******",
      "useCloudOnly": false,
      "legacy5Speed": false
    }
  ]
}
```

`useCloudOnly` is optional (default `false`). Set it to `true` only if Homebridge can't reach your fans on the LAN (e.g. running in a Docker bridge network or on a different VLAN) — every command will then count against the cloud quota.

`legacy5Speed` is optional (default `false`). Enable it for pre-2022 Renesa/Studio fans that only expose 5 speed levels — the HomeKit rotation slider will quantize to 1..5 instead of 1..6.

### Step 4: Why not?

That's all, just restart Homebridge and your devices should show up in the Accessories tab of Homebridge. You can now add them to your Apple Home App using homebridge.

## Disclaimer

All product and company names are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them.
