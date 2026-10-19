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

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  Characteristic,
  HAPStatus,
  Perms,
  Service,
  type CharacteristicValue,
} from "@homebridge/hap-nodejs";
import {
  createHeatedBeddingAccessories,
  type HeatedBeddingAccessories,
} from "../src/heated-bedding-accessories.ts";
import pino from "pino";
import {
  HeatedBeddingSource,
  heatedBeddingZoneConfigs,
  type HeatedBeddingGroupConfig,
  type HeatedBeddingPublication,
  type HeatedBeddingZoneConfig,
} from "../src/heated-bedding-source.ts";

const CONFIG: HeatedBeddingZoneConfig = {
  name: "Bed Side A",
  prefix: "tuya",
  controller: "bed",
  zone: "left",
};
const TOPIC = "tuya/bed/left";
const BASELINE = {
  session_id: "session-a",
  power: false,
  heat_level: 4,
  preheat: false,
};

describe("heated bedding HomeKit accessories", () => {
  let source: HeatedBeddingSource;
  let controls: HeatedBeddingAccessories;
  let generation: number;
  let now: number;
  let sent: HeatedBeddingPublication[];

  beforeEach(() => {
    jest.useFakeTimers();
    now = 0;
    sent = [];
    let sequence = 0;
    source = new HeatedBeddingSource(
      [CONFIG],
      (_topic, payload) => {
        sent.push(payload);
      },
      {
        clock: () => now,
        identifier: () => `request-${String(++sequence)}`,
        changed: () => {
          controls.update();
        },
      },
    );
    controls = createHeatedBeddingAccessories(CONFIG, source);
    generation = source.connect();
  });

  afterEach(() => {
    source.disconnect();
    jest.useRealTimers();
  });

  function ready(): void {
    source.subscriptionsReady(generation);
    source.handle(generation, "tuya/bridge/availability", "online", true);
    source.handle(generation, "tuya/bed/availability", "online", true);
    source.handle(generation, TOPIC, BASELINE, true);
    source.handle(
      generation,
      "tuya/bridge/heartbeat",
      { session_id: "session-a" },
      false,
    );
  }

  function speed(): Characteristic {
    return controls.fan
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.RotationSpeed);
  }

  function active(): Characteristic {
    return controls.fan
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.Active);
  }

  function preheat(): Characteristic {
    return controls.preheat
      .getService(Service.Switch)!
      .getCharacteristic(Characteristic.On);
  }

  function flush(): void {
    now += 50;
    jest.advanceTimersByTime(50);
  }

  test("creates separate fan and stateful preheat identities with no AUTO or temperature", () => {
    expect(controls.fan.UUID).toBe("412452c9-f814-4f5c-bdda-a8a83ed59c1d");
    expect(controls.preheat.UUID).toBe("d941c243-80be-4f40-ac7f-941d2f7c6d49");
    expect(controls.fan.UUID).not.toBe(controls.preheat.UUID);
    expect(
      controls.fan
        .getService(Service.Fanv2)!
        .testCharacteristic(Characteristic.TargetFanState),
    ).toBe(false);
    expect(controls.fan.getService(Service.TemperatureSensor)).toBeUndefined();
    expect(speed().props).toMatchObject({
      minValue: 0,
      maxValue: 100,
      minStep: 10,
    });
    for (const characteristic of [active(), speed(), preheat()]) {
      expect(characteristic.props.perms).toContain(Perms.WRITE_RESPONSE);
      expect(characteristic.statusCode).toBe(
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    const renamed = createHeatedBeddingAccessories(
      { ...CONFIG, name: "Renamed", prefix: "other" },
      new HeatedBeddingSource([{ ...CONFIG, prefix: "other" }], () => {
        throw new Error("No writes expected");
      }),
    );
    expect(renamed.fan.UUID).toBe(controls.fan.UUID);
    expect(renamed.preheat.UUID).toBe(controls.preheat.UUID);
    const rightConfig = { ...CONFIG, zone: "right" };
    const right = createHeatedBeddingAccessories(
      rightConfig,
      new HeatedBeddingSource([rightConfig], () => {
        throw new Error("No writes expected");
      }),
    );
    expect(right.fan.UUID).not.toBe(controls.fan.UUID);
  });

  test("getters return No Response until state is usable", async () => {
    expect(
      await Promise.allSettled([
        active().handleGetRequest(),
        speed().handleGetRequest(),
        preheat().handleGetRequest(),
      ]),
    ).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
    ready();
    expect(await active().handleGetRequest()).toBe(
      Characteristic.Active.INACTIVE,
    );
    expect(await speed().handleGetRequest()).toBe(40);
    expect(await preheat().handleGetRequest()).toBe(false);
  });

  test("a fractional speed is normalized only after confirmation", async () => {
    ready();
    const write = speed().handleSetRequest(0.1);
    expect(speed().value).toBe(40);
    flush();
    expect(sent[0]).toEqual({
      request_id: "request-1",
      power: true,
      heat_level: 1,
    });
    source.handle(
      generation,
      TOPIC,
      { ...BASELINE, power: true, heat_level: 1 },
      false,
    );
    source.handle(
      generation,
      `${TOPIC}/result`,
      { request_id: "request-1", outcome: "confirmed" },
      false,
    );
    expect(await write).toBe(10);
    expect(speed().value).toBe(10);
  });

  test.each([false, true])(
    "off dominates paired writes when speed comes first: %s",
    async (speedFirst) => {
      ready();
      const writes = speedFirst
        ? [
            speed().handleSetRequest(80),
            active().handleSetRequest(Characteristic.Active.INACTIVE),
          ]
        : [
            active().handleSetRequest(Characteristic.Active.INACTIVE),
            speed().handleSetRequest(80),
          ];
      flush();
      expect(sent[0]).toEqual({ request_id: "request-1", power: false });
      source.handle(
        generation,
        `${TOPIC}/result`,
        { request_id: "request-1", outcome: "confirmed" },
        false,
      );
      await Promise.all(writes);
      expect(active().value).toBe(Characteristic.Active.INACTIVE);
      expect(speed().value).toBe(40);
    },
  );

  test("a rejected write preserves actual characteristic values", async () => {
    ready();
    const outcome = Promise.allSettled([speed().handleSetRequest(80)]);
    flush();
    source.handle(
      generation,
      `${TOPIC}/result`,
      {
        request_id: "request-1",
        outcome: "rejected",
        error_code: "write_disabled",
      },
      false,
    );
    expect(await outcome).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
    expect(speed().value).toBe(40);
    expect(active().value).toBe(Characteristic.Active.INACTIVE);
  });

  test("preheat follows reported state without a momentary reset", async () => {
    ready();
    const write = preheat().handleSetRequest(true);
    expect(preheat().value).toBe(false);
    source.handle(generation, TOPIC, { ...BASELINE, preheat: true }, false);
    source.handle(
      generation,
      `${TOPIC}/result`,
      { request_id: "request-1", outcome: "confirmed" },
      false,
    );
    expect(await write).toBe(true);
    now += 1000;
    jest.advanceTimersByTime(1000);
    expect(preheat().value).toBe(true);
    source.handle(generation, TOPIC, BASELINE, false);
    expect(preheat().value).toBe(false);
  });

  test("invalid setter inputs fail before any command", async () => {
    ready();
    for (const value of [-1, 101, NaN, Infinity, "50"]) {
      expect(
        await Promise.allSettled([speed().handleSetRequest(value)]),
      ).toEqual([
        { status: "rejected", reason: HAPStatus.INVALID_VALUE_IN_REQUEST },
      ]);
    }
    expect(
      await Promise.allSettled([
        active().handleSetRequest(2),
        preheat().handleSetRequest("true"),
      ]),
    ).toEqual([
      { status: "rejected", reason: HAPStatus.INVALID_VALUE_IN_REQUEST },
      { status: "rejected", reason: HAPStatus.INVALID_VALUE_IN_REQUEST },
    ]);
    expect(sent).toHaveLength(0);
  });
});

describe("heated bedding group accessories", () => {
  const LEFT: HeatedBeddingZoneConfig = {
    name: "Michael Bed",
    prefix: "tuya",
    controller: "bed",
    zone: "left",
  };
  const RIGHT: HeatedBeddingZoneConfig = {
    name: "Elizabeth Bed",
    prefix: "tuya",
    controller: "bed",
    zone: "right",
  };
  const GROUP: HeatedBeddingGroupConfig = {
    name: "Bed",
    prefix: "tuya",
    controller: "bed",
    zones: ["left", "right"],
  };
  const LEFT_TOPIC = "tuya/bed/left";
  const RIGHT_TOPIC = "tuya/bed/right";
  const LEFT_STATE = { ...BASELINE, heat_level: 3 };
  const RIGHT_STATE = { ...BASELINE, heat_level: 8 };

  let source: HeatedBeddingSource;
  let bed: HeatedBeddingAccessories;
  let left: HeatedBeddingAccessories;
  let right: HeatedBeddingAccessories;
  let generation: number;
  let now: number;
  let sent: { topic: string; payload: HeatedBeddingPublication }[];
  let logs: Record<string, unknown>[];
  let states: Map<string, Record<string, unknown>>;

  function create(config: HeatedBeddingGroupConfig): HeatedBeddingAccessories {
    return createHeatedBeddingAccessories(
      config,
      source,
      pino(
        { base: null },
        {
          write: (text: string) =>
            logs.push(JSON.parse(text) as Record<string, unknown>),
        },
      ),
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
    now = 0;
    sent = [];
    logs = [];
    states = new Map();
    let sequence = 0;
    source = new HeatedBeddingSource(
      [LEFT, RIGHT],
      (topic, payload) => {
        sent.push({ topic, payload });
      },
      {
        clock: () => now,
        identifier: () => `request-${String(++sequence)}`,
        changed: () => {
          for (const controls of [bed, left, right]) controls.update();
        },
      },
    );
    left = createHeatedBeddingAccessories(LEFT, source);
    right = createHeatedBeddingAccessories(RIGHT, source);
    bed = create(GROUP);
    generation = source.connect();
  });

  afterEach(() => {
    source.disconnect();
    jest.useRealTimers();
  });

  function report(
    topic: string,
    patch: Record<string, unknown> = {},
    retained = false,
  ): void {
    const state = {
      ...(topic === LEFT_TOPIC ? LEFT_STATE : RIGHT_STATE),
      ...states.get(topic),
      ...patch,
    };
    states.set(topic, state);
    source.handle(generation, topic, state, retained);
  }

  function ready(): void {
    source.subscriptionsReady(generation);
    source.handle(generation, "tuya/bridge/availability", "online", true);
    source.handle(generation, "tuya/bed/availability", "online", true);
    report(LEFT_TOPIC, {}, true);
    report(RIGHT_TOPIC, {}, true);
    source.handle(
      generation,
      "tuya/bridge/heartbeat",
      { session_id: "session-a" },
      false,
    );
  }

  function flush(): void {
    now += 50;
    jest.advanceTimersByTime(50);
  }

  function commands(): { topic: string; payload: Record<string, unknown> }[] {
    return sent.map(({ topic, payload }) => ({
      topic,
      payload: Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== "request_id"),
      ),
    }));
  }

  async function confirm(index: number): Promise<void> {
    const entry = sent[index]!;
    const topic = entry.topic.slice(0, -"/set".length);
    const { request_id: requestID, ...command } = entry.payload;
    report(topic, command);
    source.handle(
      generation,
      `${topic}/result`,
      { request_id: requestID, outcome: "confirmed" },
      false,
    );
    // Lets the writes that this confirmation resolves return before the next
    // event, as they would between MQTT messages.
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  }

  function fail(index: number, errorCode: string): void {
    const entry = sent[index]!;
    source.handle(
      generation,
      `${entry.topic.slice(0, -"/set".length)}/result`,
      {
        request_id: entry.payload.request_id,
        outcome: "rejected",
        error_code: errorCode,
      },
      false,
    );
  }

  function characteristics(controls: HeatedBeddingAccessories): {
    active: Characteristic;
    speed: Characteristic;
    preheat: Characteristic;
  } {
    const fan = controls.fan.getService(Service.Fanv2)!;
    return {
      active: fan.getCharacteristic(Characteristic.Active),
      speed: fan.getCharacteristic(Characteristic.RotationSpeed),
      preheat: controls.preheat
        .getService(Service.Switch)!
        .getCharacteristic(Characteristic.On),
    };
  }

  const Q = (controls: HeatedBeddingAccessories) => characteristics(controls);

  test("creates fan and preheat accessories with identities of their own", () => {
    expect(bed.fan.displayName).toBe("Bed");
    expect(bed.preheat.displayName).toBe("Bed Preheat");
    expect(bed.fan.UUID).toBe("eaf4a938-b005-4c5c-935f-aa0df1da7ead");
    expect(bed.preheat.UUID).toBe("32c5d8f1-eb0a-4012-9068-46dcab59693e");
    const uuids = [left, right, bed].flatMap((controls) => [
      controls.fan.UUID,
      controls.preheat.UUID,
    ]);
    expect(new Set(uuids).size).toBe(uuids.length);
    expect(
      bed.fan
        .getService(Service.Fanv2)!
        .testCharacteristic(Characteristic.TargetFanState),
    ).toBe(false);
    expect(Q(bed).speed.props).toMatchObject({
      minValue: 0,
      maxValue: 100,
      minStep: 10,
    });
    for (const characteristic of Object.values(Q(bed))) {
      expect(characteristic.props.perms).toContain(Perms.WRITE_RESPONSE);
      expect(characteristic.statusCode).toBe(
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  });

  test("the identity ignores zone order, name, and prefix but not the zones", () => {
    const other = (config: Partial<HeatedBeddingGroupConfig>) => {
      const group = { ...GROUP, ...config };
      return createHeatedBeddingAccessories(
        group,
        new HeatedBeddingSource(heatedBeddingZoneConfigs([group]), () => {
          throw new Error("No writes expected");
        }),
      );
    };
    for (const config of [
      { zones: ["right", "left"] },
      { name: "Renamed" },
      { prefix: "other" },
    ]) {
      const controls = other(config);
      expect(controls.fan.UUID).toBe(bed.fan.UUID);
      expect(controls.preheat.UUID).toBe(bed.preheat.UUID);
    }
    for (const config of [
      { zones: ["left", "middle"] },
      { zones: ["left", "right", "middle"] },
      { controller: "bed2" },
    ]) {
      const controls = other(config);
      expect(controls.fan.UUID).not.toBe(bed.fan.UUID);
      expect(controls.preheat.UUID).not.toBe(bed.preheat.UUID);
    }
  });

  test("getters return No Response until every member is usable", async () => {
    const group = Q(bed);
    type Outcome = PromiseSettledResult<CharacteristicValue | null>;
    const unavailable: [Outcome, Outcome, Outcome] = [
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ];
    expect(
      await Promise.allSettled([
        group.active.handleGetRequest(),
        group.speed.handleGetRequest(),
        group.preheat.handleGetRequest(),
      ]),
    ).toEqual(unavailable);
    source.subscriptionsReady(generation);
    source.handle(generation, "tuya/bridge/availability", "online", true);
    source.handle(generation, "tuya/bed/availability", "online", true);
    report(LEFT_TOPIC, {}, true);
    source.handle(
      generation,
      "tuya/bridge/heartbeat",
      { session_id: "session-a" },
      false,
    );
    expect(Q(left).speed.statusCode).toBe(HAPStatus.SUCCESS);
    expect(group.speed.statusCode).toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    expect(
      await Promise.allSettled([
        group.active.handleGetRequest(),
        group.speed.handleGetRequest(),
        group.preheat.handleGetRequest(),
      ]),
    ).toEqual(unavailable);
    report(RIGHT_TOPIC, {}, true);
    expect(await group.active.handleGetRequest()).toBe(
      Characteristic.Active.INACTIVE,
    );
    expect(await group.speed.handleGetRequest()).toBe(80);
    expect(await group.preheat.handleGetRequest()).toBe(false);
    for (const characteristic of Object.values(group))
      expect(characteristic.statusCode).toBe(HAPStatus.SUCCESS);
  });

  test("the group is unavailable when any member is, and recovers with it", () => {
    ready();
    expect(Q(bed).speed.statusCode).toBe(HAPStatus.SUCCESS);
    source.handle(generation, "tuya/bed/availability", "offline", true);
    for (const controls of [bed, left, right])
      for (const characteristic of Object.values(Q(controls)))
        expect(characteristic.statusCode).toBe(
          HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
    source.handle(generation, "tuya/bed/availability", "online", true);
    report(LEFT_TOPIC, {}, true);
    report(RIGHT_TOPIC, {}, true);
    for (const characteristic of Object.values(Q(bed)))
      expect(characteristic.statusCode).toBe(HAPStatus.SUCCESS);
  });

  test("a member without usable state makes only the group unavailable", () => {
    ready();
    source.handle(
      generation,
      RIGHT_TOPIC,
      { ...RIGHT_STATE, power: null },
      false,
    );
    expect(Q(left).speed.statusCode).toBe(HAPStatus.SUCCESS);
    expect(Q(right).speed.statusCode).toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    expect(Q(bed).speed.statusCode).toBe(
      HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  });

  test.each([
    [false, 3, 8, false, 80],
    [true, 3, 8, false, 30],
    [true, 3, 8, true, 80],
  ])(
    "reports power %s with members at %s and %s (the right one on: %s) as speed %s",
    (leftOn, leftLevel, rightLevel, rightOn, speed) => {
      ready();
      report(LEFT_TOPIC, { power: leftOn, heat_level: leftLevel });
      report(RIGHT_TOPIC, { power: rightOn, heat_level: rightLevel });
      expect(Q(bed).active.value).toBe(
        leftOn || rightOn
          ? Characteristic.Active.ACTIVE
          : Characteristic.Active.INACTIVE,
      );
      expect(Q(bed).speed.value).toBe(speed);
    },
  );

  test("reports preheat while any member preheats", () => {
    ready();
    expect(Q(bed).preheat.value).toBe(false);
    report(RIGHT_TOPIC, { preheat: true });
    expect(Q(bed).preheat.value).toBe(true);
    report(LEFT_TOPIC, { preheat: true });
    report(RIGHT_TOPIC, { preheat: false });
    expect(Q(bed).preheat.value).toBe(true);
    report(LEFT_TOPIC, { preheat: false });
    expect(Q(bed).preheat.value).toBe(false);
  });

  test("Active on powers on only the members that are off", async () => {
    ready();
    report(LEFT_TOPIC, { power: true });
    const write = Q(bed).active.handleSetRequest(Characteristic.Active.ACTIVE);
    flush();
    expect(commands()).toEqual([
      { topic: "tuya/bed/right/set", payload: { power: true } },
    ]);
    await confirm(0);
    expect(await write).toBe(Characteristic.Active.ACTIVE);
    expect(Q(left).speed.value).toBe(30);
    expect(Q(right).speed.value).toBe(80);
    expect(Q(bed).speed.value).toBe(80);
  });

  test("Active on with every member off powers each on at its own level", async () => {
    ready();
    const write = Q(bed).active.handleSetRequest(Characteristic.Active.ACTIVE);
    flush();
    expect(commands()).toEqual([
      { topic: "tuya/bed/left/set", payload: { power: true } },
      { topic: "tuya/bed/right/set", payload: { power: true } },
    ]);
    await confirm(0);
    await confirm(1);
    expect(await write).toBe(Characteristic.Active.ACTIVE);
    expect(Q(left).speed.value).toBe(30);
    expect(Q(right).speed.value).toBe(80);
  });

  test("Active on sends nothing when every member is on", async () => {
    ready();
    report(LEFT_TOPIC, { power: true });
    report(RIGHT_TOPIC, { power: true });
    const write = Q(bed).active.handleSetRequest(Characteristic.Active.ACTIVE);
    flush();
    expect(sent).toHaveLength(0);
    expect(await write).toBe(Characteristic.Active.ACTIVE);
  });

  test("Active off powers off every member, even one that is off, and keeps levels", async () => {
    ready();
    report(LEFT_TOPIC, { power: true });
    const write = Q(bed).active.handleSetRequest(
      Characteristic.Active.INACTIVE,
    );
    flush();
    expect(commands()).toEqual([
      { topic: "tuya/bed/left/set", payload: { power: false } },
      { topic: "tuya/bed/right/set", payload: { power: false } },
    ]);
    await confirm(0);
    await confirm(1);
    expect(await write).toBe(Characteristic.Active.INACTIVE);
    expect(Q(bed).speed.value).toBe(80);
    expect(Q(left).speed.value).toBe(30);
  });

  test("a positive speed sets every member to that level and turns it on", async () => {
    ready();
    report(RIGHT_TOPIC, { power: true });
    const write = Q(bed).speed.handleSetRequest(55);
    expect(Q(bed).speed.value).toBe(80);
    flush();
    expect(commands()).toEqual([
      { topic: "tuya/bed/left/set", payload: { power: true, heat_level: 6 } },
      { topic: "tuya/bed/right/set", payload: { power: true, heat_level: 6 } },
    ]);
    await confirm(0);
    await confirm(1);
    expect(await write).toBe(60);
    expect(Q(bed).active.value).toBe(Characteristic.Active.ACTIVE);
    expect(Q(left).speed.value).toBe(60);
    expect(Q(right).speed.value).toBe(60);
  });

  test("a speed of zero powers off every member and keeps the stored levels", async () => {
    ready();
    report(LEFT_TOPIC, { power: true });
    report(RIGHT_TOPIC, { power: true });
    const write = Q(bed).speed.handleSetRequest(0);
    flush();
    expect(commands()).toEqual([
      { topic: "tuya/bed/left/set", payload: { power: false } },
      { topic: "tuya/bed/right/set", payload: { power: false } },
    ]);
    await confirm(0);
    await confirm(1);
    expect(await write).toBe(80);
    expect(Q(bed).active.value).toBe(Characteristic.Active.INACTIVE);
    expect(Q(left).speed.value).toBe(30);
  });

  test.each([false, true])(
    "an explicit off takes precedence over a speed in the same window, speed first: %s",
    async (speedFirst) => {
      ready();
      const group = Q(bed);
      const writes = speedFirst
        ? [
            group.speed.handleSetRequest(80),
            group.active.handleSetRequest(Characteristic.Active.INACTIVE),
          ]
        : [
            group.active.handleSetRequest(Characteristic.Active.INACTIVE),
            group.speed.handleSetRequest(80),
          ];
      flush();
      expect(commands()).toEqual([
        { topic: "tuya/bed/left/set", payload: { power: false } },
        { topic: "tuya/bed/right/set", payload: { power: false } },
      ]);
      await confirm(0);
      await confirm(1);
      await Promise.all(writes);
      expect(group.active.value).toBe(Characteristic.Active.INACTIVE);
      expect(group.speed.value).toBe(80);
    },
  );

  test("a speed of zero beats Active on in the same window", async () => {
    ready();
    const group = Q(bed);
    const writes = [
      group.active.handleSetRequest(Characteristic.Active.ACTIVE),
      group.speed.handleSetRequest(0),
    ];
    flush();
    expect(commands().map(({ payload }) => payload)).toEqual([
      { power: false },
      { power: false },
    ]);
    await confirm(0);
    await confirm(1);
    await Promise.all(writes);
  });

  test("Active on with a speed in the same window sets every member, even one already on", async () => {
    ready();
    report(LEFT_TOPIC, { power: true });
    const group = Q(bed);
    const writes = [
      group.active.handleSetRequest(Characteristic.Active.ACTIVE),
      group.speed.handleSetRequest(40),
    ];
    flush();
    expect(commands()).toEqual([
      { topic: "tuya/bed/left/set", payload: { power: true, heat_level: 4 } },
      { topic: "tuya/bed/right/set", payload: { power: true, heat_level: 4 } },
    ]);
    await confirm(0);
    await confirm(1);
    expect(await Promise.all(writes)).toEqual([
      Characteristic.Active.ACTIVE,
      40,
    ]);
  });

  test("preheat on preheats every member and off cancels preheat on every member", async () => {
    ready();
    report(LEFT_TOPIC, { preheat: true });
    const on = Q(bed).preheat.handleSetRequest(true);
    expect(commands()).toEqual([
      { topic: "tuya/bed/left/set", payload: { preheat: true } },
      { topic: "tuya/bed/right/set", payload: { preheat: true } },
    ]);
    await confirm(0);
    await confirm(1);
    expect(await on).toBe(true);
    const off = Q(bed).preheat.handleSetRequest(false);
    expect(commands().slice(2)).toEqual([
      { topic: "tuya/bed/left/set", payload: { preheat: false } },
      { topic: "tuya/bed/right/set", payload: { preheat: false } },
    ]);
    await confirm(2);
    await confirm(3);
    expect(await off).toBe(false);
    expect(Q(bed).preheat.value).toBe(false);
  });

  test("a write waits for every member's confirmation", async () => {
    ready();
    let settled = false;
    const write = Q(bed).speed.handleSetRequest(50);
    void write.then(() => {
      settled = true;
    });
    flush();
    await confirm(0);
    await Promise.resolve();
    expect(settled).toBe(false);
    await confirm(1);
    await write;
    expect(settled).toBe(true);
  });

  test.each([
    ["Active", (group: ReturnType<typeof characteristics>) => group.active, 2],
    [
      "RotationSpeed",
      (group: ReturnType<typeof characteristics>) => group.speed,
      -1,
    ],
    [
      "RotationSpeed",
      (group: ReturnType<typeof characteristics>) => group.speed,
      101,
    ],
    [
      "RotationSpeed",
      (group: ReturnType<typeof characteristics>) => group.speed,
      NaN,
    ],
    [
      "RotationSpeed",
      (group: ReturnType<typeof characteristics>) => group.speed,
      "50",
    ],
    [
      "On",
      (group: ReturnType<typeof characteristics>) => group.preheat,
      "true",
    ],
  ])(
    "an invalid %s value fails before any command",
    async (_name, pick, value) => {
      ready();
      expect(
        await Promise.allSettled([pick(Q(bed)).handleSetRequest(value)]),
      ).toEqual([
        { status: "rejected", reason: HAPStatus.INVALID_VALUE_IN_REQUEST },
      ]);
      flush();
      expect(sent).toHaveLength(0);
    },
  );

  test("a write to an unavailable group sends nothing, even to the member that is usable", async () => {
    ready();
    source.handle(
      generation,
      RIGHT_TOPIC,
      { ...RIGHT_STATE, power: null },
      false,
    );
    expect(
      await Promise.allSettled([
        Q(bed).speed.handleSetRequest(50),
        Q(bed).preheat.handleSetRequest(true),
      ]),
    ).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
    flush();
    expect(sent).toHaveLength(0);
    expect(logs).toEqual([]);
  });

  describe("partial failure", () => {
    test("one member's rejection fails the write with its status and logs that zone", async () => {
      ready();
      const write = Promise.allSettled([Q(bed).speed.handleSetRequest(50)]);
      flush();
      await confirm(0);
      fail(1, "invalid_command");
      expect(await write).toEqual([
        { status: "rejected", reason: HAPStatus.INVALID_VALUE_IN_REQUEST },
      ]);
      expect(logs).toMatchObject([
        {
          event: "group_write_failed",
          group: "Bed",
          topic: RIGHT_TOPIC,
          err: { hapStatus: HAPStatus.INVALID_VALUE_IN_REQUEST },
        },
      ]);
      expect(Q(left).speed.value).toBe(50);
      expect(Q(right).speed.value).toBe(80);
      expect(Q(bed).speed.value).toBe(50);
    });

    test("every failing member is logged and the first one in zone order sets the status", async () => {
      ready();
      const write = Promise.allSettled([Q(bed).preheat.handleSetRequest(true)]);
      fail(0, "queue_full");
      fail(1, "invalid_command");
      expect(await write).toEqual([
        { status: "rejected", reason: HAPStatus.RESOURCE_BUSY },
      ]);
      expect(logs).toMatchObject([
        { topic: LEFT_TOPIC, err: { hapStatus: HAPStatus.RESOURCE_BUSY } },
        {
          topic: RIGHT_TOPIC,
          err: { hapStatus: HAPStatus.INVALID_VALUE_IN_REQUEST },
        },
      ]);
    });

    test("a member that times out fails the group at the deadline", async () => {
      ready();
      const write = Promise.allSettled([Q(bed).speed.handleSetRequest(50)]);
      flush();
      await confirm(1);
      now += 8500;
      jest.advanceTimersByTime(8500);
      expect(await write).toEqual([
        { status: "rejected", reason: HAPStatus.OPERATION_TIMED_OUT },
      ]);
      expect(logs).toMatchObject([
        {
          topic: LEFT_TOPIC,
          err: { hapStatus: HAPStatus.OPERATION_TIMED_OUT },
        },
      ]);
    });

    test("a member at its caller limit fails only its own command", async () => {
      ready();
      const crowd = Array.from({ length: 32 }, () =>
        Promise.allSettled([Q(left).preheat.handleSetRequest(true)]),
      );
      const write = Promise.allSettled([Q(bed).preheat.handleSetRequest(true)]);
      expect(commands().slice(32)).toEqual([
        { topic: "tuya/bed/right/set", payload: { preheat: true } },
      ]);
      await confirm(32);
      expect(await write).toEqual([
        { status: "rejected", reason: HAPStatus.RESOURCE_BUSY },
      ]);
      expect(logs).toMatchObject([{ topic: LEFT_TOPIC }]);
      expect(Q(right).preheat.value).toBe(true);
      source.disconnect();
      await Promise.all(crowd);
    });

    test("a cancelled session fails the write for every member", async () => {
      ready();
      const write = Promise.allSettled([Q(bed).speed.handleSetRequest(50)]);
      flush();
      source.handle(
        generation,
        "tuya/bridge/heartbeat",
        { session_id: "session-b" },
        false,
      );
      expect(await write).toEqual([
        { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      ]);
      expect(logs).toHaveLength(2);
    });

    test("an error that is not a HAP status fails the write as a communication failure", async () => {
      source.disconnect();
      const failure = new Error("Injected publish failure");
      const spies = (["log", "warn", "error"] as const).map((method) =>
        jest.spyOn(console, method).mockImplementation(() => {
          /* HAP reports an unhandled handler error */
        }),
      );
      source = new HeatedBeddingSource(
        [LEFT, RIGHT],
        (topic, payload) => {
          if (topic === "tuya/bed/right/set") throw failure;
          sent.push({ topic, payload });
        },
        {
          clock: () => now,
          changed: () => {
            for (const controls of [bed, left, right]) controls.update();
          },
        },
      );
      left = createHeatedBeddingAccessories(LEFT, source);
      right = createHeatedBeddingAccessories(RIGHT, source);
      bed = create(GROUP);
      generation = source.connect();
      ready();
      try {
        const write = Promise.allSettled([
          Q(bed).preheat.handleSetRequest(true),
        ]);
        await confirm(0);
        expect(await write).toEqual([
          {
            status: "rejected",
            reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          },
        ]);
        expect(logs).toMatchObject([
          { topic: RIGHT_TOPIC, err: { message: failure.message } },
        ]);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });

  describe("concurrent group and zone writes", () => {
    test("a zone speed and a group speed in one window coalesce per zone with the later write winning", async () => {
      ready();
      const writes = [
        Q(left).speed.handleSetRequest(80),
        Q(bed).speed.handleSetRequest(30),
      ];
      flush();
      expect(commands()).toEqual([
        { topic: "tuya/bed/left/set", payload: { power: true, heat_level: 3 } },
        {
          topic: "tuya/bed/right/set",
          payload: { power: true, heat_level: 3 },
        },
      ]);
      await confirm(0);
      await confirm(1);
      await Promise.all(writes);
      expect(Q(bed).speed.value).toBe(30);
    });

    test("a zone's explicit off in the group's window beats the group's Active on for that zone only", async () => {
      ready();
      const writes = [
        Q(bed).active.handleSetRequest(Characteristic.Active.ACTIVE),
        Q(left).active.handleSetRequest(Characteristic.Active.INACTIVE),
      ];
      flush();
      expect(commands()).toEqual([
        { topic: "tuya/bed/left/set", payload: { power: false } },
        { topic: "tuya/bed/right/set", payload: { power: true } },
      ]);
      await confirm(0);
      await confirm(1);
      expect(await Promise.all(writes)).toEqual([
        Characteristic.Active.ACTIVE,
        Characteristic.Active.INACTIVE,
      ]);
      expect(Q(left).active.value).toBe(Characteristic.Active.INACTIVE);
      expect(Q(right).active.value).toBe(Characteristic.Active.ACTIVE);
      expect(Q(bed).active.value).toBe(Characteristic.Active.ACTIVE);
    });

    test("the group's Active off beats a zone's speed in the same window", async () => {
      ready();
      const writes = [
        Q(left).speed.handleSetRequest(90),
        Q(bed).active.handleSetRequest(Characteristic.Active.INACTIVE),
      ];
      flush();
      expect(commands().map(({ payload }) => payload)).toEqual([
        { power: false },
        { power: false },
      ]);
      await confirm(0);
      await confirm(1);
      await Promise.all(writes);
      expect(Q(left).speed.value).toBe(30);
    });

    test("a group Active on after a zone's off was sent turns that zone back on", async () => {
      ready();
      report(LEFT_TOPIC, { power: true });
      const off = Q(left).active.handleSetRequest(
        Characteristic.Active.INACTIVE,
      );
      flush();
      const on = Q(bed).active.handleSetRequest(Characteristic.Active.ACTIVE);
      flush();
      expect(commands()).toEqual([
        { topic: "tuya/bed/left/set", payload: { power: false } },
        { topic: "tuya/bed/left/set", payload: { power: true } },
        { topic: "tuya/bed/right/set", payload: { power: true } },
      ]);
      await confirm(0);
      await confirm(1);
      await confirm(2);
      await Promise.all([off, on]);
      expect(Q(left).active.value).toBe(Characteristic.Active.ACTIVE);
      expect(Q(bed).active.value).toBe(Characteristic.Active.ACTIVE);
    });

    test("a group Active on while a zone's power-on is in flight waits for that command", async () => {
      ready();
      const zone = Q(left).speed.handleSetRequest(50);
      flush();
      let settled = false;
      const group = Q(bed).active.handleSetRequest(
        Characteristic.Active.ACTIVE,
      );
      void group.then(() => {
        settled = true;
      });
      flush();
      expect(commands()).toEqual([
        { topic: "tuya/bed/left/set", payload: { power: true, heat_level: 5 } },
        { topic: "tuya/bed/right/set", payload: { power: true } },
      ]);
      await confirm(1);
      await Promise.resolve();
      expect(settled).toBe(false);
      await confirm(0);
      await Promise.all([zone, group]);
      expect(Q(left).speed.value).toBe(50);
    });

    test("a group Active on fails with the zone write it joined", async () => {
      ready();
      const zone = Promise.allSettled([Q(left).speed.handleSetRequest(50)]);
      flush();
      const group = Promise.allSettled([
        Q(bed).active.handleSetRequest(Characteristic.Active.ACTIVE),
      ]);
      flush();
      fail(0, "invalid_command");
      await confirm(1);
      expect(await zone).toEqual([
        { status: "rejected", reason: HAPStatus.INVALID_VALUE_IN_REQUEST },
      ]);
      expect(await group).toEqual([
        { status: "rejected", reason: HAPStatus.INVALID_VALUE_IN_REQUEST },
      ]);
      expect(logs).toMatchObject([{ topic: LEFT_TOPIC }]);
    });

    test("a zone write sent while a group write is in flight confirms on its own", async () => {
      ready();
      const group = Q(bed).speed.handleSetRequest(50);
      flush();
      const zone = Q(right).speed.handleSetRequest(90);
      flush();
      expect(commands()).toEqual([
        { topic: "tuya/bed/left/set", payload: { power: true, heat_level: 5 } },
        {
          topic: "tuya/bed/right/set",
          payload: { power: true, heat_level: 5 },
        },
        {
          topic: "tuya/bed/right/set",
          payload: { power: true, heat_level: 9 },
        },
      ]);
      await confirm(0);
      await confirm(1);
      await confirm(2);
      expect(await zone).toBe(90);
      expect(await group).toBe(50);
      expect(Q(left).speed.value).toBe(50);
      expect(Q(right).speed.value).toBe(90);
      expect(Q(bed).speed.value).toBe(90);
    });

    test("group and zone preheat writes each follow reported state", async () => {
      ready();
      const zone = Q(right).preheat.handleSetRequest(true);
      const group = Q(bed).preheat.handleSetRequest(false);
      expect(commands()).toEqual([
        { topic: "tuya/bed/right/set", payload: { preheat: true } },
        { topic: "tuya/bed/left/set", payload: { preheat: false } },
        { topic: "tuya/bed/right/set", payload: { preheat: false } },
      ]);
      await confirm(0);
      await confirm(1);
      await confirm(2);
      await Promise.all([zone, group]);
      expect(Q(right).preheat.value).toBe(false);
      expect(Q(bed).preheat.value).toBe(false);
    });

    test("callers waiting on a group write count against each member's limit", async () => {
      ready();
      const writes = Array.from({ length: 32 }, () =>
        Promise.allSettled([Q(bed).preheat.handleSetRequest(true)]),
      );
      expect(source.pendingCount(LEFT_TOPIC)).toBe(32);
      expect(source.pendingCount(RIGHT_TOPIC)).toBe(32);
      expect(
        await Promise.allSettled([Q(left).preheat.handleSetRequest(true)]),
      ).toEqual([{ status: "rejected", reason: HAPStatus.RESOURCE_BUSY }]);
      source.disconnect();
      await Promise.all(writes);
      expect(source.pendingCount(LEFT_TOPIC)).toBe(0);
    });
  });
});
