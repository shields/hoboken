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
  HAPStatus,
  HapStatusError,
  Service,
  uuid,
} from "@homebridge/hap-nodejs";
import type { Capability, DeviceConfig, SceneConfig } from "./config.ts";
import { clampColorTemp, type HomeKitState } from "./convert.ts";
export type PublishFn = (
  topic: string,
  payload: Record<string, unknown>,
) => void;
export type GetStateFn = (topic: string) => HomeKitState | undefined;

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
      publish(topic, payload);
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

    pending = { ...pending, ...payload };
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

  addSimpleCharacteristic(
    service, Characteristic.On, "on", false,
    setPayload, getState, device.topic,
  );

  if (device.capabilities.includes("brightness")) {
    addSimpleCharacteristic(
      service, Characteristic.Brightness, "brightness", 0,
      setPayload, getState, device.topic,
    );
  }

  if (device.capabilities.includes("color_temp")) {
    addSimpleCharacteristic(
      service, Characteristic.ColorTemperature, "color_temp", 140,
      setPayload, getState, device.topic,
      (v) => clampColorTemp(Number(v)),
    );
  }

  if (device.capabilities.includes("color_hs")) {
    addSimpleCharacteristic(
      service, Characteristic.Hue, "hue", 0,
      setPayload, getState, device.topic,
    );
    addSimpleCharacteristic(
      service, Characteristic.Saturation, "saturation", 0,
      setPayload, getState, device.topic,
    );
  }

  return accessory;
}

export function createFanAccessory(
  device: DeviceConfig,
  publish: PublishFn,
  getState: GetStateFn,
  prePublishCheck?: () => void,
): Accessory {
  const accessory = new Accessory(
    device.name,
    uuid.generate(`hoboken:fan:${device.topic}`),
  );
  accessory.category = Categories.FAN;

  const service = accessory.addService(Service.Fanv2, device.name);
  const setPayload = createCoalescingPublish(
    device.topic,
    publish,
    prePublishCheck,
  );

  addSimpleCharacteristic(
    service, Characteristic.Active, "active", 0,
    setPayload, getState, device.topic,
  );

  if (device.capabilities.includes("fan_speed")) {
    addSimpleCharacteristic(
      service, Characteristic.RotationSpeed, "rotation_speed", 0,
      setPayload, getState, device.topic,
    );
    addSimpleCharacteristic(
      service, Characteristic.TargetFanState, "target_fan_state", 0,
      setPayload, getState, device.topic,
    );
  }

  return accessory;
}

export function updateFanAccessoryState(
  accessory: Accessory,
  state: HomeKitState,
  capabilities: Capability[],
): void {
  const service = accessory.getService(Service.Fanv2);
  if (!service) return;

  if (state.active !== undefined) {
    service.getCharacteristic(Characteristic.Active).updateValue(state.active);
  }

  if (capabilities.includes("fan_speed")) {
    if (state.rotation_speed !== undefined) {
      service
        .getCharacteristic(Characteristic.RotationSpeed)
        .updateValue(state.rotation_speed);
    }
    if (state.target_fan_state !== undefined) {
      service
        .getCharacteristic(Characteristic.TargetFanState)
        .updateValue(state.target_fan_state);
    }
  }
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
      publish(device.topic, { scene_recall: scene.id });
      setTimeout(() => {
        on.updateValue(false);
      }, 1000);
    }
  });

  return accessory;
}

export function updateAccessoryState(
  accessory: Accessory,
  state: HomeKitState,
  capabilities: Capability[],
): void {
  const service = accessory.getService(Service.Lightbulb);
  if (!service) return;

  if (state.on !== undefined) {
    service.getCharacteristic(Characteristic.On).updateValue(state.on);
  }

  if (capabilities.includes("brightness") && state.brightness !== undefined) {
    service
      .getCharacteristic(Characteristic.Brightness)
      .updateValue(state.brightness);
  }

  if (capabilities.includes("color_temp") && state.color_temp !== undefined) {
    service
      .getCharacteristic(Characteristic.ColorTemperature)
      .updateValue(clampColorTemp(state.color_temp));
  }

  if (capabilities.includes("color_hs")) {
    if (state.hue !== undefined) {
      service.getCharacteristic(Characteristic.Hue).updateValue(state.hue);
    }
    if (state.saturation !== undefined) {
      service
        .getCharacteristic(Characteristic.Saturation)
        .updateValue(state.saturation);
    }
  }
}

function addSimpleCharacteristic(
  service: Service,
  characteristicClass: { UUID: string } & (new () => Characteristic),
  key: keyof HomeKitState,
  defaultValue: boolean | number,
  setPayload: SetPayloadFn,
  getState: GetStateFn,
  topic: string,
  onGetTransform?: (value: boolean | number) => boolean | number,
): void {
  const c = service.getCharacteristic(characteristicClass);

  c.onGet(() => {
    const state = getState(topic);
    if (!state)
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    const raw = state[key] ?? defaultValue;
    return onGetTransform ? onGetTransform(raw) : raw;
  });

  c.onSet((value) => {
    setPayload({ [key]: value });
  });
}
