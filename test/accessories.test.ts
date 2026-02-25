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

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Characteristic, HAPStatus, Service } from "@homebridge/hap-nodejs";
import type { DeviceConfig } from "../src/config.ts";
import {
  createLightAccessory,
  createSceneAccessory,
  updateAccessoryState,
} from "../src/accessories.ts";
import type { GetStateFn, PublishFn } from "../src/accessories.ts";
import type { HomeKitState } from "../src/convert.ts";

function makeDevice(overrides?: Partial<DeviceConfig>): DeviceConfig {
  return {
    name: "Test Light",
    type: "z2m",
    topic: "test_light",
    capabilities: ["on_off", "brightness", "color_hs"],
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    process.nextTick(resolve);
  });
}

describe("createLightAccessory", () => {
  let publish: ReturnType<typeof mock<PublishFn>>;
  let stateMap: Map<string, HomeKitState>;
  let getState: GetStateFn;

  beforeEach(() => {
    publish = mock<PublishFn>();
    stateMap = new Map();
    getState = (topic) => stateMap.get(topic);
  });

  test("creates accessory with on_off only", () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, publish, getState);
    const service = accessory.getService(Service.Lightbulb)!;

    expect(service).toBeDefined();
    expect(service.getCharacteristic(Characteristic.On)).toBeDefined();
    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(false);
    expect(service.testCharacteristic(Characteristic.ColorTemperature)).toBe(
      false,
    );
    expect(service.testCharacteristic(Characteristic.Hue)).toBe(false);
    expect(service.testCharacteristic(Characteristic.Saturation)).toBe(false);
  });

  test("creates accessory with color_hs capabilities", () => {
    const device = makeDevice();
    const accessory = createLightAccessory(device, publish, getState);
    const service = accessory.getService(Service.Lightbulb)!;

    expect(service.getCharacteristic(Characteristic.On)).toBeDefined();
    expect(service.getCharacteristic(Characteristic.Brightness)).toBeDefined();
    expect(service.testCharacteristic(Characteristic.ColorTemperature)).toBe(
      false,
    );
    expect(service.getCharacteristic(Characteristic.Hue)).toBeDefined();
    expect(service.getCharacteristic(Characteristic.Saturation)).toBeDefined();
  });

  test("creates accessory with color_temp capabilities", () => {
    const device = makeDevice({
      capabilities: ["on_off", "brightness", "color_temp"],
    });
    const accessory = createLightAccessory(device, publish, getState);
    const service = accessory.getService(Service.Lightbulb)!;

    expect(service.getCharacteristic(Characteristic.On)).toBeDefined();
    expect(service.getCharacteristic(Characteristic.Brightness)).toBeDefined();
    expect(
      service.getCharacteristic(Characteristic.ColorTemperature),
    ).toBeDefined();
    expect(service.testCharacteristic(Characteristic.Hue)).toBe(false);
    expect(service.testCharacteristic(Characteristic.Saturation)).toBe(false);
  });

  test("onGet On returns cached state", async () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, publish, getState);
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    stateMap.set("test_light", { on: true });
    const value = await on.handleGetRequest();
    expect(value).toBe(true);

    stateMap.set("test_light", { on: false });
    const value2 = await on.handleGetRequest();
    expect(value2).toBe(false);
  });

  test("onGet On throws SERVICE_COMMUNICATION_FAILURE when no state cached", async () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, publish, getState);
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    await on.handleGetRequest().catch(() => { /* expected */ });
    expect(on.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  test("onSet On publishes HK-native boolean", async () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, publish, getState);
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    on.setValue(true);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_light", { on: true });

    on.setValue(false);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_light", { on: false });
  });

  test("onGet brightness returns cached value", async () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);
    const brightness = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Brightness);

    stateMap.set("test_light", { brightness: 100 });
    const value = await brightness.handleGetRequest();
    expect(value).toBe(100);
  });

  test("onGet brightness throws SERVICE_COMMUNICATION_FAILURE when no state cached", async () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);
    const brightness = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Brightness);

    await brightness.handleGetRequest().catch(() => { /* expected */ });
    expect(brightness.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  test("onGet color_temp returns cached value", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_temp"] });
    const accessory = createLightAccessory(device, publish, getState);
    const ct = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.ColorTemperature);

    stateMap.set("test_light", { color_temp: 350 });
    const value = await ct.handleGetRequest();
    expect(value).toBe(350);
  });

  test("onGet color_temp clamps out-of-range cached value", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_temp"] });
    const accessory = createLightAccessory(device, publish, getState);
    const ct = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.ColorTemperature);

    stateMap.set("test_light", { color_temp: 50 });
    expect(await ct.handleGetRequest()).toBe(140);

    stateMap.set("test_light", { color_temp: 600 });
    expect(await ct.handleGetRequest()).toBe(500);
  });

  test("onGet color_temp throws SERVICE_COMMUNICATION_FAILURE when no state cached", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_temp"] });
    const accessory = createLightAccessory(device, publish, getState);
    const ct = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.ColorTemperature);

    await ct.handleGetRequest().catch(() => { /* expected */ });
    expect(ct.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  test("onGet hue returns cached value", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const hue = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Hue);

    stateMap.set("test_light", { hue: 200 });
    const value = await hue.handleGetRequest();
    expect(value).toBe(200);
  });

  test("onGet hue throws SERVICE_COMMUNICATION_FAILURE when no state cached", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const hue = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Hue);

    await hue.handleGetRequest().catch(() => { /* expected */ });
    expect(hue.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  test("onGet saturation returns cached value", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const sat = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Saturation);

    stateMap.set("test_light", { saturation: 75 });
    const value = await sat.handleGetRequest();
    expect(value).toBe(75);
  });

  test("onGet saturation throws SERVICE_COMMUNICATION_FAILURE when no state cached", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const sat = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Saturation);

    await sat.handleGetRequest().catch(() => { /* expected */ });
    expect(sat.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  test("onSet brightness publishes HK-native value", async () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);
    const brightness = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Brightness);

    brightness.setValue(50);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_light", { brightness: 50 });

    brightness.setValue(100);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_light", { brightness: 100 });
  });

  test("onSet color_temp publishes mireds directly", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_temp"] });
    const accessory = createLightAccessory(device, publish, getState);
    const ct = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.ColorTemperature);

    ct.setValue(250);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_light", { color_temp: 250 });
  });

  test("onSet hue publishes top-level hue", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const hue = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Hue);

    hue.setValue(180);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_light", { hue: 180 });
  });

  test("onSet saturation publishes top-level saturation", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const sat = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Saturation);

    sat.setValue(75);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_light", { saturation: 75 });
  });
});

describe("write coalescing", () => {
  let publish: ReturnType<typeof mock<PublishFn>>;
  let stateMap: Map<string, HomeKitState>;
  let getState: GetStateFn;

  beforeEach(() => {
    publish = mock<PublishFn>();
    stateMap = new Map();
    getState = (topic) => stateMap.get(topic);
  });

  test("coalesces hue + saturation into single publish", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.Hue).setValue(120);
    service.getCharacteristic(Characteristic.Saturation).setValue(100);

    expect(publish).not.toHaveBeenCalled();
    await flush();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("test_light", {
      hue: 120,
      saturation: 100,
    });
  });

  test("coalesces brightness + on into single publish", async () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.On).setValue(true);
    service.getCharacteristic(Characteristic.Brightness).setValue(80);

    await flush();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("test_light", {
      on: true,
      brightness: 80,
    });
  });

  test("publishes after nextTick when only hue arrives", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);

    accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Hue)
      .setValue(200);

    expect(publish).not.toHaveBeenCalled();
    await flush();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("test_light", { hue: 200 });
  });

  test("merges hue and saturation as top-level keys", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.Hue).setValue(120);
    service.getCharacteristic(Characteristic.Saturation).setValue(100);
    await flush();

    const call = publish.mock.calls[0]!;
    expect(call[1]).toEqual({ hue: 120, saturation: 100 });
  });

  test("shallow-merges non-color keys (last write wins)", async () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.On).setValue(true);
    service.getCharacteristic(Characteristic.On).setValue(false);
    await flush();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("test_light", { on: false });
  });

  test("independent coalescing per accessory", async () => {
    const device1 = makeDevice({
      name: "Light 1",
      topic: "light_1",
      capabilities: ["on_off"],
    });
    const device2 = makeDevice({
      name: "Light 2",
      topic: "light_2",
      capabilities: ["on_off"],
    });
    const a1 = createLightAccessory(device1, publish, getState);
    const a2 = createLightAccessory(device2, publish, getState);

    a1.getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On)
      .setValue(true);
    a2.getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On)
      .setValue(false);

    await flush();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith("light_1", { on: true });
    expect(publish).toHaveBeenCalledWith("light_2", { on: false });
  });

  test("flush swallows publish errors without crashing", async () => {
    let shouldThrow = false;
    const throwingPublish: PublishFn = () => {
      if (shouldThrow) throw new Error("disconnected");
    };
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, throwingPublish, getState);

    accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On)
      .setValue(true);

    // Connection drops after setPayload buffers but before nextTick flush
    shouldThrow = true;
    await flush();
    // Should not throw — flush catches the error
  });
});

describe("createSceneAccessory", () => {
  test("publishes scene_recall on set true", () => {
    const publish = mock<PublishFn>();
    const device = makeDevice();
    const scene = { name: "Movie Mode", id: 1 };
    const accessory = createSceneAccessory(device, scene, publish);
    const on = accessory
      .getService(Service.Switch)!
      .getCharacteristic(Characteristic.On);

    on.setValue(true);
    expect(publish).toHaveBeenCalledWith("test_light", { scene_recall: 1 });
  });

  test("onGet always returns false", async () => {
    const publish = mock<PublishFn>();
    const device = makeDevice();
    const scene = { name: "Movie Mode", id: 1 };
    const accessory = createSceneAccessory(device, scene, publish);
    const on = accessory
      .getService(Service.Switch)!
      .getCharacteristic(Characteristic.On);

    const value = await on.handleGetRequest();
    expect(value).toBe(false);
  });

  test("auto-resets to off after timeout", () => {
    const publish = mock<PublishFn>();
    const device = makeDevice();
    const scene = { name: "Movie Mode", id: 2 };
    const accessory = createSceneAccessory(device, scene, publish);
    const on = accessory
      .getService(Service.Switch)!
      .getCharacteristic(Characteristic.On);

    const origSetTimeout = globalThis.setTimeout;
    const timeouts: { fn: () => void; delay: number }[] = [];
    globalThis.setTimeout = ((fn: () => void, delay: number) => {
      timeouts.push({ fn, delay });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      on.setValue(true);
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]!.delay).toBe(1000);

      timeouts[0]!.fn();
      expect(on.value).toBe(false);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});

describe("updateAccessoryState", () => {
  let publish: ReturnType<typeof mock<PublishFn>>;
  let getState: GetStateFn;

  beforeEach(() => {
    publish = mock<PublishFn>();
    getState = (): HomeKitState | undefined => {
      return;
    };
  });

  test("updates On characteristic from state", () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, publish, getState);

    updateAccessoryState(accessory, { on: true }, ["on_off"]);
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);
    expect(on.value).toBe(true);

    updateAccessoryState(accessory, { on: false }, ["on_off"]);
    expect(on.value).toBe(false);
  });

  test("updates brightness directly (HK-native)", () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);

    updateAccessoryState(accessory, { brightness: 100 }, [
      "on_off",
      "brightness",
    ]);
    const b = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Brightness);
    expect(b.value).toBe(100);

    updateAccessoryState(accessory, { brightness: 50 }, [
      "on_off",
      "brightness",
    ]);
    expect(b.value).toBe(50);
  });

  test("updates color_temp as mireds", () => {
    const device = makeDevice({ capabilities: ["on_off", "color_temp"] });
    const accessory = createLightAccessory(device, publish, getState);

    updateAccessoryState(accessory, { color_temp: 350 }, [
      "on_off",
      "color_temp",
    ]);
    const ct = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.ColorTemperature);
    expect(ct.value).toBe(350);
  });

  test("clamps out-of-range color_temp to HAP limits", () => {
    const device = makeDevice({ capabilities: ["on_off", "color_temp"] });
    const accessory = createLightAccessory(device, publish, getState);
    const ct = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.ColorTemperature);

    updateAccessoryState(accessory, { color_temp: 50 }, [
      "on_off",
      "color_temp",
    ]);
    expect(ct.value).toBe(140);

    updateAccessoryState(accessory, { color_temp: 600 }, [
      "on_off",
      "color_temp",
    ]);
    expect(ct.value).toBe(500);
  });

  test("updates hue and saturation as top-level keys", () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);

    updateAccessoryState(accessory, { hue: 200, saturation: 80 }, [
      "on_off",
      "color_hs",
    ]);
    const hue = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Hue);
    const sat = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Saturation);
    expect(hue.value).toBe(200);
    expect(sat.value).toBe(80);
  });

  test("skips characteristics not in capabilities", () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, publish, getState);

    // Should not throw even with brightness data when capability not declared
    updateAccessoryState(accessory, { on: true, brightness: 100 }, [
      "on_off",
    ]);
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);
    expect(on.value).toBe(true);
  });

  test("ignores non-lightbulb accessory", () => {
    const publish2 = mock<PublishFn>();
    const device = makeDevice();
    const scene = { name: "Test", id: 1 };
    const accessory = createSceneAccessory(device, scene, publish2);

    // Should not throw — just returns early
    updateAccessoryState(accessory, { on: true }, ["on_off"]);
  });
});
