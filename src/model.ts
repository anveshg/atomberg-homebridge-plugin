import {PlatformConfig} from 'homebridge';

export interface AtombergFanPlatformConfig extends PlatformConfig {
    apiKey: string;
    refreshToken: string;
    // When true, never attempt LAN UDP commands; always go through the cloud API.
    // Useful if Homebridge can't see the fans' subnet (VLANs, Docker bridge, etc.).
    useCloudOnly?: boolean;
}

export interface AtombergFanDevice {
    device_id: string;
    color: string;
    series: string;
    model: string;
    room: string;
    name: string;
    metadata: AtombergFanDeviceMetadata;
}

export interface AtombergFanDeviceMetadata {
    ssid: string;
}

// Normalized device state used inside the plugin.
//
// The cloud /get_device_state response uses last_recorded_* keys; the UDP
// state_string carries the same fields under different names again. We
// converge to a single shape so downstream code doesn't have to care which
// transport produced it.
export interface AtombergFanDeviceState {
    device_id: string;
    is_online: boolean;
    power: boolean;
    led: boolean;
    sleep_mode: boolean;
    last_recorded_speed: number;             // 1..6 when on
    timer_hours: number;                     // 0..6 (0 = off)
    timer_time_elapsed_mins: number;
    ts_epoch_seconds?: number;
    last_recorded_brightness?: number;       // 1..100; brightness-capable series only
    last_recorded_color?: string;            // 'cool' | 'daylight' | 'warm'; I1 only
}

export interface AtombergFanCommandData {
    device_id: string;
    command: AtombergFanCommand;
}

// Per the Send Command API docs, every command field is independently optional;
// callers send one or two keys at a time (e.g. {power: true} or {brightness: 50}).
// `Partial` keeps that intent explicit.
export type AtombergFanCommand = Partial<{
    power: boolean;
    speed: number;          // 1..6 absolute
    speedDelta: number;     // -5..+5 relative (excluding 0)
    sleep: boolean;
    timer: number;          // 0=off, 1=1h, 2=2h, 3=3h, 4=6h
    led: boolean;
    brightness: number;     // 10..100; fan auto-turns LED on
    brightnessDelta: number; // -90..+90
    light_mode: 'cool' | 'daylight' | 'warm';
}>;
