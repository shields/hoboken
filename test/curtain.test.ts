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

import { afterEach, describe, expect, jest, test } from "bun:test";
import { Characteristic, Service } from "@homebridge/hap-nodejs";
import { parseCurtainState, curtainMotion } from "../src/curtain-profile.ts";
import { CurtainSource } from "../src/curtain-source.ts";
import { createCurtainAccessory } from "../src/curtain-accessories.ts";
import { validateConfig } from "../src/config.ts";
import { CurtainMQTT } from "../src/curtain-mqtt.ts";
import { INVALID_MQTT_URL, MALFORMED_MQTT_URLS, SECRET } from "./mqtt-urls.ts";

const endpoint = {
  name: "Curtain",
  prefix: "tuya",
  controller: "window",
};
const topic = "tuya/window";
const baseline = {
  session_id: "s",
  current_position: 20,
  target_position: 80,
  motion: null,
};

function harness() {
  const sent: { target_position?: number; request_id: string }[] = [];
  const topics: string[] = [];
  const source = new CurtainSource([endpoint], (topic, payload, complete) => {
    topics.push(topic);
    sent.push(payload);
    complete();
  });
  const generation = source.connect();
  source.subscriptionsReady(generation);
  const report = (state = baseline) => {
    source.handle(generation, topic, state, false);
  };
  const result = (index: number) => {
    source.handle(
      generation,
      `${topic}/result`,
      { request_id: sent[index]!.request_id, outcome: "confirmed" },
      false,
    );
  };
  source.handle(generation, "tuya/bridge/availability", "online", false);
  source.handle(generation, "tuya/window/availability", "online", false);
  source.handle(
    generation,
    "tuya/bridge/heartbeat",
    { session_id: "s" },
    false,
  );
  report();
  return { source, sent, topics, report, result, generation };
}

afterEach(() => jest.useRealTimers());

describe("curtain profile", () => {
  test("requires reported positions and infers motion", () => {
    expect(parseCurtainState({ session_id: "s" })).toBeUndefined();
    expect(
      parseCurtainState({ ...baseline, target_position: null }),
    ).toBeUndefined();
    expect(curtainMotion(parseCurtainState(baseline)!)).toBe("opening");
    expect(
      curtainMotion(parseCurtainState({ ...baseline, target_position: 0 })!),
    ).toBe("closing");
    expect(
      curtainMotion(parseCurtainState({ ...baseline, target_position: 20 })!),
    ).toBe("stopped");
    expect(
      curtainMotion(parseCurtainState({ ...baseline, motion: "stopped" })!),
    ).toBe("stopped");
  });
  test.each([
    null,
    1,
    { ...baseline, session_id: "" },
    { ...baseline, current_position: true },
    { ...baseline, target_position: 101 },
    { ...baseline, motion: "fast" },
  ])("rejects malformed state %j", (value) => {
    expect(() => parseCurtainState(value)).toThrow();
  });
});

describe("curtain source and accessory", () => {
  test("uses the controller's own topics, with no zone", async () => {
    const h = harness();
    expect(h.source.topics()).toEqual([
      { topic: "tuya/bridge/availability", live: false },
      { topic: "tuya/bridge/heartbeat", live: true },
      { topic: "tuya/window/availability", live: false },
      { topic: "tuya/window", live: false },
      { topic: "tuya/window/result", live: true },
    ]);
    const write = h.source.writePosition(topic, 90);
    expect(h.topics).toEqual(["tuya/window/set"]);
    h.source.disconnect();
    expect(await Promise.allSettled([write])).toMatchObject([
      { status: "rejected" },
    ]);
  });
  test("derives the accessory identity from the controller alone", () => {
    const h = harness();
    const uuid = (config: typeof endpoint) =>
      createCurtainAccessory(config, h.source).accessory.UUID;
    expect(uuid({ ...endpoint, name: "Renamed", prefix: "other" })).toBe(
      uuid(endpoint),
    );
    expect(uuid({ ...endpoint, controller: "door" })).not.toBe(uuid(endpoint));
    h.source.disconnect();
  });
  test("confirms a target before arrival", async () => {
    const h = harness();
    const accessory = createCurtainAccessory(endpoint, h.source);
    const service = accessory.accessory.getService(Service.WindowCovering)!;
    expect(
      await service
        .getCharacteristic(Characteristic.CurrentPosition)
        .handleGetRequest(),
    ).toBe(20);
    expect(
      await service
        .getCharacteristic(Characteristic.TargetPosition)
        .handleGetRequest(),
    ).toBe(80);
    expect(
      await service
        .getCharacteristic(Characteristic.PositionState)
        .handleGetRequest(),
    ).toBe(1);
    const target = service
      .getCharacteristic(Characteristic.TargetPosition)
      .handleSetRequest(90);
    expect(h.sent[0]!.target_position).toBe(90);
    h.report({ ...baseline, target_position: 90 });
    h.result(0);
    await target;
    expect(h.source.getState(topic).current_position).toBe(20);
    expect(service.testCharacteristic(Characteristic.HoldPosition)).toBe(false);
    h.report({ ...baseline, current_position: 35, target_position: 0 });
    accessory.update();
    expect(
      await service
        .getCharacteristic(Characteristic.PositionState)
        .handleGetRequest(),
    ).toBe(0);
    h.report({ ...baseline, current_position: 90, target_position: 90 });
    accessory.update();
    expect(
      await service
        .getCharacteristic(Characteristic.PositionState)
        .handleGetRequest(),
    ).toBe(2);
    h.source.disconnect();
    accessory.update();
    expect(
      await Promise.allSettled([
        service
          .getCharacteristic(Characteristic.CurrentPosition)
          .handleGetRequest(),
      ]),
    ).toMatchObject([{ status: "rejected" }]);
  });
  test.each([-1, 101, 1.5, NaN, true])("rejects target %s", async (value) => {
    const h = harness();
    const accessory = createCurtainAccessory(endpoint, h.source);
    expect(
      await Promise.allSettled([
        accessory.accessory
          .getService(Service.WindowCovering)!
          .getCharacteristic(Characteristic.TargetPosition)
          .handleSetRequest(value),
      ]),
    ).toMatchObject([{ status: "rejected" }]);
    expect(h.sent).toHaveLength(0);
    h.source.disconnect();
  });
  test("ignores retained confirmation and rejects on disconnect", async () => {
    const h = harness();
    const write = h.source.writePosition(topic, 100);
    h.source.handle(
      h.generation,
      `${topic}/result`,
      { request_id: h.sent[0]!.request_id, outcome: "confirmed" },
      true,
    );
    expect(h.source.pendingCount(topic)).toBe(1);
    h.source.disconnect();
    expect(await Promise.allSettled([write])).toMatchObject([
      { status: "rejected" },
    ]);
  });
});

describe("curtain configuration", () => {
  const config = {
    bridge: {
      name: "Hoboken",
      mac: "0E:42:A1:B2:C3:D4",
      pincode: "031-45-154",
      port: 51826,
    },
    mqtt: { url: "mqtt://localhost" },
    curtains: [endpoint],
  };
  test("allows curtains alone", () => {
    expect(validateConfig(config).devices).toEqual([]);
    expect(validateConfig(config).curtains).toEqual([endpoint]);
  });
  test.each([
    [null],
    [[null]],
    [[{ ...endpoint, extra: true }]],
    [[endpoint, endpoint]],
  ])("rejects invalid curtains %j", (curtains) => {
    expect(() => validateConfig({ ...config, curtains })).toThrow();
  });
});

describe("curtain MQTT owner", () => {
  function failure(create: () => unknown): Error & { code?: unknown } {
    try {
      create();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the call to throw");
  }

  test.each(MALFORMED_MQTT_URLS)(
    "refuses %j without connecting or quoting it",
    (url) => {
      const connect = jest.fn();
      expect(
        failure(() => new CurtainMQTT(url, [endpoint], { connect })),
      ).toStrictEqual(new Error(INVALID_MQTT_URL));
      expect(connect).not.toHaveBeenCalled();
    },
  );

  test("rethrows an error from creating the client without its message", () => {
    const error = failure(
      () =>
        new CurtainMQTT("mqtt://localhost", [endpoint], {
          connect: () => {
            throw Object.assign(
              new Error(
                `The argument 'url' mqtt://user:${SECRET}@localhost:1x`,
              ),
              { code: "ERR_INVALID_ARG_VALUE" },
            );
          },
        }),
    );
    expect(error.message).toBe("MQTT client could not be started");
    expect(error.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(error.stack).not.toContain(SECRET);
  });
});
