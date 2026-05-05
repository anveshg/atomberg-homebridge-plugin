<span align="center">

# Homebridge Atomberg Fan

</span>

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![GitHub version](https://img.shields.io/github/package-json/v/Sangwan5688/homebridge-atomberg-fan?label=GitHub)](https://github.com/Sangwan5688/homebridge-atomberg-fan)
[![npm version](https://img.shields.io/npm/v/homebridge-atomberg-fan?color=%23cb3837&label=npm)](https://www.npmjs.com/package/homebridge-atomberg-fan)

Homebridge Atomberg Fan is a plugin for [Homebridge](https://homebridge.io/) that provides Homekit support for [Atomberg Smart Fans](https://atomberg.com/).

## How it works

The plugin uses the [Atomberg public APIs](https://developer.atomberg-iot.com/) for initial device discovery and as a fallback transport, and listens for the fan's UDP broadcasts on port 5625 for live state updates. When a fan's IP address is known from those broadcasts, **commands are sent directly to it on UDP/5600** instead of going through the cloud — this keeps the plugin well under Atomberg's 100 calls/day quota.

Supported series (per the Atomberg developer docs and the upstream Home Assistant integration): R1, R2, K1, I1, I2, I3, M1, S1, S2. Brightness control is offered for I1/M1/S1/S2; color temperature for I1 (Aris Starlight). Speeds 1–6 are mapped onto HomeKit's 0–100 rotation slider.

### Home Assistant coexistence

The UDP listener binds with `SO_REUSEADDR`, so the [`atomberg-integration`](https://github.com/dasshubham762/atomberg-integration) Home Assistant component can run on the same host and receive the same broadcasts. Both ecosystems can control the fans simultaneously without stepping on each other.

## Homebridge Setup

### Step 1: Generate API Key

Go to Atomberg Home App and enable Developer Options to get your `API Key` and `Refresh Token`, as mentioned in Step 1 of Quickstart section on [Atomberg Developer Portal](https://developer.atomberg-iot.com/#overview).

### Step 2: Install Plugin

Go to your Homebrige UI and search for Atomberg Fan in the plugins section and select this plugin.

### Step 3: Configure

Once Installed configure the plugin. Enter you API Key and Refresh Token which you got from Atomberg Home App.
You can even enter the details directly to config file incase you aren't using UI.

```
{
  "platforms": [
    {
      "platform": "Atomberg Fan",
      "name": "Homebridge Atomberg Fan",
      "apiKey": "tw******",
      "refreshToken": "ey******",
      "useCloudOnly": false
    }
  ]
}
```

`useCloudOnly` is optional (default `false`). Set it to `true` only if Homebridge can't reach your fans on the LAN (e.g. running in a Docker bridge network or on a different VLAN) — every command will then count against the cloud quota.

### Step 4: Why not?

That's all, just restart Homebridge and your devices should show up in the Accessories tab of Homebridge. You can now add them to your Apple Home App using homebridge.

## Disclaimer

All product and company names are trademarks™ or registered® trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them.
