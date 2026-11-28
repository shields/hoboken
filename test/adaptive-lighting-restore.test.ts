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

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  Accessory,
  type ActiveAdaptiveLightingTransition,
  AdaptiveLightingController,
  Characteristic,
  decode,
  decodeWithLists,
  Service,
  uuid,
} from "@homebridge/hap-nodejs";
import {
  parseSavedSchedule,
  restoredTransition,
} from "../src/adaptive-lighting-restore.ts";
import {
  assignInstanceIds,
  type CurveEntry,
  DAILY_CURVE,
  HUB_CONTEXT,
  hubStartsAdaptiveLighting,
} from "./adaptive-lighting-hub.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 10, 25, 6, 30);

const released: (() => void)[] = [];

afterEach(() => {
  for (const release of released.splice(0)) release();
  setSystemTime();
});

let lamps = 0;

function lamp() {
  const accessory = new Accessory(
    "Lamp",
    uuid.generate(`restore-test:${String(lamps++)}`),
  );
  const service = new Service.Lightbulb("Lamp");
  accessory.addService(service);
  const brightness = service.getCharacteristic(Characteristic.Brightness);
  brightness.value = 50;
  const temperatures: number[] = [];
  service.getCharacteristic(Characteristic.ColorTemperature).onSet((value) => {
    temperatures.push(value as number);
  });
  const controller = new AdaptiveLightingController(service);
  accessory.configureController(controller);
  assignInstanceIds(accessory);
  released.push(() => {
    controller.disableAdaptiveLighting();
  });
  // A change of Brightness makes the controller compute the temperature for
  // the present.
  const temperatureNow = (): number | undefined => {
    const before = temperatures.length;
    brightness.setValue(brightness.value === 50 ? 51 : 50);
    return temperatures.length > before ? temperatures.at(-1) : undefined;
  };
  const transitionControl = service.getCharacteristic(
    Characteristic.CharacteristicValueTransitionControl,
  );
  return {
    accessory,
    controller,
    brightness,
    temperatures,
    temperatureNow,
    transitionControl,
  };
}

// The hub's clock may differ from the bridge's by `hubAhead`.
async function hubSchedule(entries: CurveEntry[] = DAILY_CURVE, hubAhead = 0) {
  setSystemTime(START);
  const original = lamp();
  await hubStartsAdaptiveLighting(original.accessory, {
    startMs: START + hubAhead,
    entries,
    context: HUB_CONTEXT,
  });
  const saved = structuredClone(
    original.controller.serialize()!.activeTransition,
  );
  return { original, saved };
}

describe("restoredTransition", () => {
  test.each([
    ["the middle of a segment", 2 * HOUR + 17 * 60000, 0],
    ["the first entry's hold", 25 * 60000, 0],
    ["a later hold", 12 * HOUR + 30 * 60000, 0],
    ["an entry", 6 * HOUR, 0],
    ["the start", 0, 0],
    ["days after the start", 3 * DAY + 9 * HOUR + 1000, 0],
    ["a time before the start", -2 * HOUR, 0],
    ["a time by a hub whose clock is ahead", 3 * HOUR, 5 * 60000],
  ])(
    "started at %s, follows the saved schedule for a day",
    async (_, elapsed, hubAhead) => {
      const { original, saved } = await hubSchedule(DAILY_CURVE, hubAhead);
      const now = START + elapsed;
      setSystemTime(now);
      const restored = lamp();
      await restored.transitionControl.handleSetRequest(
        restoredTransition(saved, now)!,
      );
      expect(restored.controller.isAdaptiveLightingActive()).toBe(true);
      for (let later = 0; later < DAY; later += 7 * 60000 + 13000) {
        setSystemTime(START + ((((elapsed + later) % DAY) + DAY) % DAY));
        const expected = original.temperatureNow();
        setSystemTime(now + later);
        expect([later, restored.temperatureNow()]).toEqual([later, expected]);
      }
      setSystemTime(now + DAY - 1);
      expect(restored.temperatureNow()).toBeDefined();
    },
  );

  test("keeps the hub's transition id and context and starts now", async () => {
    const { saved } = await hubSchedule();
    const now = START + 5 * HOUR;
    const restored = lamp();
    await restored.transitionControl.handleSetRequest(
      restoredTransition(saved, now)!,
    );
    const transition = restored.controller.serialize()!.activeTransition;
    expect(transition.transitionId).toBe(saved.transitionId);
    expect(transition.id3).toBe(HUB_CONTEXT.toString("hex"));
    expect(transition.transitionStartMillis).toBe(now);
    expect(transition.brightnessAdjustmentRange).toEqual(
      saved.brightnessAdjustmentRange,
    );
    expect(transition.updateInterval).toBe(saved.updateInterval);
    expect(transition.notifyIntervalThreshold).toBe(
      saved.notifyIntervalThreshold,
    );
    const curve = transition.transitionCurve;
    expect(
      curve.reduce(
        (total, entry) => total + entry.transitionTime + (entry.duration ?? 0),
        0,
      ),
    ).toBe(DAY);
    expect(curve[0]!.transitionTime).toBe(0);
  });

  test("leaves out a context that the schedule did not have", async () => {
    setSystemTime(START);
    const original = lamp();
    await hubStartsAdaptiveLighting(original.accessory, {
      startMs: START,
      entries: DAILY_CURVE,
    });
    const saved = structuredClone(
      original.controller.serialize()!.activeTransition,
    );
    const restored = lamp();
    await restored.transitionControl.handleSetRequest(
      restoredTransition(saved, START)!,
    );
    expect(restored.controller.serialize()!.activeTransition.id3).toBe(
      undefined,
    );
  });

  test("writes the update interval in two bytes", async () => {
    const { saved } = await hubSchedule();
    const restored = lamp();
    await restored.transitionControl.handleSetRequest(
      restoredTransition({ ...saved, updateInterval: 200 }, START)!,
    );
    expect(
      restored.controller.serialize()!.activeTransition.updateInterval,
    ).toBe(200);
  });

  test.each([
    ["at the start", 0],
    ["at an entry", 6 * HOUR],
    ["at the end of a hold", HOUR],
    ["inside a segment", 3 * HOUR],
  ])("adds only the point where it starts, %s", async (_, elapsed) => {
    const { saved } = await hubSchedule();
    const configuration = decode(
      decode(
        decode(
          Buffer.from(restoredTransition(saved, START + elapsed)!, "base64"),
        )[2]!,
      )[1]!,
    );
    // Seven points: the hub's five, with the ends of two holds.
    expect(decodeWithLists(configuration[5]!)[1]).toHaveLength(
      elapsed === 3 * HOUR ? 8 : 7,
    );
  });

  test.each<[string, CurveEntry[]]>([
    [
      "a schedule that does not end where it starts",
      [
        [400, 0],
        [300, 12 * HOUR],
        [250, 12 * HOUR],
      ],
    ],
    [
      "a schedule shorter than a day",
      [
        [400, 0],
        [300, HOUR],
        [400, HOUR],
      ],
    ],
  ])("refuses %s", async (_, entries) => {
    const { saved } = await hubSchedule(entries);
    expect(restoredTransition(saved, START)).toBeUndefined();
  });

  test("refuses a schedule whose ends differ only in their brightness factor", async () => {
    const { saved } = await hubSchedule();
    const curve = saved.transitionCurve.map((entry, i, all) =>
      i === all.length - 1
        ? { ...entry, brightnessAdjustmentFactor: -0.25 }
        : entry,
    );
    expect(
      restoredTransition({ ...saved, transitionCurve: curve }, START),
    ).toBeUndefined();
  });

  test("refuses a schedule that starts late", async () => {
    const { saved } = await hubSchedule();
    const curve = saved.transitionCurve.map((entry, i, all) => ({
      ...entry,
      transitionTime:
        entry.transitionTime +
        (i === 0 ? HOUR : i === all.length - 1 ? -HOUR : 0),
    }));
    expect(
      restoredTransition({ ...saved, transitionCurve: curve }, START),
    ).toBeUndefined();
  });

  test("refuses a schedule of one entry", async () => {
    const { saved } = await hubSchedule();
    expect(
      restoredTransition(
        { ...saved, transitionCurve: saved.transitionCurve.slice(0, 1) },
        START,
      ),
    ).toBeUndefined();
    expect(
      restoredTransition({ ...saved, transitionCurve: [] }, START),
    ).toBeUndefined();
  });

  test("ignores a hold at the last entry", async () => {
    const { saved } = await hubSchedule();
    const curve = saved.transitionCurve.map((entry, i, all) =>
      i === all.length - 1 ? { ...entry, duration: HOUR } : entry,
    );
    expect(
      restoredTransition({ ...saved, transitionCurve: curve }, START),
    ).toBe(restoredTransition(saved, START));
  });
});

describe("parseSavedSchedule", () => {
  async function valid(): Promise<ActiveAdaptiveLightingTransition> {
    const { saved } = await hubSchedule();
    return structuredClone(saved);
  }

  test("accepts what HAP-NodeJS serializes, through JSON", async () => {
    const schedule = await valid();
    expect(parseSavedSchedule({ schedule })).toStrictEqual({ schedule });
    expect(parseSavedSchedule({ schedule, restored: "00ff" })).toStrictEqual({
      schedule,
      restored: "00ff",
    });
    const withoutContext = { ...schedule };
    delete withoutContext.id3;
    expect(parseSavedSchedule({ schedule: withoutContext })).toEqual({
      schedule: withoutContext,
    });
  });

  test("refuses anything else", async () => {
    const schedule = await valid();
    const entry = schedule.transitionCurve[0]!;
    const withEntry = (change: Record<string, unknown>) => ({
      ...schedule,
      transitionCurve: [{ ...entry, ...change }],
    });
    for (const value of [
      undefined,
      null,
      "schedule",
      {},
      { schedule: null },
      { schedule, restored: "xyz" },
      { schedule, restored: 1 },
      { schedule: { ...schedule, iid: -1 } },
      { schedule: { ...schedule, iid: 1.5 } },
      { schedule: { ...schedule, transitionStartMillis: 1.5 } },
      { schedule: { ...schedule, timeMillisOffset: "0" } },
      { schedule: { ...schedule, transitionId: 7 } },
      { schedule: { ...schedule, transitionId: "not a uuid" } },
      { schedule: { ...schedule, transitionStartBuffer: "abc" } },
      { schedule: { ...schedule, id3: "zz" } },
      { schedule: { ...schedule, transitionCurve: {} } },
      { schedule: { ...schedule, transitionCurve: [null] } },
      { schedule: withEntry({ temperature: "400" }) },
      { schedule: withEntry({ brightnessAdjustmentFactor: null }) },
      { schedule: withEntry({ transitionTime: -1 }) },
      { schedule: withEntry({ duration: 0.5 }) },
      { schedule: { ...schedule, brightnessCharacteristicIID: "1" } },
      { schedule: { ...schedule, brightnessAdjustmentRange: null } },
      { schedule: { ...schedule, brightnessAdjustmentRange: undefined } },
      { schedule: { ...schedule, brightnessAdjustmentRange: 5 } },
      {
        schedule: {
          ...schedule,
          brightnessAdjustmentRange: { minBrightnessValue: 10 },
        },
      },
      {
        schedule: {
          ...schedule,
          brightnessAdjustmentRange: {
            minBrightnessValue: 2 ** 32,
            maxBrightnessValue: 100,
          },
        },
      },
      {
        schedule: {
          ...schedule,
          brightnessAdjustmentRange: {
            minBrightnessValue: 10,
            maxBrightnessValue: 2 ** 32,
          },
        },
      },
      { schedule: { ...schedule, updateInterval: 65536 } },
      { schedule: { ...schedule, notifyIntervalThreshold: 2 ** 32 } },
    ])
      expect([value, parseSavedSchedule(value)]).toEqual([value, undefined]);
  });
});
