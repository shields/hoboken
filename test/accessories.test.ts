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
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Characteristic, HAPStatus, Service } from "@homebridge/hap-nodejs";
import type { DeviceConfig } from "../src/config.ts";
import {
  createFanAccessory,
  createLightAccessory,
  createSceneAccessory,
  updateAccessoryState,
  updateFanAccessoryState,
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

    expect(await Promise.allSettled([on.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
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

    expect(await Promise.allSettled([brightness.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
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

    expect(await Promise.allSettled([ct.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
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

    expect(await Promise.allSettled([hue.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
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

    expect(await Promise.allSettled([sat.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
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
  test("setting false does not recall a scene or schedule a reset", async () => {
    const publish = mock<PublishFn>();
    const accessory = createSceneAccessory(
      makeDevice(),
      { name: "Movie Mode", id: 1 },
      publish,
    );
    const on = accessory
      .getService(Service.Switch)!
      .getCharacteristic(Characteristic.On);

    jest.useFakeTimers();
    try {
      await on.handleSetRequest(false);
      expect(publish).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      expect(on.value).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

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

  test("auto-resets to off after timeout and unrefs the timer", async () => {
    const publish = mock<PublishFn>();
    const device = makeDevice();
    const scene = { name: "Movie Mode", id: 2 };
    const accessory = createSceneAccessory(device, scene, publish);
    const on = accessory
      .getService(Service.Switch)!
      .getCharacteristic(Characteristic.On);

    jest.useFakeTimers();
    const timeouts = spyOn(globalThis, "setTimeout");
    try {
      await on.handleSetRequest(true);
      expect(jest.getTimerCount()).toBe(1);
      expect(timeouts.mock.calls[0]![1]).toBe(1000);
      const timer = timeouts.mock.results[0]!.value as ReturnType<
        typeof setTimeout
      >;
      expect(timer.hasRef()).toBe(false);
      jest.advanceTimersByTime(999);
      expect(on.value).toBe(true);
      jest.advanceTimersByTime(1);
      expect(on.value).toBe(false);
    } finally {
      timeouts.mockRestore();
      jest.useRealTimers();
    }
  });

  test("a rapid re-tap clears the prior reset timer", async () => {
    const publish = mock<PublishFn>();
    const device = makeDevice();
    const scene = { name: "Movie Mode", id: 3 };
    const accessory = createSceneAccessory(device, scene, publish);
    const on = accessory
      .getService(Service.Switch)!
      .getCharacteristic(Characteristic.On);

    jest.useFakeTimers();
    try {
      await on.handleSetRequest(true);
      jest.advanceTimersByTime(500);
      await on.handleSetRequest(true);
      expect(jest.getTimerCount()).toBe(1);
      expect(publish).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(500);
      expect(on.value).toBe(true);
      jest.advanceTimersByTime(500);
      expect(on.value).toBe(false);
    } finally {
      jest.useRealTimers();
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

    updateAccessoryState(
      accessory,
      {
        on: true,
        brightness: 100,
        color_temp: 350,
        hue: 200,
        saturation: 80,
      },
      ["on_off"],
    );
    const service = accessory.getService(Service.Lightbulb)!;
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true);
    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(false);
    expect(service.testCharacteristic(Characteristic.ColorTemperature)).toBe(
      false,
    );
    expect(service.testCharacteristic(Characteristic.Hue)).toBe(false);
    expect(service.testCharacteristic(Characteristic.Saturation)).toBe(false);
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

function makeFanDevice(overrides?: Partial<DeviceConfig>): DeviceConfig {
  return {
    name: "Test Fan",
    type: "z2m",
    topic: "test_fan",
    capabilities: ["fan", "fan_speed"],
    ...overrides,
  };
}

describe("createFanAccessory", () => {
  let publish: ReturnType<typeof mock<PublishFn>>;
  let stateMap: Map<string, HomeKitState>;
  let getState: GetStateFn;

  beforeEach(() => {
    publish = mock<PublishFn>();
    stateMap = new Map();
    getState = (topic) => stateMap.get(topic);
  });

  test("creates accessory with fan only", () => {
    const device = makeFanDevice({ capabilities: ["fan"] });
    const accessory = createFanAccessory(device, publish, getState);
    const service = accessory.getService(Service.Fanv2)!;

    expect(service).toBeDefined();
    expect(service.getCharacteristic(Characteristic.Active)).toBeDefined();
    expect(service.testCharacteristic(Characteristic.RotationSpeed)).toBe(
      false,
    );
    expect(service.testCharacteristic(Characteristic.TargetFanState)).toBe(
      false,
    );
  });

  test("creates accessory with fan + fan_speed", () => {
    const device = makeFanDevice();
    const accessory = createFanAccessory(device, publish, getState);
    const service = accessory.getService(Service.Fanv2)!;

    expect(service.getCharacteristic(Characteristic.Active)).toBeDefined();
    expect(
      service.getCharacteristic(Characteristic.RotationSpeed),
    ).toBeDefined();
    expect(
      service.getCharacteristic(Characteristic.TargetFanState),
    ).toBeDefined();
  });

  test("onGet Active returns cached state", async () => {
    const device = makeFanDevice({ capabilities: ["fan"] });
    const accessory = createFanAccessory(device, publish, getState);
    const active = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.Active);

    stateMap.set("test_fan", { active: 1 });
    expect(await active.handleGetRequest()).toBe(1);

    stateMap.set("test_fan", { active: 0 });
    expect(await active.handleGetRequest()).toBe(0);
  });

  test("onGet Active throws SERVICE_COMMUNICATION_FAILURE when no state cached", async () => {
    const device = makeFanDevice({ capabilities: ["fan"] });
    const accessory = createFanAccessory(device, publish, getState);
    const active = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.Active);

    expect(await Promise.allSettled([active.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
    expect(active.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  test("onSet Active publishes active value", async () => {
    const device = makeFanDevice({ capabilities: ["fan"] });
    const accessory = createFanAccessory(device, publish, getState);
    const active = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.Active);

    active.setValue(1);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_fan", { active: 1 });
  });

  test("onGet RotationSpeed returns cached value", async () => {
    const device = makeFanDevice();
    const accessory = createFanAccessory(device, publish, getState);
    const speed = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.RotationSpeed);

    stateMap.set("test_fan", { rotation_speed: 67 });
    expect(await speed.handleGetRequest()).toBe(67);
  });

  test("onGet RotationSpeed throws SERVICE_COMMUNICATION_FAILURE when no state", async () => {
    const device = makeFanDevice();
    const accessory = createFanAccessory(device, publish, getState);
    const speed = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.RotationSpeed);

    expect(await Promise.allSettled([speed.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
    expect(speed.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  test("onSet RotationSpeed publishes rotation_speed value", async () => {
    const device = makeFanDevice();
    const accessory = createFanAccessory(device, publish, getState);
    const speed = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.RotationSpeed);

    speed.setValue(50);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_fan", { rotation_speed: 50 });
  });

  test("onGet TargetFanState returns cached value", async () => {
    const device = makeFanDevice();
    const accessory = createFanAccessory(device, publish, getState);
    const target = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.TargetFanState);

    stateMap.set("test_fan", { target_fan_state: 1 });
    expect(await target.handleGetRequest()).toBe(1);
  });

  test("onGet TargetFanState throws SERVICE_COMMUNICATION_FAILURE when no state", async () => {
    const device = makeFanDevice();
    const accessory = createFanAccessory(device, publish, getState);
    const target = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.TargetFanState);

    expect(await Promise.allSettled([target.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
    expect(target.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  });

  test("onSet TargetFanState publishes target_fan_state value", async () => {
    const device = makeFanDevice();
    const accessory = createFanAccessory(device, publish, getState);
    const target = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.TargetFanState);

    target.setValue(1);
    await flush();
    expect(publish).toHaveBeenCalledWith("test_fan", { target_fan_state: 1 });
  });

  test("coalesces active + rotation_speed into single publish", async () => {
    const device = makeFanDevice();
    const accessory = createFanAccessory(device, publish, getState);
    const service = accessory.getService(Service.Fanv2)!;

    service.getCharacteristic(Characteristic.Active).setValue(1);
    service.getCharacteristic(Characteristic.RotationSpeed).setValue(67);

    expect(publish).not.toHaveBeenCalled();
    await flush();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("test_fan", {
      active: 1,
      rotation_speed: 67,
    });
  });
});

describe("updateFanAccessoryState", () => {
  let publish: ReturnType<typeof mock<PublishFn>>;
  let getState: GetStateFn;

  beforeEach(() => {
    publish = mock<PublishFn>();
    getState = (): HomeKitState | undefined => {
      return;
    };
  });

  test("updates Active characteristic", () => {
    const device = makeFanDevice({ capabilities: ["fan"] });
    const accessory = createFanAccessory(device, publish, getState);

    updateFanAccessoryState(accessory, { active: 1 }, ["fan"]);
    const active = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.Active);
    expect(active.value).toBe(1);

    updateFanAccessoryState(accessory, { active: 0 }, ["fan"]);
    expect(active.value).toBe(0);
  });

  test("updates RotationSpeed and TargetFanState", () => {
    const device = makeFanDevice();
    const accessory = createFanAccessory(device, publish, getState);

    updateFanAccessoryState(
      accessory,
      { rotation_speed: 67, target_fan_state: 0 },
      ["fan", "fan_speed"],
    );
    const speed = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.RotationSpeed);
    const target = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.TargetFanState);
    expect(speed.value).toBe(67);
    expect(target.value).toBe(0);
  });

  test("skips RotationSpeed/TargetFanState when fan_speed not in capabilities", () => {
    const device = makeFanDevice({ capabilities: ["fan"] });
    const accessory = createFanAccessory(device, publish, getState);

    updateFanAccessoryState(
      accessory,
      { active: 1, rotation_speed: 67, target_fan_state: 1 },
      ["fan"],
    );
    const service = accessory.getService(Service.Fanv2)!;
    expect(service.getCharacteristic(Characteristic.Active).value).toBe(1);
    expect(service.testCharacteristic(Characteristic.RotationSpeed)).toBe(
      false,
    );
    expect(service.testCharacteristic(Characteristic.TargetFanState)).toBe(
      false,
    );
  });

  test("ignores non-Fanv2 accessory", () => {
    const device = makeDevice();
    const accessory = createLightAccessory(device, publish, getState);

    // Should not throw — just returns early
    updateFanAccessoryState(accessory, { active: 1 }, ["fan"]);
  });
});
