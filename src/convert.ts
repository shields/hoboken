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

// Zigbee2MQTT's "cool", "neutral", and "warm" presets: 4000 K, 2700 K, and
// 2200 K in mireds.
export const COOL_WHITE_COLOR_TEMP = 250;
export const DEFAULT_WHITE_COLOR_TEMP = 370;
export const WARM_WHITE_COLOR_TEMP = 454;

// Siri's "white" is zero saturation, where hue has no meaning. Apple Home
// sends H=228 S=56 when selecting "white" on a color_hs light.
export function isWhite(h: number | undefined, s: number | undefined): boolean {
  return s === 0 || (h === 228 && s === 56);
}

// The Home app's color for a color temperature, which is what it writes to a
// light that has Hue and Saturation but no ColorTemperature, and how it tells
// whether a light that has all three shows a temperature. Each channel is
// a + b / (kelvins + c), limited to 0-1; the constants are those of
// HFGetColorForLightTemperature in Apple's Home framework.
export function colorTempToHueSaturation(mireds: number): {
  hue: number;
  saturation: number;
} {
  const k = 1e6 / mireds;
  const channel = (a: number, b: number, c: number) =>
    Math.min(1, Math.max(0, a + b / (k + c)));
  const warm = k <= 6500;
  const r = warm
    ? 1
    : channel(0.5599538913993148, 1745.0425298314171, -2666.3474220535695);
  const g = warm
    ? channel(1.3302673723350029, -2902.1955373783176, 1669.5803561666639)
    : channel(0.7038120314055455, 1216.6168361476491, -2173.101234308223);
  const b = channel(1.8993753891711276, -8257.799727892569, 2575.2827530017594);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = ((g - b) / d + 6) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
  }
  return { hue: hue * 60, saturation: (d / max) * 100 };
}

// The Home app's temperature wheel reaches 10000 K, and HomeKit's coolest
// ColorTemperature is 140 mireds; a cooler request is limited to that.
const CURVE_MIN = 100;

// Rounding a point of the curve to a whole hue and saturation moves it at most
// 0.88 in the plane below, and Siri's "warm white" is 1.01 from the curve.
const CURVE_TOLERANCE = 1;

function plane(hue: number, saturation: number): [number, number] {
  const angle = (hue * Math.PI) / 180;
  return [saturation * Math.cos(angle), saturation * Math.sin(angle)];
}

let curve: [number, number][] | undefined;

// The color temperature that a hue and saturation stand for, when they lie on
// the Home app's curve. Hue is an angle and means little at low saturation, so
// the distance is measured where hue and saturation are polar coordinates.
export function hueSaturationToColorTemp(
  hue: number,
  saturation: number,
): number | undefined {
  curve ??= Array.from({ length: COLOR_TEMP_MAX - CURVE_MIN + 1 }, (_, i) => {
    const color = colorTempToHueSaturation(CURVE_MIN + i);
    return plane(color.hue, color.saturation);
  });
  const [x, y] = plane(hue, saturation);
  let nearest = Infinity;
  let mireds = CURVE_MIN;
  let [ax, ay] = plane(0, 0);
  for (const [i, [bx, by]] of curve.entries()) {
    if (i > 0) {
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.min(
        1,
        Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)),
      );
      const distance = Math.hypot(ax + t * dx - x, ay + t * dy - y);
      if (distance < nearest) {
        nearest = distance;
        mireds = CURVE_MIN + i - 1 + t;
      }
    }
    [ax, ay] = [bx, by];
  }
  return nearest <= CURVE_TOLERANCE ? mireds : undefined;
}

// The color temperature that a write of hue and saturation asks for, if it
// asks for a white: Siri's "white", "warm white" (H=31 S=33), and "cool white"
// (H=208 S=17), or a point of the Home app's curve.
function requestedColorTemp(
  h: number | undefined,
  s: number | undefined,
  whiteColorTemp: number | undefined,
): number | undefined {
  if (isWhite(h, s)) return whiteColorTemp ?? DEFAULT_WHITE_COLOR_TEMP;
  if (h === 31 && s === 33) return WARM_WHITE_COLOR_TEMP;
  if (h === 208 && s === 17) return COOL_WHITE_COLOR_TEMP;
  if (h === undefined || s === undefined) return undefined;
  const mireds = hueSaturationToColorTemp(h, s);
  return mireds === undefined ? undefined : clampColorTemp(Math.round(mireds));
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
// describe the bulb. The Home app shows a light as a color only while its
// ColorTemperature is the minimum, and otherwise as a temperature.
function z2mColorToHomeKit(
  state: RawState,
  capabilities?: readonly string[],
): HomeKitState {
  const hk: HomeKitState = {};
  const { color_mode: mode, color_temp: colorTemp } = state;
  if (mode === "color_temp" && typeof colorTemp === "number") {
    const color = colorTempToHueSaturation(clampColorTemp(colorTemp));
    hk.color_temp = colorTemp;
    hk.hue = Math.round(color.hue);
    hk.saturation = Math.round(color.saturation);
    return hk;
  }
  if (typeof mode === "string") {
    // A light without Hue and Saturation has no color to show, and keeps its
    // last temperature.
    if (mode !== "color_temp" && capabilities?.includes("color_hs") !== false)
      hk.color_temp = COLOR_TEMP_MIN;
  } else if ("color_temp" in state) {
    hk.color_temp = colorTemp as number;
  }
  const color = state.color as Record<string, unknown> | null | undefined;
  if (typeof color?.hue === "number") hk.hue = color.hue;
  if (typeof color?.saturation === "number") hk.saturation = color.saturation;
  return hk;
}

// What HomeKit should show after a write, for the characteristics that the
// write did not set: the report that follows a write is suppressed.
export function z2mWriteToHomeKit(
  message: Record<string, unknown>,
): HomeKitState {
  if (typeof message.color_temp === "number") {
    return z2mColorToHomeKit({
      color_mode: "color_temp",
      color_temp: message.color_temp,
    });
  }
  return typeof message.color === "object"
    ? z2mColorToHomeKit({ color_mode: "hs", color: message.color })
    : {};
}

// `merged` is the whole cached state when `raw` is one update to it.
export function z2mToHomeKit(
  raw: RawState,
  merged = raw,
  capabilities?: readonly string[],
): HomeKitState {
  const hk: HomeKitState = {};
  if ("state" in raw) hk.on = raw.state === "ON";
  if ("brightness" in raw)
    hk.brightness = z2mBrightnessToHomeKit(raw.brightness as number);
  if ("color" in raw || "color_temp" in raw || "color_mode" in raw)
    Object.assign(hk, z2mColorToHomeKit(merged, capabilities));
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
  // A light that shows a color reports the minimum ColorTemperature, so a
  // controller that writes all three back, as a scene does, means the color.
  const colorWithMinimum =
    payload.color_temp === COLOR_TEMP_MIN &&
    "hue" in payload &&
    "saturation" in payload;
  if ("color_temp" in payload && !colorWithMinimum) {
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
    const colorTemp = whiteLEDs
      ? requestedColorTemp(h, s, light.whiteColorTemp)
      : undefined;
    if (colorTemp === undefined) {
      const color: Record<string, unknown> = {};
      if ("hue" in payload) color.hue = payload.hue;
      if ("saturation" in payload) color.saturation = payload.saturation;
      z2m.color = color;
    } else {
      z2m.color_temp = colorTemp;
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
