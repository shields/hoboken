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

import type { Capability } from "./config.ts";
import {
  colorTempRange,
  colorTempToHueSaturation,
  type HomeKitState,
  type WledLight,
  wledUnrememberedWhite,
} from "./convert.ts";

// HomeKit offers Adaptive Lighting only for a light that can change both its
// brightness and its color temperature.
export function hasAdaptiveLighting(device: {
  capabilities: readonly Capability[];
}): boolean {
  return (
    device.capabilities.includes("brightness") &&
    device.capabilities.includes("color_temp")
  );
}

// The temperature that Adaptive Lighting last asked a light for, and the one
// the light showed when it was asked for that same temperature again.
export interface AdaptiveRequest {
  temperature: number;
  shown: number | undefined;
}

// A light that is off may ignore the temperature, report it as applied, or turn
// on, and the temperature that the device shows is not sent again. The device's
// own state is the only record of either: a remembered value goes stale when the
// light turns off or changes outside HomeKit. A bulb whose range is narrower
// than the characteristic's clamps a temperature to its own limit and never
// shows the one asked for, so a temperature that it showed the same value for
// twice is left alone until something changes what it shows.
export function shouldPublishAdaptiveTemperature(
  state: HomeKitState,
  temperature: number,
  last?: AdaptiveRequest,
): boolean {
  return (
    state.on === true &&
    state.color_temp !== temperature &&
    !(
      last?.temperature === temperature &&
      typeof last.shown === "number" &&
      last.shown === state.color_temp
    )
  );
}

// Zigbee2MQTT and WLED turn a light on for a brightness above zero, so a write
// that gives one and no power state turns a light on as On does.
function setsPositiveBrightness(payload: Record<string, unknown>): boolean {
  return (
    !("on" in payload) &&
    typeof payload.brightness === "number" &&
    payload.brightness > 0
  );
}

// Whether a write turns on a light that is not on. A light of unknown state
// counts as off.
export function turnsLightOn(
  payload: Record<string, unknown>,
  state: HomeKitState,
): boolean {
  return (
    state.on !== true &&
    (payload.on === true || setsPositiveBrightness(payload))
  );
}

// The power and temperature that a write gives a light. They stand in for the
// cached state until the device has had time to report them: a light just
// turned off must not be sent a temperature, and one just turned on must be.
export function writtenState(payload: Record<string, unknown>): HomeKitState {
  const { on, color_temp: colorTemp } = payload;
  return {
    ...(typeof on === "boolean"
      ? { on }
      : setsPositiveBrightness(payload)
        ? { on: true }
        : payload.brightness === 0
          ? { on: false }
          : {}),
    ...(typeof colorTemp === "number" ? { color_temp: colorTemp } : {}),
  };
}

// A write that turns a light on and asks for no color or temperature of its own
// gets the temperature that Adaptive Lighting last asked for, because the light
// was not sent it while off. A light that is already on has it, and a change of
// its Brightness brings a new one. Returns `payload` itself when nothing is
// added.
export function withAdaptiveTemperature(
  payload: Record<string, unknown>,
  temperature: number | undefined,
  active: boolean,
  state: HomeKitState,
): Record<string, unknown> {
  return !active ||
    temperature === undefined ||
    !turnsLightOn(payload, state) ||
    "hue" in payload ||
    "saturation" in payload ||
    "color_temp" in payload
    ? payload
    : { ...payload, color_temp: temperature };
}

// A color set at the device or in Zigbee2MQTT ends Adaptive Lighting, as a
// color written by a controller does. A light that shows a color reports the
// minimum ColorTemperature, and a white at the minimum, where Adaptive Lighting
// clamps at midday, reports the hue and saturation of that temperature. A
// light with white strips reports the white at its end without a lit w channel
// as a color, unless the bridge remembers writing it.
export function showsColor(
  state: HomeKitState,
  device: WledLight & { capabilities: readonly Capability[] },
): boolean {
  const [minimum] = colorTempRange(device);
  if (
    !device.capabilities.includes("color_hs") ||
    state.color_temp === undefined ||
    state.color_temp > minimum
  )
    return false;
  const white = colorTempToHueSaturation(minimum);
  const unremembered = wledUnrememberedWhite(device);
  const isHueSaturation = (hue: number, saturation: number) =>
    state.hue === hue && state.saturation === saturation;
  return !(
    isHueSaturation(Math.round(white.hue), Math.round(white.saturation)) ||
    (unremembered && isHueSaturation(unremembered.hue, unremembered.saturation))
  );
}
