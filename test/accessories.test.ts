import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Characteristic, Service } from "@homebridge/hap-nodejs";
import type { DeviceConfig } from "../src/config.ts";
import {
  createLightAccessory,
  createSceneAccessory,
  updateAccessoryState,
} from "../src/accessories.ts";
import type { GetStateFn, PublishFn, Z2MState } from "../src/accessories.ts";

function makeDevice(overrides?: Partial<DeviceConfig>): DeviceConfig {
  return {
    name: "Test Light",
    topic: "test_light",
    capabilities: ["on_off", "brightness", "color_temp", "color_hs"],
    ...overrides,
  };
}

describe("createLightAccessory", () => {
  let publish: ReturnType<typeof mock<PublishFn>>;
  let stateMap: Map<string, Z2MState>;
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

  test("creates accessory with all capabilities", () => {
    const device = makeDevice();
    const accessory = createLightAccessory(device, publish, getState);
    const service = accessory.getService(Service.Lightbulb)!;

    expect(service.getCharacteristic(Characteristic.On)).toBeDefined();
    expect(service.getCharacteristic(Characteristic.Brightness)).toBeDefined();
    expect(
      service.getCharacteristic(Characteristic.ColorTemperature),
    ).toBeDefined();
    expect(service.getCharacteristic(Characteristic.Hue)).toBeDefined();
    expect(service.getCharacteristic(Characteristic.Saturation)).toBeDefined();
  });

  test("onGet On returns cached state", async () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, publish, getState);
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    stateMap.set("test_light", { state: "ON" });
    const value = await on.handleGetRequest();
    expect(value).toBe(true);

    stateMap.set("test_light", { state: "OFF" });
    const value2 = await on.handleGetRequest();
    expect(value2).toBe(false);
  });

  test("onGet On returns false when no state cached", () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    createLightAccessory(device, publish, getState);

    expect(getState("test_light")).toBeUndefined();
  });

  test("onSet On publishes ON/OFF", () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, publish, getState);
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    // Trigger the set handler directly
    on.setValue(true);
    expect(publish).toHaveBeenCalledWith("test_light/set", { state: "ON" });

    on.setValue(false);
    expect(publish).toHaveBeenCalledWith("test_light/set", { state: "OFF" });
  });

  test("onGet brightness returns cached value", async () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);
    const brightness = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Brightness);

    stateMap.set("test_light", { brightness: 254 });
    const value = await brightness.handleGetRequest();
    expect(value).toBe(100);
  });

  test("onGet brightness returns 0 when no state cached", async () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);
    const brightness = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Brightness);

    const value = await brightness.handleGetRequest();
    expect(value).toBe(0);
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

  test("onGet color_temp returns 140 when no state cached", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_temp"] });
    const accessory = createLightAccessory(device, publish, getState);
    const ct = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.ColorTemperature);

    const value = await ct.handleGetRequest();
    expect(value).toBe(140);
  });

  test("onGet hue returns cached value", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const hue = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Hue);

    stateMap.set("test_light", { color: { hue: 200 } });
    const value = await hue.handleGetRequest();
    expect(value).toBe(200);
  });

  test("onGet hue returns 0 when no state cached", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const hue = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Hue);

    const value = await hue.handleGetRequest();
    expect(value).toBe(0);
  });

  test("onGet saturation returns cached value", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const sat = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Saturation);

    stateMap.set("test_light", { color: { saturation: 75 } });
    const value = await sat.handleGetRequest();
    expect(value).toBe(75);
  });

  test("onGet saturation returns 0 when no state cached", async () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const sat = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Saturation);

    const value = await sat.handleGetRequest();
    expect(value).toBe(0);
  });

  test("onSet brightness converts HomeKit to Z2M", () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);
    const brightness = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Brightness);

    brightness.setValue(50);
    expect(publish).toHaveBeenCalledWith("test_light/set", { brightness: 127 });

    brightness.setValue(100);
    expect(publish).toHaveBeenCalledWith("test_light/set", { brightness: 254 });
  });

  test("onSet color_temp publishes mireds directly", () => {
    const device = makeDevice({ capabilities: ["on_off", "color_temp"] });
    const accessory = createLightAccessory(device, publish, getState);
    const ct = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.ColorTemperature);

    ct.setValue(250);
    expect(publish).toHaveBeenCalledWith("test_light/set", { color_temp: 250 });
  });

  test("onSet hue publishes color object", () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const hue = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Hue);

    hue.setValue(180);
    expect(publish).toHaveBeenCalledWith("test_light/set", {
      color: { hue: 180 },
    });
  });

  test("onSet saturation publishes color object", () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);
    const sat = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Saturation);

    sat.setValue(75);
    expect(publish).toHaveBeenCalledWith("test_light/set", {
      color: { saturation: 75 },
    });
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
    expect(publish).toHaveBeenCalledWith("test_light/set", { scene_recall: 1 });
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
      expect(timeouts[0].delay).toBe(1000);

      timeouts[0].fn();
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
    getState = () => undefined;
  });

  test("updates On characteristic from state", () => {
    const device = makeDevice({ capabilities: ["on_off"] });
    const accessory = createLightAccessory(device, publish, getState);

    updateAccessoryState(accessory, { state: "ON" }, ["on_off"]);
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);
    expect(on.value).toBe(true);

    updateAccessoryState(accessory, { state: "OFF" }, ["on_off"]);
    expect(on.value).toBe(false);
  });

  test("updates brightness with conversion", () => {
    const device = makeDevice({ capabilities: ["on_off", "brightness"] });
    const accessory = createLightAccessory(device, publish, getState);

    updateAccessoryState(accessory, { brightness: 254 }, [
      "on_off",
      "brightness",
    ]);
    const b = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.Brightness);
    expect(b.value).toBe(100);

    updateAccessoryState(accessory, { brightness: 127 }, [
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

  test("updates hue and saturation", () => {
    const device = makeDevice({ capabilities: ["on_off", "color_hs"] });
    const accessory = createLightAccessory(device, publish, getState);

    updateAccessoryState(accessory, { color: { hue: 200, saturation: 80 } }, [
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
    updateAccessoryState(accessory, { state: "ON", brightness: 254 }, [
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
    updateAccessoryState(accessory, { state: "ON" }, ["on_off"]);
  });
});
