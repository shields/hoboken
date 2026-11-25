// Copyright © 2026 Michael Shields
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// HAP-NodeJS's entry point fails to load under Bun without test/preload.ts,
// which demo/screenshot.ts does not have when it renders the status page.
import { ColorUtils } from "@homebridge/hap-nodejs/dist/lib/util/color-utils.js";

// Zigbee2MQTT's "neutral" and "warm" presets: 2700 K and 2200 K in mireds.
export const DEFAULT_WHITE_COLOR_TEMP = 370;
export const WARM_WHITE_COLOR_TEMP = 454;

// Siri's "white" is zero saturation, where hue has no meaning. Apple Home
// sends H=228 S=56 when selecting "white" on a color_hs light.
export function isWhite(h: number | undefined, s: number | undefined): boolean {
  return s === 0 || (h === 228 && s === 56);
}

// Siri's "warm white".
function isWarmWhite(h: number | undefined, s: number | undefined): boolean {
  return h === 31 && s === 33;
}

export function z2mBrightnessToHomeKit(z2m: number): number {
  if (Number.isNaN(z2m)) throw new RangeError("brightness must be a number");
  const clamped = Math.max(0, Math.min(254, z2m));
  return clamped === 0 ? 0 : Math.round(((clamped - 1) / 253) * 99 + 1);
}

export function homeKitBrightnessToZ2M(hk: number): number {
  if (Number.isNaN(hk)) throw new RangeError("brightness must be a number");
  const clamped = Math.max(0, Math.min(100, hk));
  return clamped === 0 ? 0 : Math.round(((clamped - 1) / 99) * 253 + 1);
}

// HAP ColorTemperature characteristic only accepts 140–500 mireds.
// Zigbee2MQTT devices can report values outside this range (e.g. 0 or 65535
// when color_temp mode isn't active). Without clamping, hap-nodejs emits
// characteristic warnings and HomeKit may reject the update entirely.
export const COLOR_TEMP_MIN = 140;
export const COLOR_TEMP_MAX = 500;

export function clampColorTemp(mireds: number): number {
  return Math.max(COLOR_TEMP_MIN, Math.min(COLOR_TEMP_MAX, mireds));
}

// RotationSpeed is a percentage, because Siri's low, medium, and high are
// reported to break on a 0-3 scale. The step must be exactly 100 / 3: HAP-NodeJS
// caps the range at the last whole step, so 33 or 33.33 would top out below 100.
export const FAN_SPEED_STEP = 100 / 3;

export function z2mFanModeToHomeKit(mode: string): Partial<HomeKitState> {
  switch (mode) {
    case "off":
      return { rotation_speed: 0, target_fan_state: 0 };
    case "low":
      return { rotation_speed: 33, target_fan_state: 0 };
    case "medium":
      return { rotation_speed: 67, target_fan_state: 0 };
    case "high":
      return { rotation_speed: 100, target_fan_state: 0 };
    case "smart":
      return { target_fan_state: 1 };
    case "on":
      return {};
  }
  return {};
}

export function homeKitSpeedToZ2mFanMode(speed: number): string {
  if (speed <= 0) return "off";
  const step = Math.round(speed / FAN_SPEED_STEP);
  if (step <= 1) return "low";
  return step === 2 ? "medium" : "high";
}

export function wledBrightnessToHomeKit(wled: number): number {
  if (Number.isNaN(wled)) throw new RangeError("brightness must be a number");
  return Math.round((Math.max(0, Math.min(255, wled)) / 255) * 100);
}

export function homeKitBrightnessToWled(hk: number): number {
  if (Number.isNaN(hk)) throw new RangeError("brightness must be a number");
  return Math.round((Math.max(0, Math.min(100, hk)) / 100) * 255);
}

export function hsToRgb(h: number, s: number): [number, number, number] {
  const c = s / 100;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - c;

  let r1: number, g1: number, b1: number;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

export function rgbToHs(
  r: number,
  g: number,
  b: number,
): { hue: number; saturation: number } {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;
  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rNorm) h = 60 * (((gNorm - bNorm) / d) % 6);
    else if (max === gNorm) h = 60 * ((bNorm - rNorm) / d + 2);
    else h = 60 * ((rNorm - gNorm) / d + 4);
  }
  if (h < 0) h += 360;

  const s = max === 0 ? 0 : (d / max) * 100;

  return { hue: Math.round(h), saturation: Math.round(s) };
}

export type RawState = Record<string, unknown>;

export interface HomeKitState {
  on?: boolean;
  brightness?: number;
  hue?: number;
  saturation?: number;
  color_temp?: number;
  active?: number;
  rotation_speed?: number;
  target_fan_state?: number;
}

// Zigbee2MQTT keeps reporting the fields of the color mode that is not active:
// in "hs" or "xy" mode a color_temp derived from the color, and in "color_temp"
// mode a color derived from the temperature. Only the active mode's fields
// describe the bulb, and HomeKit shows a temperature as the hue and saturation
// of ColorUtils.
function z2mColorToHomeKit(state: RawState): HomeKitState {
  const hk: HomeKitState = {};
  const { color_mode: mode, color_temp: colorTemp } = state;
  if (mode === "color_temp" && typeof colorTemp === "number") {
    hk.color_temp = colorTemp;
    Object.assign(
      hk,
      ColorUtils.colorTemperatureToHueAndSaturation(clampColorTemp(colorTemp)),
    );
    return hk;
  }
  if ("color_temp" in state && typeof mode !== "string")
    hk.color_temp = colorTemp as number;
  const color = state.color as Record<string, unknown> | null | undefined;
  if (typeof color?.hue === "number") hk.hue = color.hue;
  if (typeof color?.saturation === "number") hk.saturation = color.saturation;
  return hk;
}

// `merged` is the whole cached state when `raw` is one update to it.
export function z2mToHomeKit(raw: RawState, merged = raw): HomeKitState {
  const hk: HomeKitState = {};
  if ("state" in raw) hk.on = raw.state === "ON";
  if ("brightness" in raw)
    hk.brightness = z2mBrightnessToHomeKit(raw.brightness as number);
  if ("color" in raw || "color_temp" in raw || "color_mode" in raw)
    Object.assign(hk, z2mColorToHomeKit(merged));
  if ("fan_state" in raw) hk.active = raw.fan_state === "ON" ? 1 : 0;
  if ("fan_mode" in raw) {
    const fanHk = z2mFanModeToHomeKit(raw.fan_mode as string);
    Object.assign(hk, fanHk);
  }
  return hk;
}

// HomeKit has no white channel, so a lit one is folded into each color channel.
export function wledRgb(
  r: number,
  g: number,
  b: number,
  w = 0,
): [number, number, number] {
  return [Math.min(255, r + w), Math.min(255, g + w), Math.min(255, b + w)];
}

export function wledToHomeKit(raw: RawState): HomeKitState {
  const hk: HomeKitState = {};
  if ("on" in raw) hk.on = raw.on === true;
  if ("bri" in raw) hk.brightness = wledBrightnessToHomeKit(raw.bri as number);
  if ("col" in raw) {
    const col = raw.col;
    if (Array.isArray(col) && col.length >= 3) {
      const hs = rgbToHs(
        ...wledRgb(...(col as [number, number, number, number?])),
      );
      hk.hue = hs.hue;
      hk.saturation = hs.saturation;
    }
  }
  return hk;
}

export function homeKitToZ2m(
  payload: Record<string, unknown>,
  cachedRaw?: RawState,
  light: { whiteColorTemp?: number; capabilities?: readonly string[] } = {},
): Record<string, unknown> {
  const z2m: Record<string, unknown> = {};

  if ("on" in payload) z2m.state = payload.on ? "ON" : "OFF";
  if ("brightness" in payload)
    z2m.brightness = homeKitBrightnessToZ2M(payload.brightness as number);
  if ("color_temp" in payload) {
    // Zigbee2MQTT sends a command for each of color_temp and color, so a
    // write with both publishes only the temperature.
    z2m.color_temp = payload.color_temp;
  } else if ("hue" in payload || "saturation" in payload) {
    const h = payload.hue as number | undefined;
    const s = payload.saturation as number | undefined;
    // Never the cached color_temp: while a bulb shows a color, Zigbee2MQTT
    // reports a color_temp derived from that color. A reported color_temp only
    // shows that the bulb has white LEDs.
    const whiteLEDs =
      light.whiteColorTemp !== undefined ||
      light.capabilities?.includes("color_temp") === true ||
      cachedRaw?.color_temp !== undefined;
    if (whiteLEDs && isWhite(h, s)) {
      z2m.color_temp = light.whiteColorTemp ?? DEFAULT_WHITE_COLOR_TEMP;
    } else if (whiteLEDs && isWarmWhite(h, s)) {
      z2m.color_temp = WARM_WHITE_COLOR_TEMP;
    } else {
      const color: Record<string, unknown> = {};
      if ("hue" in payload) color.hue = payload.hue;
      if ("saturation" in payload) color.saturation = payload.saturation;
      z2m.color = color;
    }
  }

  if ("active" in payload) z2m.fan_state = payload.active ? "ON" : "OFF";

  if ("target_fan_state" in payload && payload.target_fan_state === 1) {
    z2m.fan_mode = "smart";
  } else if ("rotation_speed" in payload) {
    z2m.fan_mode = homeKitSpeedToZ2mFanMode(payload.rotation_speed as number);
  } else if ("target_fan_state" in payload && payload.target_fan_state === 0) {
    const cachedMode = cachedRaw?.fan_mode as string | undefined;
    z2m.fan_mode =
      cachedMode === "low" ||
      cachedMode === "medium" ||
      cachedMode === "high" ||
      cachedMode === "off"
        ? cachedMode
        : "medium";
  }

  return z2m;
}

export function homeKitToWled(
  payload: Record<string, unknown>,
  cachedRaw?: RawState,
): Record<string, unknown> {
  const api: Record<string, unknown> = {};

  if ("on" in payload) api.on = payload.on;
  if ("brightness" in payload)
    api.bri = homeKitBrightnessToWled(payload.brightness as number);

  if ("hue" in payload || "saturation" in payload) {
    // Fill the missing HS component from cached raw state. This round-trips
    // through RGB→HSV→RGB, which is lossy due to integer rounding at each step.
    const cachedHK = cachedRaw ? wledToHomeKit(cachedRaw) : {};
    const h = (payload.hue as number | undefined) ?? cachedHK.hue ?? 0;
    const s =
      (payload.saturation as number | undefined) ?? cachedHK.saturation ?? 0;

    const [r, g, b] = isWhite(h, s) ? [255, 255, 255] : hsToRgb(h, s);
    api.seg = [{ col: [[r, g, b]] }];
  }

  return api;
}

// WLED prints (W << 24) | (R << 16) | (G << 8) | B with at least six digits, so
// a lit white channel adds one or two digits in front of the color.
export function parseWledHexColor(
  hex: string,
): [number, number, number] | [number, number, number, number] | undefined {
  const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[\da-f]{6,8}$/i.test(cleaned)) return undefined;
  const value = Number.parseInt(cleaned, 16);
  const r = (value >>> 16) & 0xff;
  const g = (value >>> 8) & 0xff;
  const b = value & 0xff;
  const w = value >>> 24;
  return w === 0 ? [r, g, b] : [r, g, b, w];
}

export function parseWledMessage(
  subTopic: string,
  raw: string,
): RawState | undefined {
  if (subTopic === "g") {
    const bri = Number.parseInt(raw, 10);
    return Number.isNaN(bri) ? undefined : { on: bri > 0, bri };
  }
  if (subTopic === "c") {
    const col = parseWledHexColor(raw);
    return col ? { col } : undefined;
  }
  return undefined;
}
