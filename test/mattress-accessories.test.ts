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
} from "@homebridge/hap-nodejs";
import {
  createMattressAccessories,
  type MattressAccessories,
} from "../src/mattress-accessories.ts";
import {
  MattressSource,
  type MattressPublication,
  type MattressZoneConfig,
} from "../src/mattress-source.ts";

const CONFIG: MattressZoneConfig = {
  name: "Left pad",
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

describe("mattress HomeKit accessories", () => {
  let source: MattressSource;
  let controls: MattressAccessories;
  let generation: number;
  let now: number;
  let sent: MattressPublication[];

  beforeEach(() => {
    jest.useFakeTimers();
    now = 0;
    sent = [];
    let sequence = 0;
    source = new MattressSource(
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
    controls = createMattressAccessories(CONFIG, source);
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
    const renamed = createMattressAccessories(
      { ...CONFIG, name: "Renamed", prefix: "other" },
      new MattressSource([{ ...CONFIG, prefix: "other" }], () => {
        throw new Error("No writes expected");
      }),
    );
    expect(renamed.fan.UUID).toBe(controls.fan.UUID);
    expect(renamed.preheat.UUID).toBe(controls.preheat.UUID);
    const rightConfig = { ...CONFIG, zone: "right" };
    const right = createMattressAccessories(
      rightConfig,
      new MattressSource([rightConfig], () => {
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
