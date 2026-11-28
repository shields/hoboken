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
  AdaptiveLightingController,
  Categories,
  Characteristic,
  type CharacteristicChange,
  HAPStatus,
  HapStatusError,
  Service,
  uuid,
} from "@homebridge/hap-nodejs";
import {
  restoredTransition,
  type SavedSchedule,
} from "./adaptive-lighting-restore.ts";
import { hasAdaptiveLighting } from "./adaptive-lighting.ts";
import type { Capability, DeviceConfig, SceneConfig } from "./config.ts";
import {
  clampColorTemp,
  colorTempRange,
  colorTempToHueSaturation,
  FAN_SPEED_STEP,
  type HomeKitState,
  isSiriWhite,
} from "./convert.ts";
// "adaptive-lighting" is the controller's update; "adaptive-lighting-now" is
// the remembered temperature of a light that someone turned on elsewhere.
export type PublishSource = "adaptive-lighting" | "adaptive-lighting-now";
export type PublishFn = (
  topic: string,
  payload: Record<string, unknown>,
  source?: PublishSource,
) => void;
export type GetStateFn = (topic: string) => HomeKitState | undefined;
// Called with each temperature that Adaptive Lighting sets, which the callee
// may record. Returns whether to publish it.
export type AdaptiveTemperatureFn = (temperature: number) => boolean;

// What lets Siri's white turn Adaptive Lighting back on: the light's last
// schedule from the home hub, kept by accessory UUID because HAP-NodeJS erases
// its own copy whenever Adaptive Lighting goes off.
export interface AdaptiveWhite {
  load(id: string): SavedSchedule | undefined;
  save(id: string, saved: SavedSchedule): void;
  // Takes the temperature of a restored schedule, which the white's own write
  // carries, without publishing it.
  remember(temperature: number): void;
  restored(): void;
  failed(error: unknown): void;
}

type SetPayloadFn = (
  payload: Record<string, unknown>,
  source?: PublishSource,
) => void;

const adaptiveLightingControllers = new WeakMap<
  Accessory,
  AdaptiveLightingController
>();

export function adaptiveLightingController(
  accessory: Accessory,
): AdaptiveLightingController | undefined {
  return adaptiveLightingControllers.get(accessory);
}

function setByAdaptiveLighting(context: unknown): boolean {
  return (
    typeof context === "object" &&
    context !== null &&
    "controller" in context &&
    context.controller instanceof AdaptiveLightingController
  );
}

// Before it sets a temperature, HAP-NodeJS's controller sets Hue and Saturation
// from its own table, without a notification, and expects the accessory's
// update to bring the same values and so notify no one. The bridge's updates
// use the Home app's curve, so the curve's values replace the table's here,
// also without a notification.
function setCurveColor(service: Service, mireds: number): void {
  if (!service.testCharacteristic(Characteristic.Hue)) return;
  const color = colorTempToHueSaturation(mireds);
  service.getCharacteristic(Characteristic.Hue).value = Math.round(color.hue);
  service.getCharacteristic(Characteristic.Saturation).value = Math.round(
    color.saturation,
  );
}

function hasColorKey(payload: Record<string, unknown>): boolean {
  return ["hue", "saturation", "color_temp"].some((key) => key in payload);
}

function createCoalescingPublish(
  topic: string,
  publish: PublishFn,
  prePublishCheck?: () => void,
): SetPayloadFn {
  let pending: Record<string, unknown> | undefined;
  let source: PublishSource | undefined;
  let scheduled = false;
  let adaptiveTemperature = false;

  const flush = () => {
    if (!pending) return;
    const payload = pending;
    const flushedSource = source;
    pending = undefined;
    source = undefined;
    adaptiveTemperature = false;
    scheduled = false;
    try {
      if (flushedSource) publish(topic, payload, flushedSource);
      else publish(topic, payload);
    } catch (error) {
      // Connection may have dropped between the synchronous prePublishCheck
      // and this nextTick flush. The error was already thrown to HAP-NodeJS
      // synchronously; swallow the async duplicate to avoid crashing.
      if (!(error instanceof HapStatusError)) throw error;
    }
  };

  return (payload, payloadSource) => {
    // Run synchronously so HAP-NodeJS can catch errors (e.g. MQTT disconnect)
    // and report them back to HomeKit.
    prePublishCheck?.();

    // The temperature that Adaptive Lighting computes yields to a color or
    // temperature written by HomeKit in the same tick, in either order.
    if (payloadSource) {
      if (pending && !adaptiveTemperature && hasColorKey(pending)) return;
      adaptiveTemperature = true;
    } else if (adaptiveTemperature && hasColorKey(payload)) {
      pending = { ...pending };
      delete pending.color_temp;
      adaptiveTemperature = false;
    }
    // A write that shares its tick with another loses the Adaptive Lighting tag.
    source = pending ? source && payloadSource : payloadSource;
    pending = { ...pending, ...payload };
    if (scheduled) {
      return;
    }

    scheduled = true;
    process.nextTick(flush);
  };
}

export function createLightAccessory(
  device: DeviceConfig,
  publish: PublishFn,
  getState: GetStateFn,
  prePublishCheck?: () => void,
  adaptiveTemperature?: AdaptiveTemperatureFn,
  white?: AdaptiveWhite,
): Accessory {
  const accessory = new Accessory(
    device.name,
    uuid.generate(`hoboken:light:${device.topic}`),
  );
  accessory.category = Categories.LIGHTBULB;

  const service = new Service.Lightbulb(device.name);
  accessory.addService(service);
  let controller: AdaptiveLightingController | undefined;
  let saved = white?.load(accessory.UUID);
  let restoring = false;
  const armed = new Set<Characteristic>();

  const save = (next: SavedSchedule) => {
    saved = next;
    try {
      white?.save(accessory.UUID, next);
    } catch (error) {
      white?.failed(error);
    }
  };

  const restore = (schedule: SavedSchedule) => {
    const transition = restoredTransition(schedule.schedule, Date.now());
    if (!transition) return;
    restoring = true;
    // The controller takes the schedule before the first await.
    void (async () => {
      try {
        await service
          .getCharacteristic(
            Characteristic.CharacteristicValueTransitionControl,
          )
          .handleSetRequest(transition);
      } catch (error) {
        white?.failed(error);
      }
    })();
    restoring = false;
    const active = controller?.serialize()?.activeTransition;
    if (!active) return;
    save({ ...schedule, restored: active.transitionStartBuffer });
    white?.restored();
  };

  // HAP-NodeJS turns Adaptive Lighting off for any HomeKit write of Hue or
  // Saturation, after the write is published. Siri's white goes out as
  // Adaptive Lighting's temperature, so its changes count as the controller's.
  const keepAdaptiveLighting = () => {
    if (!controller) return;
    if (!controller.isAdaptiveLightingActive() && saved) restore(saved);
    armed.add(service.getCharacteristic(Characteristic.Hue));
    armed.add(service.getCharacteristic(Characteristic.Saturation));
  };

  const setPayload = createCoalescingPublish(
    device.topic,
    (topic, payload, source) => {
      // HAP-NodeJS emits a write's change after the flush that publishes it, so
      // a temperature that Adaptive Lighting recomputes for a Brightness write
      // is flushed after the same request's color or temperature has turned
      // Adaptive Lighting off.
      if (source && controller?.isAdaptiveLightingActive() !== true) return;
      if (white && isSiriWhite(payload)) keepAdaptiveLighting();
      if (source) publish(topic, payload, source);
      else publish(topic, payload);
    },
    prePublishCheck,
  );

  const onAdaptiveTemperature =
    adaptiveTemperature &&
    ((temperature: number) => {
      if (restoring && white) {
        white.remember(temperature);
        return false;
      }
      const accepted = adaptiveTemperature(temperature);
      const active = controller?.serialize()?.activeTransition;
      if (
        white &&
        active &&
        active.transitionStartBuffer !== saved?.restored &&
        (active.transitionId !== saved?.schedule.transitionId ||
          active.transitionStartBuffer !== saved.schedule.transitionStartBuffer)
      )
        save({ schedule: active });
      return accepted;
    });

  addSimpleCharacteristic(
    service,
    Characteristic.On,
    "on",
    setPayload,
    getState,
    device.topic,
  );

  if (device.capabilities.includes("brightness")) {
    addSimpleCharacteristic(
      service,
      Characteristic.Brightness,
      "brightness",
      setPayload,
      getState,
      device.topic,
    );
  }

  if (device.capabilities.includes("color_temp")) {
    const [minValue, maxValue] = colorTempRange(device);
    const colorTemperature = addSimpleCharacteristic(
      service,
      Characteristic.ColorTemperature,
      "color_temp",
      setPayload,
      getState,
      device.topic,
      (v) => clampColorTemp(Number(v)),
      onAdaptiveTemperature,
    );
    // HAP-NodeJS warns when a new range excludes the value that is there.
    colorTemperature.updateValue(minValue);
    colorTemperature.setProps({ minValue, maxValue });
  }

  if (device.capabilities.includes("color_hs")) {
    addSimpleCharacteristic(
      service,
      Characteristic.Hue,
      "hue",
      setPayload,
      getState,
      device.topic,
    );
    addSimpleCharacteristic(
      service,
      Characteristic.Saturation,
      "saturation",
      setPayload,
      getState,
      device.topic,
    );
  }

  if (hasAdaptiveLighting(device)) {
    // Ahead of the controller's listeners, which it adds each time Adaptive
    // Lighting goes on.
    for (const type of [Characteristic.Hue, Characteristic.Saturation]) {
      if (!service.testCharacteristic(type)) continue;
      const characteristic = service.getCharacteristic(type);
      characteristic.on("change", (change: CharacteristicChange) => {
        if (armed.delete(characteristic)) change.context = { controller };
      });
    }
    controller = new AdaptiveLightingController(service);
    // HAP-NodeJS restores a persisted transition when the bridge publishes, so
    // the controller joins the accessory before that.
    accessory.configureController(controller);
    adaptiveLightingControllers.set(accessory, controller);
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
    service,
    Characteristic.Active,
    "active",
    setPayload,
    getState,
    device.topic,
  );

  if (device.capabilities.includes("fan_speed")) {
    addSimpleCharacteristic(
      service,
      Characteristic.RotationSpeed,
      "rotation_speed",
      setPayload,
      getState,
      device.topic,
    ).setProps({ minValue: 0, maxValue: 100, minStep: FAN_SPEED_STEP });
    addSimpleCharacteristic(
      service,
      Characteristic.TargetFanState,
      "target_fan_state",
      setPayload,
      getState,
      device.topic,
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

  if (
    capabilities.includes("fan_speed") &&
    state.rotation_speed !== undefined
  ) {
    service
      .getCharacteristic(Characteristic.RotationSpeed)
      .updateValue(state.rotation_speed);
  }

  if (
    capabilities.includes("fan_speed") &&
    state.target_fan_state !== undefined
  ) {
    service
      .getCharacteristic(Characteristic.TargetFanState)
      .updateValue(state.target_fan_state);
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

  // Momentary switch: each recall publishes, then auto-resets to off after 1s.
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  on.onSet((value) => {
    if (!value) {
      return;
    }

    publish(device.topic, { scene_recall: scene.id });
    // A reset cannot keep the process alive or outlive a later scene recall.
    if (resetTimer !== undefined) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      resetTimer = undefined;
      on.updateValue(false);
    }, 1000);
    resetTimer.unref();
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

  if (capabilities.includes("color_hs") && state.hue !== undefined) {
    service.getCharacteristic(Characteristic.Hue).updateValue(state.hue);
  }

  if (capabilities.includes("color_hs") && state.saturation !== undefined) {
    service
      .getCharacteristic(Characteristic.Saturation)
      .updateValue(state.saturation);
  }

  // After Hue and Saturation: Home Assistant's HomeKit bridge reports that iOS
  // otherwise shows the wrong color.
  if (capabilities.includes("color_temp") && state.color_temp !== undefined) {
    service
      .getCharacteristic(Characteristic.ColorTemperature)
      .updateValue(clampColorTemp(state.color_temp));
  }
}

function addSimpleCharacteristic(
  service: Service,
  characteristicClass: { UUID: string } & (new () => Characteristic),
  key: keyof HomeKitState,
  setPayload: SetPayloadFn,
  getState: GetStateFn,
  topic: string,
  onGetTransform?: (value: boolean | number) => boolean | number,
  adaptiveTemperature?: AdaptiveTemperatureFn,
): Characteristic {
  const c = service.getCharacteristic(characteristicClass);

  c.onGet(() => {
    const state = getState(topic);
    if (!state)
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    // The state lacks a field that the device does not report or that belongs
    // to the color mode that is not active; the last value stands.
    const raw = state[key] ?? (c.value as boolean | number);
    return onGetTransform ? onGetTransform(raw) : raw;
  });

  c.onSet((value, context) => {
    if (adaptiveTemperature && setByAdaptiveLighting(context)) {
      setCurveColor(service, value as number);
      if (adaptiveTemperature(value as number))
        setPayload({ [key]: value }, "adaptive-lighting");
      return;
    }
    setPayload({ [key]: value });
  });

  return c;
}
