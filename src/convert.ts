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

export function z2mBrightnessToHomeKit(z2m: number): number {
  if (Number.isNaN(z2m)) throw new RangeError("brightness must be a number");
  const clamped = Math.max(0, Math.min(254, z2m));
  if (clamped === 0) return 0;
  return Math.round(((clamped - 1) / 253) * 99 + 1);
}

export function homeKitBrightnessToZ2M(hk: number): number {
  if (Number.isNaN(hk)) throw new RangeError("brightness must be a number");
  const clamped = Math.max(0, Math.min(100, hk));
  if (clamped === 0) return 0;
  return Math.round(((clamped - 1) / 99) * 253 + 1);
}

// HAP ColorTemperature characteristic only accepts 140–500 mireds.
// Zigbee2MQTT devices can report values outside this range (e.g. 0 or 65535
// when color_temp mode isn't active). Without clamping, hap-nodejs emits
// characteristic warnings and HomeKit may reject the update entirely.
const COLOR_TEMP_MIN = 140;
const COLOR_TEMP_MAX = 500;

export function clampColorTemp(mireds: number): number {
  return Math.max(COLOR_TEMP_MIN, Math.min(COLOR_TEMP_MAX, mireds));
}

export function wledBrightnessToHomeKit(wled: number): number {
  if (Number.isNaN(wled)) throw new RangeError("brightness must be a number");
  return Math.round((Math.max(0, Math.min(255, wled)) / 255) * 100);
}

export function homeKitBrightnessToWled(hk: number): number {
  if (Number.isNaN(hk)) throw new RangeError("brightness must be a number");
  return Math.round((Math.max(0, Math.min(100, hk)) / 100) * 255);
}

export function hsToRgb(
  h: number,
  s: number,
): [number, number, number] {
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
}

export function z2mToHomeKit(raw: RawState): HomeKitState {
  const hk: HomeKitState = {};
  if ("state" in raw) hk.on = raw.state === "ON";
  if ("brightness" in raw)
    hk.brightness = z2mBrightnessToHomeKit(raw.brightness as number);
  if ("color_temp" in raw) hk.color_temp = raw.color_temp as number;
  if ("color" in raw) {
    const color = raw.color as Record<string, unknown> | null;
    if (typeof color?.hue === "number") hk.hue = color.hue;
    if (typeof color?.saturation === "number")
      hk.saturation = color.saturation;
  }
  return hk;
}

export function wledToHomeKit(raw: RawState): HomeKitState {
  const hk: HomeKitState = {};
  if ("on" in raw) hk.on = raw.on === true;
  if ("bri" in raw)
    hk.brightness = wledBrightnessToHomeKit(raw.bri as number);
  if ("col" in raw) {
    const col = raw.col;
    if (Array.isArray(col) && col.length >= 3) {
      const [r, g, b] = col as [number, number, number];
      const hs = rgbToHs(r, g, b);
      hk.hue = hs.hue;
      hk.saturation = hs.saturation;
    }
  }
  return hk;
}

export function homeKitToZ2m(
  payload: Record<string, unknown>,
  cachedRaw?: RawState,
): Record<string, unknown> {
  const z2m: Record<string, unknown> = {};

  if ("on" in payload) z2m.state = payload.on ? "ON" : "OFF";
  if ("brightness" in payload)
    z2m.brightness = homeKitBrightnessToZ2M(payload.brightness as number);
  if ("color_temp" in payload) z2m.color_temp = payload.color_temp;

  if ("hue" in payload || "saturation" in payload) {
    const h = (payload.hue as number | undefined) ?? 0;
    const s = (payload.saturation as number | undefined) ?? 0;
    if (
      "hue" in payload &&
      "saturation" in payload &&
      h === 0 &&
      s === 0 &&
      cachedRaw?.color_temp !== undefined
    ) {
      z2m.color_temp = cachedRaw.color_temp as number;
    } else {
      const color: Record<string, unknown> = {};
      if ("hue" in payload) color.hue = payload.hue;
      if ("saturation" in payload) color.saturation = payload.saturation;
      z2m.color = color;
    }
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
    const h =
      (payload.hue as number | undefined) ?? cachedHK.hue ?? 0;
    const s =
      (payload.saturation as number | undefined) ?? cachedHK.saturation ?? 0;

    const [r, g, b] = hsToRgb(h, s);
    api.seg = [{ col: [[r, g, b]] }];
  }

  return api;
}

export function parseWledHexColor(
  hex: string,
): [number, number, number] | undefined {
  const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;
  if (cleaned.length < 6) return undefined;
  const r = Number.parseInt(cleaned.slice(0, 2), 16);
  const g = Number.parseInt(cleaned.slice(2, 4), 16);
  const b = Number.parseInt(cleaned.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return undefined;
  return [r, g, b];
}

export function parseWledMessage(
  subTopic: string,
  raw: string,
): RawState | undefined {
  if (subTopic === "g") {
    const bri = Number.parseInt(raw, 10);
    if (Number.isNaN(bri)) return undefined;
    return { on: bri > 0, bri };
  }
  if (subTopic === "c") {
    const col = parseWledHexColor(raw);
    if (!col) return undefined;
    return { col };
  }
  return undefined;
}
