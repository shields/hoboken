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
import { HAPStatus, HapStatusError } from "@homebridge/hap-nodejs";
import {
  MattressSource,
  type MattressPublication,
  type MattressZoneConfig,
} from "../src/mattress-source.ts";

const ZONE: MattressZoneConfig = {
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

describe("mattress source", () => {
  let now: number;
  let source: MattressSource;
  let generation: number;
  let sent: {
    topic: string;
    payload: MattressPublication;
    complete: (error?: Error) => void;
  }[];
  let changed: string[];

  beforeEach(() => {
    jest.useFakeTimers();
    now = 0;
    sent = [];
    changed = [];
    let sequence = 0;
    source = new MattressSource(
      [ZONE],
      (topic, payload, complete) => {
        sent.push({ topic, payload, complete });
      },
      {
        clock: () => now,
        identifier: () => `request-${String(++sequence)}`,
        changed: (topic) => changed.push(topic),
      },
    );
    generation = source.connect();
  });

  afterEach(() => {
    source.disconnect();
    jest.useRealTimers();
  });

  function advance(ms: number): void {
    now += ms;
    jest.advanceTimersByTime(ms);
  }

  function receive(topic: string, payload: unknown, retained = false): void {
    source.handle(generation, topic, payload, retained);
  }

  function ready(): void {
    source.subscriptionsReady(generation);
    receive("tuya/bridge/availability", "online", true);
    receive("tuya/bed/availability", "online", true);
    receive(TOPIC, BASELINE, true);
    receive("tuya/bridge/heartbeat", { session_id: "session-a" });
  }

  test("requires subscriptions, live heartbeat, availability, and matching snapshot", () => {
    expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
    receive("tuya/bridge/availability", "online", true);
    receive("tuya/bed/availability", "online", true);
    receive(TOPIC, BASELINE, true);
    receive("tuya/bridge/heartbeat", { session_id: "session-a" }, true);
    source.subscriptionsReady(generation);
    expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
    receive("tuya/bridge/heartbeat", { session_id: "session-b" });
    expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
    receive(TOPIC, { ...BASELINE, session_id: "session-b" });
    expect(source.getState(TOPIC)).toMatchObject({
      power: false,
      heat_level: 4,
    });
  });

  test("waits for both a confirmed result and the reported requested fields", async () => {
    ready();
    const write = source.writeFan(TOPIC, { speed: 65 });
    let settled = false;
    void write.then(() => {
      settled = true;
    });
    expect(source.getState(TOPIC).heat_level).toBe(4);
    advance(50);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({
      request_id: "request-1",
      power: true,
      heat_level: 7,
    });
    sent[0]!.complete();
    receive(`${TOPIC}/result`, {
      request_id: "request-1",
      outcome: "confirmed",
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    receive(TOPIC, { ...BASELINE, power: true, heat_level: 7 });
    expect(await write).toMatchObject({ power: true, heat_level: 7 });
    expect(source.pendingCount(TOPIC)).toBe(0);
  });

  test("off takes precedence and both callers receive the preserved reported level", async () => {
    ready();
    const writes = [
      source.writeFan(TOPIC, { speed: 80 }),
      source.writeFan(TOPIC, { active: false }),
    ];
    advance(50);
    expect(sent[0]!.payload).toEqual({ request_id: "request-1", power: false });
    receive(`${TOPIC}/result`, {
      request_id: "request-1",
      outcome: "confirmed",
    });
    expect(await Promise.all(writes)).toEqual([
      source.getState(TOPIC),
      source.getState(TOPIC),
    ]);
    expect(source.getState(TOPIC).heat_level).toBe(4);
  });

  test("a broker outage cancels coalesced work without publishing after reconnect", async () => {
    ready();
    const write = source.writeFan(TOPIC, { active: true });
    const outcome = Promise.allSettled([write]);
    source.disconnect();
    generation = source.connect();
    ready();
    advance(50);
    expect(sent).toHaveLength(0);
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
  });

  test("the caller deadline includes coalescing and discards late results", async () => {
    ready();
    const outcome = Promise.allSettled([
      source.writeFan(TOPIC, { active: true }),
    ]);
    advance(50);
    advance(8450);
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.OPERATION_TIMED_OUT },
      },
    ]);
    receive(TOPIC, { ...BASELINE, power: true });
    receive(`${TOPIC}/result`, {
      request_id: "request-1",
      outcome: "confirmed",
    });
    expect(source.pendingCount(TOPIC)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("a preheat write succeeds only after reported confirmation", async () => {
    ready();
    const write = source.writePreheat(TOPIC, true);
    expect(sent[0]!.payload).toEqual({
      request_id: "request-1",
      preheat: true,
    });
    expect(source.getState(TOPIC).preheat).toBe(false);
    receive(TOPIC, { ...BASELINE, preheat: true });
    receive(`${TOPIC}/result`, {
      request_id: "request-1",
      outcome: "confirmed",
    });
    expect((await write).preheat).toBe(true);
    advance(1000);
    expect(source.getState(TOPIC).preheat).toBe(true);
    receive(TOPIC, BASELINE);
    expect(source.getState(TOPIC).preheat).toBe(false);
  });

  test("subscriptions identify retained snapshots and live messages", () => {
    expect(source.topics()).toEqual([
      { topic: "tuya/bridge/availability", live: false },
      { topic: "tuya/bridge/heartbeat", live: true },
      { topic: "tuya/bed/availability", live: false },
      { topic: TOPIC, live: false },
      { topic: `${TOPIC}/result`, live: true },
    ]);
  });

  test("heartbeat expiry invalidates the zone and notifies its accessories", () => {
    ready();
    changed = [];
    advance(45000);
    expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
    expect(changed).toEqual([TOPIC]);
    receive("tuya/bridge/heartbeat", { session_id: "session-a" });
    expect(source.getState(TOPIC).heat_level).toBe(4);
  });

  test("a new session cancels pending work and requires a matching snapshot", async () => {
    ready();
    const outcome = Promise.allSettled([source.writePreheat(TOPIC, true)]);
    receive("tuya/bridge/heartbeat", { session_id: "session-b" });
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
    expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
    receive(TOPIC, { ...BASELINE, session_id: "session-b" });
    expect(source.getState(TOPIC).preheat).toBe(false);
  });

  test.each(["tuya/bridge/availability", "tuya/bed/availability"])(
    "offline at %s cancels pending commands",
    async (topic) => {
      ready();
      const outcome = Promise.allSettled([source.writePreheat(TOPIC, true)]);
      receive(topic, "offline");
      expect(await outcome).toMatchObject([
        {
          status: "rejected",
          reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
        },
      ]);
      expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
    },
  );

  test.each([
    ["invalid_command", HAPStatus.INVALID_VALUE_IN_REQUEST],
    ["queue_full", HAPStatus.RESOURCE_BUSY],
    ["expired", HAPStatus.OPERATION_TIMED_OUT],
    ["confirmation_timeout", HAPStatus.OPERATION_TIMED_OUT],
    ["connection_lost", HAPStatus.SERVICE_COMMUNICATION_FAILURE],
  ])("maps %s to a HAP failure", async (errorCode, status) => {
    ready();
    const outcome = Promise.allSettled([source.writePreheat(TOPIC, true)]);
    receive(`${TOPIC}/result`, {
      request_id: "request-1",
      outcome: "unconfirmed",
      error_code: errorCode,
    });
    expect(await outcome).toMatchObject([
      { status: "rejected", reason: { hapStatus: status } },
    ]);
    expect(source.getState(TOPIC).preheat).toBe(false);
    expect(source.pendingCount(TOPIC)).toBe(0);
  });

  test("retained results cannot confirm a HomeKit write", async () => {
    ready();
    const outcome = Promise.allSettled([source.writePreheat(TOPIC, true)]);
    receive(TOPIC, { ...BASELINE, preheat: true });
    receive(
      `${TOPIC}/result`,
      { request_id: "request-1", outcome: "confirmed" },
      true,
    );
    expect(source.pendingCount(TOPIC)).toBe(1);
    advance(8500);
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.OPERATION_TIMED_OUT },
      },
    ]);
  });

  test("unknown mapped fields remain unavailable and cannot confirm a write", async () => {
    ready();
    const outcome = Promise.allSettled([source.writePreheat(TOPIC, true)]);
    receive(TOPIC, { ...BASELINE, heat_level: null });
    receive(`${TOPIC}/result`, {
      request_id: "request-1",
      outcome: "confirmed",
    });
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
    expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
  });

  test("invalid mapped fields cancel pending work and discard the invalid snapshot", async () => {
    ready();
    const outcome = Promise.allSettled([source.writePreheat(TOPIC, true)]);
    expect(() => {
      receive(TOPIC, { ...BASELINE, power: "ON" });
    }).toThrow(RangeError);
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
    expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
  });

  test("transport publication failure disconnects without replay", async () => {
    let failed = 0;
    source.disconnect();
    source = new MattressSource(
      [ZONE],
      (topic, payload, complete) => {
        sent.push({ topic, payload, complete });
      },
      {
        clock: () => now,
        failed: () => {
          failed++;
        },
      },
    );
    generation = source.connect();
    ready();
    const outcome = Promise.allSettled([source.writePreheat(TOPIC, true)]);
    sent[0]!.complete(new Error("Connection lost"));
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
    expect(failed).toBe(1);
    generation = source.connect();
    ready();
    sent[0]!.complete(new Error("Late failure"));
    expect(source.getState(TOPIC).power).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("a stalled coalescing window expires before publication", async () => {
    ready();
    const outcome = Promise.allSettled([source.writeFan(TOPIC, { speed: 50 })]);
    advance(8500);
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.OPERATION_TIMED_OUT },
      },
    ]);
    expect(sent).toHaveLength(0);
  });

  test("stale heartbeat at flush refuses publication", async () => {
    ready();
    now = 44980;
    const outcome = Promise.allSettled([
      source.writeFan(TOPIC, { active: true }),
    ]);
    advance(50);
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
    expect(sent).toHaveLength(0);
  });

  test("no command is buffered before usable state exists", async () => {
    const outcome = await Promise.allSettled([
      source.writeFan(TOPIC, { active: true }),
      source.writePreheat(TOPIC, true),
    ]);
    expect(outcome).toMatchObject([
      { status: "rejected" },
      { status: "rejected" },
    ]);
    ready();
    advance(50);
    expect(sent).toHaveLength(0);
    expect(source.pendingCount(TOPIC)).toBe(0);
  });

  test("bounded callers reject overload without evicting existing requests", async () => {
    ready();
    const writes = Array.from({ length: 32 }, () =>
      source.writeFan(TOPIC, { speed: 20 }),
    );
    const outcomes = Promise.allSettled(writes);
    expect(
      await Promise.allSettled([source.writePreheat(TOPIC, true)]),
    ).toMatchObject([
      { status: "rejected", reason: { hapStatus: HAPStatus.RESOURCE_BUSY } },
    ]);
    expect(source.pendingCount(TOPIC)).toBe(32);
    advance(50);
    expect(sent).toHaveLength(1);
    receive(TOPIC, { ...BASELINE, power: true, heat_level: 2 });
    receive(`${TOPIC}/result`, {
      request_id: "request-1",
      outcome: "confirmed",
    });
    expect(
      (await outcomes).every((result) => result.status === "fulfilled"),
    ).toBe(true);
    expect(source.pendingCount(TOPIC)).toBe(0);
  });

  test("stale connection events cannot restore liveness", () => {
    ready();
    const oldGeneration = generation;
    source.disconnect();
    source.handle(oldGeneration, TOPIC, BASELINE, false);
    source.subscriptionsReady(oldGeneration);
    generation = source.connect();
    source.subscriptionsReady(oldGeneration);
    source.handle(oldGeneration, TOPIC, BASELINE, false);
    expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
    ready();
    receive("unrelated/topic", {});
    expect(source.getState(TOPIC).heat_level).toBe(4);
  });

  test("duplicate and conflicting configured topic routes fail immediately", () => {
    const publish = (): void => {
      throw new Error("A duplicate configuration must not publish");
    };
    expect(() => new MattressSource([ZONE, ZONE], publish)).toThrow(RangeError);
    expect(
      () => new MattressSource([{ ...ZONE, controller: "bridge" }], publish),
    ).toThrow(RangeError);
    expect(() => source.getState("unknown/zone")).toThrow(RangeError);
  });

  test("separate windows use new request IDs", async () => {
    ready();
    const first = source.writeFan(TOPIC, { speed: 20 });
    advance(50);
    receive(TOPIC, { ...BASELINE, power: true, heat_level: 2 });
    receive(`${TOPIC}/result`, {
      request_id: "request-1",
      outcome: "confirmed",
    });
    await first;
    const second = source.writeFan(TOPIC, { active: false });
    advance(50);
    expect(sent[1]!.payload).toEqual({ request_id: "request-2", power: false });
    receive(TOPIC, { ...BASELINE, heat_level: 2 });
    receive(`${TOPIC}/result`, {
      request_id: "request-2",
      outcome: "confirmed",
    });
    expect((await second).heat_level).toBe(2);
  });

  test("a duplicate generated identifier cannot overwrite another command or leak admission", async () => {
    source.disconnect();
    source = new MattressSource(
      [ZONE],
      (topic, payload, complete) => {
        sent.push({ topic, payload, complete });
      },
      { clock: () => now, identifier: () => "same-id" },
    );
    generation = source.connect();
    ready();
    const first = source.writePreheat(TOPIC, true);
    expect(
      await Promise.allSettled([source.writePreheat(TOPIC, false)]),
    ).toMatchObject([
      {
        status: "rejected",
        reason: new Error("Duplicate generated mattress request ID"),
      },
    ]);
    expect(source.pendingCount(TOPIC)).toBe(1);
    expect(sent).toHaveLength(1);
    const fanOutcomes = Promise.allSettled([
      source.writeFan(TOPIC, { speed: 20 }),
      source.writeFan(TOPIC, { active: true }),
    ]);
    advance(50);
    expect(await fanOutcomes).toMatchObject([
      {
        status: "rejected",
        reason: new Error("Duplicate generated mattress request ID"),
      },
      {
        status: "rejected",
        reason: new Error("Duplicate generated mattress request ID"),
      },
    ]);
    expect(source.pendingCount(TOPIC)).toBe(1);
    expect(sent).toHaveLength(1);
    receive(TOPIC, { ...BASELINE, preheat: true });
    receive(`${TOPIC}/result`, { request_id: "same-id", outcome: "confirmed" });
    await first;
    expect(source.pendingCount(TOPIC)).toBe(0);
  });

  test.each(["identifier", "publisher"])(
    "a synchronous %s failure rejects coalesced callers and frees admission",
    async (boundary) => {
      source.disconnect();
      const failure = new Error("Injected boundary failure");
      let broken = true;
      source = new MattressSource(
        [ZONE],
        (topic, payload, complete) => {
          if (broken && boundary === "publisher") throw failure;
          sent.push({ topic, payload, complete });
        },
        {
          clock: () => now,
          identifier: () => {
            if (broken && boundary === "identifier") throw failure;
            return "recovered-id";
          },
        },
      );
      generation = source.connect();
      ready();
      const outcomes = Promise.allSettled([
        source.writeFan(TOPIC, { speed: 20 }),
        source.writeFan(TOPIC, { active: true }),
      ]);
      advance(50);
      expect(await outcomes).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      expect(source.pendingCount(TOPIC)).toBe(0);
      broken = false;
      const recovered = source.writePreheat(TOPIC, true);
      receive(TOPIC, { ...BASELINE, preheat: true });
      receive(`${TOPIC}/result`, {
        request_id: "recovered-id",
        outcome: "confirmed",
      });
      await recovered;
      expect(source.pendingCount(TOPIC)).toBe(0);
    },
  );

  test("both sides share controller availability while another controller remains usable", async () => {
    source.disconnect();
    const right: MattressZoneConfig = { ...ZONE, zone: "right" };
    const other: MattressZoneConfig = { ...ZONE, controller: "other" };
    let sequence = 0;
    source = new MattressSource(
      [ZONE, right, other],
      (topic, payload, complete) => {
        sent.push({ topic, payload, complete });
      },
      { clock: () => now, identifier: () => `request-${String(++sequence)}` },
    );
    generation = source.connect();
    ready();
    receive("tuya/bed/right", BASELINE);
    receive("tuya/other/availability", "online");
    receive("tuya/other/left", BASELINE);
    const first = source.writePreheat(TOPIC, true);
    const second = source.writePreheat("tuya/bed/right", true);
    const outcomes = Promise.allSettled([first, second]);
    receive(TOPIC, { ...BASELINE, preheat: true });
    receive("tuya/bed/right/result", {
      request_id: "request-1",
      outcome: "confirmed",
    });
    expect(source.pendingCount(TOPIC)).toBe(1);
    receive("tuya/bed/availability", "offline");
    expect(
      (await outcomes).every((result) => result.status === "rejected"),
    ).toBe(true);
    expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
    expect(() => source.getState("tuya/bed/right")).toThrow(HapStatusError);
    expect(source.getState("tuya/other/left").heat_level).toBe(4);
  });

  test.each(["tuya/bridge/availability", "tuya/bed/availability"])(
    "invalid availability at %s fails closed",
    (topic) => {
      ready();
      expect(() => {
        receive(topic, "unknown");
      }).toThrow(RangeError);
      expect(() => source.getState(TOPIC)).toThrow(HapStatusError);
    },
  );
});
