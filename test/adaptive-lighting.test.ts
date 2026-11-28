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

import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import { Characteristic, Service } from "@homebridge/hap-nodejs";
import {
  adaptiveLightingController,
  createLightAccessory,
  updateAccessoryState,
} from "../src/accessories.ts";
import {
  ADAPTIVE_TRANSITION_SECONDS,
  fadeTemperature,
  hasAdaptiveLighting,
  shouldPublishAdaptiveTemperature,
  showsColor,
  turnsLightOn,
  withAdaptiveTemperature,
  withAdaptiveWhite,
  writtenState,
  zigbeeOffTemperatureMessage,
} from "../src/adaptive-lighting.ts";
import type { Capability, DeviceConfig } from "../src/config.ts";
import type { HomeKitState } from "../src/convert.ts";
import {
  assignInstanceIds,
  hubStartsAdaptiveLighting,
} from "./adaptive-lighting-hub.ts";

function flush(): Promise<void> {
  return new Promise((resolve) => {
    process.nextTick(resolve);
  });
}

describe("adaptive lighting decisions", () => {
  test("a light needs both brightness and color_temp", () => {
    const has = (...capabilities: Capability[]) =>
      hasAdaptiveLighting({ capabilities });
    expect(has("on_off", "brightness", "color_temp")).toBe(true);
    expect(has("on_off", "brightness")).toBe(false);
    expect(has("on_off", "color_temp")).toBe(false);
  });

  test("a temperature is published only to a light that is on and shows another", () => {
    expect(shouldPublishAdaptiveTemperature({}, 350)).toBe(false);
    expect(shouldPublishAdaptiveTemperature({ on: false }, 350)).toBe(false);
    expect(
      shouldPublishAdaptiveTemperature({ on: true, color_temp: 350 }, 350),
    ).toBe(false);
    expect(
      shouldPublishAdaptiveTemperature({ on: true, color_temp: 340 }, 350),
    ).toBe(true);
    expect(shouldPublishAdaptiveTemperature({ on: true }, 350)).toBe(true);
  });

  test("a light that takes a temperature while off is sent one when it is known to be off", () => {
    const publish = (state: HomeKitState) =>
      shouldPublishAdaptiveTemperature(state, 350, undefined, true);
    expect(publish({})).toBe(false);
    expect(publish({ on: false })).toBe(true);
    expect(publish({ on: false, color_temp: 350 })).toBe(false);
    expect(publish({ on: true, color_temp: 340 })).toBe(true);
    expect(publish({ on: true, color_temp: 350 })).toBe(false);
  });

  test("the Zigbee message that stores a temperature while off is a raw command that executes if off", () => {
    expect(zigbeeOffTemperatureMessage(350)).toEqual({
      command: {
        cluster: "lightingColorCtrl",
        command: "moveToColorTemp",
        payload: {
          colortemp: 350,
          transtime: 0,
          optionsMask: 1,
          optionsOverride: 1,
        },
      },
    });
  });

  test("a temperature alone fades over the transition", () => {
    expect(ADAPTIVE_TRANSITION_SECONDS).toBe(5);
    expect(fadeTemperature({ color_temp: 350 })).toEqual({
      color_temp: 350,
      transition: 5,
    });
  });

  test("a message that changes power or brightness, or has no temperature, does not fade", () => {
    for (const message of [
      { state: "ON", color_temp: 350 },
      { brightness: 100, color_temp: 350 },
      { brightness: 100 },
      { color: { hue: 1, saturation: 2 } },
    ])
      expect(fadeTemperature(message)).toBe(message);
  });

  test("a write gives a light the power and temperature in it", () => {
    expect(writtenState({ on: false, brightness: 20 })).toEqual({ on: false });
    expect(writtenState({ color_temp: 350, hue: 30 })).toEqual({
      color_temp: 350,
    });
    expect(writtenState({ on: true, color_temp: 350 })).toEqual({
      on: true,
      color_temp: 350,
    });
    expect(writtenState({ brightness: 20 })).toEqual({ on: true });
    expect(writtenState({ brightness: 0 })).toEqual({ on: false });
    expect(writtenState({ brightness: -1 })).toEqual({});
    expect(writtenState({ brightness: "20" })).toEqual({});
    expect(writtenState({ on: true, brightness: 0 })).toEqual({ on: true });
    expect(writtenState({})).toEqual({});
  });

  test("a temperature that a light showed the same value for twice is not published", () => {
    const on = { on: true, color_temp: 454 };
    const request = (temperature: number, shown: number | undefined) => ({
      temperature,
      shown,
    });
    expect(shouldPublishAdaptiveTemperature(on, 500, undefined)).toBe(true);
    expect(
      shouldPublishAdaptiveTemperature(on, 500, request(500, undefined)),
    ).toBe(true);
    expect(shouldPublishAdaptiveTemperature(on, 500, request(500, 454))).toBe(
      false,
    );
    expect(shouldPublishAdaptiveTemperature(on, 500, request(500, 453))).toBe(
      true,
    );
    expect(shouldPublishAdaptiveTemperature(on, 499, request(500, 454))).toBe(
      true,
    );
    expect(
      shouldPublishAdaptiveTemperature({ on: true }, 500, request(500, 454)),
    ).toBe(true);
    expect(
      shouldPublishAdaptiveTemperature(
        { on: true },
        500,
        request(500, undefined),
      ),
    ).toBe(true);
    expect(
      shouldPublishAdaptiveTemperature(
        { color_temp: 454 },
        500,
        request(500, 454),
      ),
    ).toBe(false);
  });

  test("a write turns on a light that is not on, by On or by a brightness above zero", () => {
    for (const state of [{}, { on: false }]) {
      expect(turnsLightOn({ on: true }, state)).toBe(true);
      expect(turnsLightOn({ on: true, brightness: 0 }, state)).toBe(true);
      expect(turnsLightOn({ brightness: 1 }, state)).toBe(true);
      expect(turnsLightOn({ brightness: 0 }, state)).toBe(false);
      expect(turnsLightOn({ on: false, brightness: 40 }, state)).toBe(false);
      expect(turnsLightOn({ hue: 3 }, state)).toBe(false);
      expect(turnsLightOn({ brightness: "40" }, state)).toBe(false);
    }
    expect(turnsLightOn({ on: true }, { on: true })).toBe(false);
    expect(turnsLightOn({ brightness: 40 }, { on: true })).toBe(false);
  });

  test("a write that turns a light on without a color or temperature gets the remembered temperature", () => {
    const off = { on: false };
    const on = { on: true, brightness: 40 };
    const turnedOn = { on: true, brightness: 40, color_temp: 350 };
    expect(withAdaptiveTemperature(on, 350, true, off)).toEqual(turnedOn);
    expect(withAdaptiveTemperature(on, 350, true, {})).toEqual(turnedOn);
    expect(withAdaptiveTemperature(on, 350, false, off)).toBe(on);
    expect(withAdaptiveTemperature(on, undefined, true, off)).toBe(on);
    for (const own of [{ hue: 1 }, { saturation: 1 }, { color_temp: 300 }]) {
      const payload = { on: true, ...own };
      expect(withAdaptiveTemperature(payload, 350, true, off)).toBe(payload);
    }
    const turnOff = { on: false, brightness: 40 };
    expect(withAdaptiveTemperature(turnOff, 350, true, off)).toBe(turnOff);
    const brightness = { brightness: 40 };
    expect(withAdaptiveTemperature(brightness, 350, true, off)).toEqual({
      brightness: 40,
      color_temp: 350,
    });
    const dark = { brightness: 0 };
    expect(withAdaptiveTemperature(dark, 350, true, off)).toBe(dark);
    expect(withAdaptiveTemperature(on, 350, true, { on: true })).toBe(on);
    expect(withAdaptiveTemperature(brightness, 350, true, { on: true })).toBe(
      brightness,
    );
  });

  test("Siri's white is Adaptive Lighting's temperature while it is on", () => {
    const white = { hue: 0, saturation: 0, brightness: 100, on: true };
    expect(withAdaptiveWhite(white, 350, true)).toEqual({
      brightness: 100,
      on: true,
      color_temp: 350,
    });
    expect(white).toEqual({ hue: 0, saturation: 0, brightness: 100, on: true });
    expect(withAdaptiveWhite(white, 350, false)).toBe(white);
    expect(withAdaptiveWhite(white, undefined, true)).toBe(white);
    const swatch = { hue: 228, saturation: 56 };
    expect(withAdaptiveWhite(swatch, 350, true)).toBe(swatch);
  });

  test("a color is the minimum temperature without that temperature's own color", () => {
    const capabilities: Capability[] = ["color_hs", "color_temp"];
    const blue = { hue: 240, saturation: 100 };
    expect(showsColor({ color_temp: 140, ...blue }, { capabilities })).toBe(
      true,
    );
    expect(showsColor({ color_temp: 140 }, { capabilities })).toBe(true);
    expect(
      showsColor(
        { color_temp: 140, hue: 241, saturation: 5 },
        { capabilities },
      ),
    ).toBe(false);
    expect(
      showsColor(
        { color_temp: 140, hue: 241, saturation: 6 },
        { capabilities },
      ),
    ).toBe(true);
    expect(showsColor({ color_temp: 141, ...blue }, { capabilities })).toBe(
      false,
    );
    expect(showsColor(blue, { capabilities })).toBe(false);
    expect(
      showsColor(
        { color_temp: 140, ...blue },
        { capabilities: ["color_temp"] },
      ),
    ).toBe(false);
    const wled = {
      capabilities,
      colorSegments: [0],
      whiteSegments: [1],
      whiteChannels: { r: 5500, g: 2400, b: 5500, w: 2400 },
    };
    expect(showsColor({ color_temp: 182, ...blue }, wled)).toBe(true);
    expect(showsColor({ color_temp: 182, hue: 24, saturation: 12 }, wled)).toBe(
      false,
    );
    expect(showsColor({ color_temp: 183, ...blue }, wled)).toBe(false);
  });

  test("the white that a light with white strips shows unremembered is not a color", () => {
    const capabilities: Capability[] = ["color_hs", "color_temp"];
    const strips = { colorSegments: [0], whiteSegments: [1] };
    const magenta = { hue: 300, saturation: 100 };
    const cases = [
      // The cool end has no lit w channel when w is a warm strip, and the
      // warm end has none when w is a cool strip.
      { r: 5500, g: 2400, b: 5500, w: 2400 },
      { r: 2400, g: 5500, b: 2400, w: 5500 },
    ];
    for (const whiteChannels of cases) {
      const light = { capabilities, ...strips, whiteChannels };
      expect(showsColor({ color_temp: 182, ...magenta }, light)).toBe(false);
      expect(
        showsColor({ color_temp: 182, hue: 300, saturation: 99 }, light),
      ).toBe(true);
      expect(
        showsColor({ color_temp: 182, hue: 299, saturation: 100 }, light),
      ).toBe(true);
      expect(
        showsColor({ color_temp: 182, hue: 240, saturation: 100 }, light),
      ).toBe(true);
    }
    const gray = {
      capabilities,
      ...strips,
      whiteChannels: { r: 2400, g: 2400, b: 2400, w: 5500 },
    };
    expect(showsColor({ color_temp: 182, hue: 0, saturation: 0 }, gray)).toBe(
      false,
    );
    expect(showsColor({ color_temp: 182, ...magenta }, gray)).toBe(true);
  });
});

describe("a light with Adaptive Lighting", () => {
  const TOPIC = "zigbee2mqtt/lamp";
  const released: (() => void)[] = [];

  afterEach(() => {
    for (const release of released.splice(0)) release();
    jest.useRealTimers();
  });

  function setup(
    capabilities: Capability[] = [
      "on_off",
      "brightness",
      "color_temp",
      "color_hs",
    ],
    accepted = true,
  ) {
    const device: DeviceConfig = {
      name: "Lamp",
      type: "z2m",
      topic: TOPIC,
      capabilities,
    };
    const publish = mock();
    const accept = mock((temperature: number) => accepted && temperature > 0);
    const accessory = createLightAccessory(
      device,
      publish,
      () => ({ on: true }),
      undefined,
      accept,
    );
    assignInstanceIds(accessory);
    const service = accessory.getService(Service.Lightbulb)!;
    const controller = adaptiveLightingController(accessory);
    released.push(() => controller?.disableAdaptiveLighting());
    const characteristic = (type: typeof Characteristic.Hue) =>
      service.getCharacteristic(type);
    return { accessory, service, controller, publish, accept, characteristic };
  }

  test("gets the controller's characteristics only with brightness and color_temp", () => {
    for (const [capabilities, expected] of [
      [["on_off", "brightness", "color_temp"], true],
      [["on_off", "brightness"], false],
      [["on_off", "color_temp"], false],
    ] as const) {
      const { service, controller } = setup([...capabilities]);
      expect(controller !== undefined).toBe(expected);
      for (const type of [
        Characteristic.SupportedCharacteristicValueTransitionConfiguration,
        Characteristic.CharacteristicValueTransitionControl,
        Characteristic.CharacteristicValueActiveTransitionCount,
      ])
        expect(service.testCharacteristic(type)).toBe(expected);
    }
  });

  test("starting it publishes the temperature once, as Adaptive Lighting's", async () => {
    const { accessory, publish, accept, controller } = setup();
    await hubStartsAdaptiveLighting(accessory);
    await flush();
    expect(controller!.isAdaptiveLightingActive()).toBe(true);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      TOPIC,
      { color_temp: accept.mock.calls[0]![0] },
      "adaptive-lighting",
    );
  });

  test("each scheduled update asks again", async () => {
    jest.useFakeTimers();
    const { accessory, accept, characteristic } = setup();
    await hubStartsAdaptiveLighting(accessory);
    expect(accept).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(59999);
    expect(accept).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(accept).toHaveBeenCalledTimes(2);
    expect(characteristic(Characteristic.ColorTemperature).value).toBe(
      accept.mock.calls[1]![0],
    );
  });

  test("a temperature that is not accepted is not published", async () => {
    const { accessory, publish, accept, characteristic } = setup(
      undefined,
      false,
    );
    await hubStartsAdaptiveLighting(accessory);
    await flush();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(characteristic(Characteristic.ColorTemperature).value).toBe(
      accept.mock.calls[0]![0],
    );
  });

  test("a Brightness change recomputes the temperature at once", async () => {
    const { accessory, accept, characteristic } = setup();
    await hubStartsAdaptiveLighting(accessory);
    await flush();
    const before = accept.mock.calls[0]![0];
    updateAccessoryState(accessory, { brightness: 20 }, [
      "brightness",
      "color_temp",
    ]);
    await flush();
    expect(accept).toHaveBeenCalledTimes(2);
    expect([before, accept.mock.calls[1]![0]]).toEqual([395, 390]);
    expect(characteristic(Characteristic.ColorTemperature).value).toBe(
      accept.mock.calls[1]![0],
    );
  });

  test("a HomeKit Brightness write shares one message with its recomputed temperature", async () => {
    const { accessory, publish, accept, characteristic } = setup();
    await hubStartsAdaptiveLighting(accessory);
    await flush();
    publish.mockClear();
    characteristic(Characteristic.Brightness).setValue(30);
    await flush();
    await flush();
    expect(publish.mock.calls).toEqual([
      [TOPIC, { brightness: 30, color_temp: accept.mock.calls[1]![0] }],
    ]);
  });

  test("a HomeKit color or temperature in the tick of a recomputed temperature wins", async () => {
    for (const writes of [
      [
        [Characteristic.Brightness, 30],
        [Characteristic.Hue, 30],
        [Characteristic.Saturation, 80],
      ],
      [
        [Characteristic.Hue, 30],
        [Characteristic.Saturation, 80],
        [Characteristic.Brightness, 30],
      ],
      [
        [Characteristic.Brightness, 30],
        [Characteristic.ColorTemperature, 250],
      ],
      [
        [Characteristic.ColorTemperature, 250],
        [Characteristic.Brightness, 30],
      ],
    ] as const) {
      const { accessory, publish, controller, characteristic } = setup();
      await hubStartsAdaptiveLighting(accessory);
      await flush();
      publish.mockClear();
      for (const [type, value] of writes) characteristic(type).setValue(value);
      await flush();
      await flush();
      const merged = Object.assign(
        {},
        ...publish.mock.calls.map((call) => call[1] as object),
      ) as Record<string, number>;
      for (const [type, value] of writes) {
        if (type === Characteristic.ColorTemperature)
          expect(merged.color_temp).toBe(value);
        if (type === Characteristic.Hue) expect(merged.hue).toBe(value);
      }
      if (writes.some(([type]) => type === Characteristic.Hue))
        expect(merged).not.toHaveProperty("color_temp");
      expect(controller!.isAdaptiveLightingActive()).toBe(false);
    }
  });

  test("a HomeKit request that writes Brightness and a color is not followed by the recomputed temperature", async () => {
    for (const [writes, expected] of [
      [
        [
          [Characteristic.Brightness, 30],
          [Characteristic.Hue, 30],
          [Characteristic.Saturation, 80],
        ],
        { brightness: 30, hue: 30, saturation: 80 },
      ],
      [
        [
          [Characteristic.Brightness, 30],
          [Characteristic.ColorTemperature, 250],
        ],
        { brightness: 30, color_temp: 250 },
      ],
    ] as const) {
      const { accessory, publish, controller, characteristic } = setup();
      await hubStartsAdaptiveLighting(accessory);
      await flush();
      publish.mockClear();
      // HAP-NodeJS handles a write request in the nextTick callback that ends
      // the HTTP request body, so the coalescer flushes before each
      // characteristic's change, which Adaptive Lighting reacts to, is
      // emitted after the await of its onSet.
      process.nextTick(() => {
        for (const [type, value] of writes)
          void characteristic(type).handleSetRequest(value, {} as never);
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(controller!.isAdaptiveLightingActive()).toBe(false);
      expect(publish.mock.calls).toEqual([[TOPIC, expected]]);
    }
  });

  test("a HomeKit request that writes only Brightness is followed by the recomputed temperature", async () => {
    const { accessory, publish, controller, characteristic, accept } = setup();
    await hubStartsAdaptiveLighting(accessory);
    await flush();
    publish.mockClear();
    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        30,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(controller!.isAdaptiveLightingActive()).toBe(true);
    expect(publish.mock.calls).toEqual([
      [TOPIC, { brightness: 30 }],
      [TOPIC, { color_temp: accept.mock.calls[1]![0] }, "adaptive-lighting"],
    ]);
  });

  test("a HomeKit write of ColorTemperature turns it off", async () => {
    const { accessory, controller, characteristic } = setup();
    await hubStartsAdaptiveLighting(accessory);
    characteristic(Characteristic.ColorTemperature).setValue(300);
    await flush();
    expect(controller!.isAdaptiveLightingActive()).toBe(false);
  });

  test("a HomeKit write of Hue or Saturation turns it off", async () => {
    for (const type of [Characteristic.Hue, Characteristic.Saturation]) {
      const { accessory, controller, characteristic } = setup();
      await hubStartsAdaptiveLighting(accessory);
      characteristic(type).setValue(30);
      await flush();
      expect(controller!.isAdaptiveLightingActive()).toBe(false);
    }
  });

  test("a temperature gives a light without Hue and Saturation neither", async () => {
    const { accessory, publish } = setup([
      "on_off",
      "brightness",
      "color_temp",
    ]);
    await hubStartsAdaptiveLighting(accessory);
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    const service = accessory.getService(Service.Lightbulb)!;
    expect(service.testCharacteristic(Characteristic.Hue)).toBe(false);
    expect(service.testCharacteristic(Characteristic.Saturation)).toBe(false);
  });

  test("the bridge's own updates of the color do not turn it off", async () => {
    const { accessory, controller } = setup();
    await hubStartsAdaptiveLighting(accessory);
    updateAccessoryState(
      accessory,
      { hue: 30, saturation: 40, color_temp: 300, on: false },
      ["on_off", "color_hs", "color_temp"],
    );
    await flush();
    expect(controller!.isAdaptiveLightingActive()).toBe(true);
  });

  test("without the bridge's memory of schedules Siri's white turns it off", async () => {
    const { accessory, controller, characteristic } = setup();
    await hubStartsAdaptiveLighting(accessory);
    process.nextTick(() => {
      void characteristic(Characteristic.Hue).handleSetRequest(0, {} as never);
      void characteristic(Characteristic.Saturation).handleSetRequest(
        0,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(controller!.isAdaptiveLightingActive()).toBe(false);
  });

  test("without a hook a temperature that Adaptive Lighting sets is published like a write", async () => {
    const publish = mock();
    const accessory = createLightAccessory(
      {
        name: "Lamp",
        type: "z2m",
        topic: TOPIC,
        capabilities: ["on_off", "brightness", "color_temp"],
      },
      publish,
      () => ({ on: true }),
    );
    assignInstanceIds(accessory);
    released.push(() =>
      adaptiveLightingController(accessory)?.disableAdaptiveLighting(),
    );
    await hubStartsAdaptiveLighting(accessory);
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]).toHaveLength(2);
  });
});
