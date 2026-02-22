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
  transformPayload?: (p: Record<string, unknown>) => Record<string, unknown>,
): SetPayloadFn {
  let pending: Record<string, unknown> | undefined;
  let scheduled = false;

  const flush = () => {
    if (!pending) return;
    let payload = pending;
    pending = undefined;
    scheduled = false;
    if (transformPayload) payload = transformPayload(payload);
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
  const transformPayload = device.capabilities.includes("color_hs")
    ? createWhiteTransform(getState, device.topic)
    : undefined;
  const setPayload = createCoalescingPublish(
    device.topic,
    publish,
    prePublishCheck,
    transformPayload,
  );

  addOnCharacteristic(service, setPayload, getState, device.topic);

  if (device.capabilities.includes("brightness")) {
    addBrightnessCharacteristic(service, setPayload, getState, device.topic);
  }

  if (device.capabilities.includes("color_temp")) {
    addColorTempCharacteristic(service, setPayload, getState, device.topic);
  }

  if (device.capabilities.includes("color_hs")) {
    addHueCharacteristic(service, setPayload, getState, device.topic);
    addSaturationCharacteristic(service, setPayload, getState, device.topic);
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
): void {
  const hue = service.getCharacteristic(Characteristic.Hue);

  hue.onGet(() => {
    const state = getState(topic);
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
): void {
  const sat = service.getCharacteristic(Characteristic.Saturation);

  sat.onGet(() => {
    const state = getState(topic);
    const color = state?.color as { saturation?: number } | undefined;
    return color?.saturation ?? 0;
  });

  sat.onSet((value) => {
    setPayload({ color: { saturation: value } });
  });
}

export function createWhiteTransform(
  getState: GetStateFn,
  topic: string,
): (payload: Record<string, unknown>) => Record<string, unknown> {
  return (payload) => {
    if ("color_temp" in payload) return payload;
    const color = payload.color;
    if (typeof color !== "object" || color === null) return payload;
    const c = color as Record<string, unknown>;
    if (c.hue !== 0 || c.saturation !== 0) return payload;

    // Only convert to color_temp if the device has reported it in state,
    // confirming it has CCT hardware. RGB-only devices never report
    // color_temp, so H=0/S=0 passes through as a normal HS write.
    const state = getState(topic);
    const ct = state?.color_temp as number | undefined;
    if (ct === undefined) return payload;

    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key !== "color") rest[key] = value;
    }
    return { ...rest, color_temp: ct };
  };
}
