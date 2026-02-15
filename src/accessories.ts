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

export function createLightAccessory(
  device: DeviceConfig,
  publish: PublishFn,
  getState: GetStateFn,
): Accessory {
  const accessory = new Accessory(
    device.name,
    uuid.generate(`hoboken:light:${device.topic}`),
  );
  accessory.category = Categories.LIGHTBULB;

  const service = accessory.addService(Service.Lightbulb, device.name);

  addOnCharacteristic(service, device.topic, publish, getState);

  if (device.capabilities.includes("brightness")) {
    addBrightnessCharacteristic(service, device.topic, publish, getState);
  }

  if (device.capabilities.includes("color_temp")) {
    addColorTempCharacteristic(service, device.topic, publish, getState);
  }

  if (device.capabilities.includes("color_hs")) {
    addHueCharacteristic(service, device.topic, publish, getState);
    addSaturationCharacteristic(service, device.topic, publish, getState);
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
    // Z2M devices can report color_temp values outside the HAP-valid range
    // (140–500 mireds). Without clamping, hap-nodejs logs characteristic
    // warnings and HomeKit may reject the value.
    service
      .getCharacteristic(Characteristic.ColorTemperature)
      .updateValue(clampColorTemp(state.color_temp as number));
  }

  if (capabilities.includes("color_hs") && "color" in state) {
    const color = state.color as { hue?: number; saturation?: number } | null;
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
  topic: string,
  publish: PublishFn,
  getState: GetStateFn,
): void {
  const on = service.getCharacteristic(Characteristic.On);

  on.onGet(() => {
    const state = getState(topic);
    return state?.state === "ON";
  });

  on.onSet((value) => {
    publish(`${topic}/set`, { state: value ? "ON" : "OFF" });
  });
}

function addBrightnessCharacteristic(
  service: Service,
  topic: string,
  publish: PublishFn,
  getState: GetStateFn,
): void {
  const brightness = service.getCharacteristic(Characteristic.Brightness);

  brightness.onGet(() => {
    const state = getState(topic);
    if (state?.brightness === undefined) return 0;
    return z2mBrightnessToHomeKit(state.brightness as number);
  });

  brightness.onSet((value) => {
    publish(`${topic}/set`, {
      brightness: homeKitBrightnessToZ2M(value as number),
    });
  });
}

function addColorTempCharacteristic(
  service: Service,
  topic: string,
  publish: PublishFn,
  getState: GetStateFn,
): void {
  const ct = service.getCharacteristic(Characteristic.ColorTemperature);

  ct.onGet(() => {
    const state = getState(topic);
    // Clamp to HAP-valid range (140–500 mireds) — Z2M devices may report
    // out-of-range values that cause characteristic warnings.
    return clampColorTemp((state?.color_temp as number | undefined) ?? 140);
  });

  ct.onSet((value) => {
    publish(`${topic}/set`, { color_temp: value });
  });
}

function addHueCharacteristic(
  service: Service,
  topic: string,
  publish: PublishFn,
  getState: GetStateFn,
): void {
  const hue = service.getCharacteristic(Characteristic.Hue);

  hue.onGet(() => {
    const state = getState(topic);
    const color = state?.color as { hue?: number } | undefined;
    return color?.hue ?? 0;
  });

  hue.onSet((value) => {
    publish(`${topic}/set`, { color: { hue: value } });
  });
}

function addSaturationCharacteristic(
  service: Service,
  topic: string,
  publish: PublishFn,
  getState: GetStateFn,
): void {
  const sat = service.getCharacteristic(Characteristic.Saturation);

  sat.onGet(() => {
    const state = getState(topic);
    const color = state?.color as { saturation?: number } | undefined;
    return color?.saturation ?? 0;
  });

  sat.onSet((value) => {
    publish(`${topic}/set`, { color: { saturation: value } });
  });
}
