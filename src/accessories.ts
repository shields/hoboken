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

import {
  Accessory,
  Categories,
  Characteristic,
  ColorUtils,
  Service,
  uuid,
} from "@homebridge/hap-nodejs";
import type { Capability, DeviceConfig, SceneConfig } from "./config.ts";
import {
  clampColorTemp,
  homeKitBrightnessToZ2M,
  z2mBrightnessToHomeKit,
} from "./convert.ts";

export type Z2MState = Record<string, unknown>;
export type PublishFn = (
  topic: string,
  payload: Record<string, unknown>,
) => void;
export type GetStateFn = (topic: string) => Z2MState | undefined;

type SetPayloadFn = (payload: Record<string, unknown>) => void;

function createCoalescingPublish(
  topic: string,
  publish: PublishFn,
  prePublishCheck?: () => void,
): SetPayloadFn {
  let pending: Record<string, unknown> | undefined;
  let scheduled = false;

  const flush = () => {
    if (!pending) return;
    const payload = pending;
    pending = undefined;
    scheduled = false;
    try {
      publish(`${topic}/set`, payload);
    } catch {
      // Connection may have dropped between the synchronous prePublishCheck
      // and this nextTick flush. The error was already thrown to HAP-NodeJS
      // synchronously; swallow the async duplicate to avoid crashing.
    }
  };

  return (payload) => {
    // Run synchronously so HAP-NodeJS can catch errors (e.g. MQTT disconnect)
    // and report them back to HomeKit.
    prePublishCheck?.();

    pending ??= {};
    for (const [key, value] of Object.entries(payload)) {
      if (
        key === "color" &&
        typeof pending.color === "object" &&
        pending.color !== null
      ) {
        pending.color = {
          ...(pending.color as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else {
        pending[key] = value;
      }
    }
    if (!scheduled) {
      scheduled = true;
      process.nextTick(flush);
    }
  };
}

export function createLightAccessory(
  device: DeviceConfig,
  publish: PublishFn,
  getState: GetStateFn,
  prePublishCheck?: () => void,
): Accessory {
  const accessory = new Accessory(
    device.name,
    uuid.generate(`hoboken:light:${device.topic}`),
  );
  accessory.category = Categories.LIGHTBULB;

  const service = accessory.addService(Service.Lightbulb, device.name);
  const setPayload = createCoalescingPublish(
    device.topic,
    publish,
    prePublishCheck,
  );

  addOnCharacteristic(service, setPayload, getState, device.topic);

  if (device.capabilities.includes("brightness")) {
    addBrightnessCharacteristic(service, setPayload, getState, device.topic);
  }

  if (device.capabilities.includes("color_temp")) {
    addColorTempCharacteristic(service, setPayload, getState, device.topic);
  }

  if (device.capabilities.includes("color_hs")) {
    const hasBothColorModes = device.capabilities.includes("color_temp");
    addHueCharacteristic(
      service,
      setPayload,
      getState,
      device.topic,
      hasBothColorModes,
    );
    addSaturationCharacteristic(
      service,
      setPayload,
      getState,
      device.topic,
      hasBothColorModes,
    );
  }

  return accessory;
}

export function createSceneAccessory(
  device: DeviceConfig,
  scene: SceneConfig,
  publish: PublishFn,
): Accessory {
  const accessory = new Accessory(
    scene.name,
    uuid.generate(`hoboken:scene:${device.topic}:${String(scene.id)}`),
  );
  accessory.category = Categories.SWITCH;

  const service = accessory.addService(Service.Switch, scene.name);
  const on = service.getCharacteristic(Characteristic.On);

  on.onGet(() => false);

  on.onSet((value) => {
    if (value) {
      publish(`${device.topic}/set`, { scene_recall: scene.id });
      setTimeout(() => {
        on.updateValue(false);
      }, 1000);
    }
  });

  return accessory;
}

export function updateAccessoryState(
  accessory: Accessory,
  state: Z2MState,
  capabilities: Capability[],
  colorMode?: string,
): void {
  const service = accessory.getService(Service.Lightbulb);
  if (!service) return;

  if ("state" in state) {
    service
      .getCharacteristic(Characteristic.On)
      .updateValue(state.state === "ON");
  }

  if (capabilities.includes("brightness") && "brightness" in state) {
    service
      .getCharacteristic(Characteristic.Brightness)
      .updateValue(z2mBrightnessToHomeKit(state.brightness as number));
  }

  const hasBoth =
    capabilities.includes("color_temp") && capabilities.includes("color_hs");

  if (hasBoth && colorMode === "color_temp") {
    // CT is authoritative — push CT and convert to H/S via ColorUtils.
    // Suppress raw Z2M color values (stale in CT mode).
    if ("color_temp" in state) {
      const ct = clampColorTemp(state.color_temp as number);
      service
        .getCharacteristic(Characteristic.ColorTemperature)
        .updateValue(ct);
      const converted = ColorUtils.colorTemperatureToHueAndSaturation(ct);
      service.getCharacteristic(Characteristic.Hue).updateValue(converted.hue);
      service
        .getCharacteristic(Characteristic.Saturation)
        .updateValue(converted.saturation);
    }
  } else if (hasBoth && (colorMode === "hs" || colorMode === "xy")) {
    // H/S is authoritative — push H/S, suppress stale CT.
    if ("color" in state) {
      const color = state.color as
        | { hue?: number; saturation?: number }
        | null;
      if (color?.hue !== undefined) {
        service.getCharacteristic(Characteristic.Hue).updateValue(color.hue);
      }
      if (color?.saturation !== undefined) {
        service
          .getCharacteristic(Characteristic.Saturation)
          .updateValue(color.saturation);
      }
    }
  } else {
    // Single-capability device, unknown color_mode, or no color_mode —
    // fall through to push whatever is present.
    if (capabilities.includes("color_temp") && "color_temp" in state) {
      service
        .getCharacteristic(Characteristic.ColorTemperature)
        .updateValue(clampColorTemp(state.color_temp as number));
    }

    if (capabilities.includes("color_hs") && "color" in state) {
      const color = state.color as
        | { hue?: number; saturation?: number }
        | null;
      if (color?.hue !== undefined) {
        service.getCharacteristic(Characteristic.Hue).updateValue(color.hue);
      }
      if (color?.saturation !== undefined) {
        service
          .getCharacteristic(Characteristic.Saturation)
          .updateValue(color.saturation);
      }
    }
  }
}

function addOnCharacteristic(
  service: Service,
  setPayload: SetPayloadFn,
  getState: GetStateFn,
  topic: string,
): void {
  const on = service.getCharacteristic(Characteristic.On);

  on.onGet(() => {
    const state = getState(topic);
    return state?.state === "ON";
  });

  on.onSet((value) => {
    setPayload({ state: value ? "ON" : "OFF" });
  });
}

function addBrightnessCharacteristic(
  service: Service,
  setPayload: SetPayloadFn,
  getState: GetStateFn,
  topic: string,
): void {
  const brightness = service.getCharacteristic(Characteristic.Brightness);

  brightness.onGet(() => {
    const state = getState(topic);
    if (state?.brightness === undefined) return 0;
    return z2mBrightnessToHomeKit(state.brightness as number);
  });

  brightness.onSet((value) => {
    setPayload({ brightness: homeKitBrightnessToZ2M(value as number) });
  });
}

function addColorTempCharacteristic(
  service: Service,
  setPayload: SetPayloadFn,
  getState: GetStateFn,
  topic: string,
): void {
  const ct = service.getCharacteristic(Characteristic.ColorTemperature);

  ct.onGet(() => {
    const state = getState(topic);
    // Clamp to HAP-valid range (140–500 mireds) — Z2M devices may report
    // out-of-range values that cause characteristic warnings.
    return clampColorTemp((state?.color_temp as number | undefined) ?? 140);
  });

  ct.onSet((value) => {
    setPayload({ color_temp: value });
  });
}

function addHueCharacteristic(
  service: Service,
  setPayload: SetPayloadFn,
  getState: GetStateFn,
  topic: string,
  hasBothColorModes: boolean,
): void {
  const hue = service.getCharacteristic(Characteristic.Hue);

  hue.onGet(() => {
    const state = getState(topic);
    if (hasBothColorModes && state?.color_mode === "color_temp") {
      const ct = clampColorTemp(
        (state.color_temp as number | undefined) ?? 140,
      );
      return ColorUtils.colorTemperatureToHueAndSaturation(ct).hue;
    }
    const color = state?.color as { hue?: number } | undefined;
    return color?.hue ?? 0;
  });

  hue.onSet((value) => {
    setPayload({ color: { hue: value } });
  });
}

function addSaturationCharacteristic(
  service: Service,
  setPayload: SetPayloadFn,
  getState: GetStateFn,
  topic: string,
  hasBothColorModes: boolean,
): void {
  const sat = service.getCharacteristic(Characteristic.Saturation);

  sat.onGet(() => {
    const state = getState(topic);
    if (hasBothColorModes && state?.color_mode === "color_temp") {
      const ct = clampColorTemp(
        (state.color_temp as number | undefined) ?? 140,
      );
      return ColorUtils.colorTemperatureToHueAndSaturation(ct).saturation;
    }
    const color = state?.color as { saturation?: number } | undefined;
    return color?.saturation ?? 0;
  });

  sat.onSet((value) => {
    setPayload({ color: { saturation: value } });
  });
}
