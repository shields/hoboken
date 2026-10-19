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

import { describe, expect, test } from "bun:test";
import {
  aggregateHeatedBeddingStates,
  coalesceHeatedBeddingFanWrites,
  heatedBeddingIdentity,
  heatedBeddingResumeOnly,
  heatedBeddingTopic,
  heatedBeddingTopics,
  normalizeHeatedBeddingSpeed,
  parseHeatedBeddingHeartbeat,
  parseHeatedBeddingResult,
  parseHeatedBeddingState,
  sortedHeatedBeddingZones,
} from "../src/heated-bedding-profile.ts";

describe("heated bedding zone topic", () => {
  test("joins prefix, controller, and zone", () => {
    expect(
      heatedBeddingTopic({
        prefix: "home/tuya",
        controller: "bed",
        zone: "side_a",
      }),
    ).toBe("home/tuya/bed/side_a");
  });
});

describe("heated bedding entry topics and identity", () => {
  test("a single zone has one topic and a group has one per zone in order", () => {
    const base = { prefix: "home/tuya", controller: "bed" };
    expect(heatedBeddingTopics({ ...base, zone: "side_a" })).toEqual([
      "home/tuya/bed/side_a",
    ]);
    expect(
      heatedBeddingTopics({ ...base, zones: ["side_b", "side_a"] }),
    ).toEqual(["home/tuya/bed/side_b", "home/tuya/bed/side_a"]);
  });

  test("a group's identity ignores zone order and differs from every single zone", () => {
    expect(
      heatedBeddingIdentity({
        controller: "bed",
        zones: ["side_b", "side_a"],
      }),
    ).toBe(
      heatedBeddingIdentity({
        controller: "bed",
        zones: ["side_a", "side_b"],
      }),
    );
    const identities = [
      heatedBeddingIdentity({ controller: "bed", zone: "side_a" }),
      heatedBeddingIdentity({ controller: "bed", zone: "side_b" }),
      heatedBeddingIdentity({ controller: "bed2", zone: "side_a" }),
      heatedBeddingIdentity({
        controller: "bed",
        zones: ["side_a", "side_b"],
      }),
      heatedBeddingIdentity({
        controller: "bed2",
        zones: ["side_a", "side_b"],
      }),
      heatedBeddingIdentity({
        controller: "bed",
        zones: ["side_a", "side_c"],
      }),
    ];
    expect(new Set(identities).size).toBe(identities.length);
  });

  test("zones sort by code unit whatever the locale", () => {
    expect(sortedHeatedBeddingZones(["a_1", "b", "a1", "a"])).toEqual([
      "a",
      "a1",
      "a_1",
      "b",
    ]);
    const zones = ["b", "a"];
    sortedHeatedBeddingZones(zones);
    expect(zones).toEqual(["b", "a"]);
  });
});

describe("heated bedding group state", () => {
  const state = (power: boolean, level: number, preheat = false) => ({
    power,
    heat_level: level,
    preheat,
  });

  test("a single state aggregates to itself", () => {
    expect(aggregateHeatedBeddingStates([state(true, 3, true)])).toEqual(
      state(true, 3, true),
    );
    expect(aggregateHeatedBeddingStates([state(false, 3)])).toEqual(
      state(false, 3),
    );
  });

  test("the group is on when any member is on", () => {
    expect(
      aggregateHeatedBeddingStates([state(false, 4), state(true, 2)]).power,
    ).toBe(true);
    expect(
      aggregateHeatedBeddingStates([state(true, 2), state(false, 4)]).power,
    ).toBe(true);
    expect(
      aggregateHeatedBeddingStates([state(false, 4), state(false, 2)]).power,
    ).toBe(false);
  });

  test("the speed is the highest level among members that are on", () => {
    expect(
      aggregateHeatedBeddingStates([
        state(true, 2),
        state(false, 9),
        state(true, 5),
      ]).heat_level,
    ).toBe(5);
  });

  test("the speed is the highest stored level while every member is off", () => {
    expect(
      aggregateHeatedBeddingStates([
        state(false, 2),
        state(false, 9),
        state(false, 5),
      ]).heat_level,
    ).toBe(9);
  });

  test("the group preheats when any member does", () => {
    expect(
      aggregateHeatedBeddingStates([state(false, 1), state(false, 1, true)])
        .preheat,
    ).toBe(true);
    expect(
      aggregateHeatedBeddingStates([state(false, 1), state(true, 1)]).preheat,
    ).toBe(false);
  });

  test("an empty group has no state", () => {
    expect(() => aggregateHeatedBeddingStates([])).toThrow(RangeError);
  });
});

describe("heated bedding speed", () => {
  test.each([
    [0, 0],
    [0.1, 10],
    [5, 10],
    [14.999, 10],
    [15, 20],
    [24.999, 20],
    [25, 30],
    [94.999, 90],
    [95, 100],
    [100, 100],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeHeatedBeddingSpeed(input)).toBe(expected);
  });

  test("preserves each supported level", () => {
    for (let level = 1; level <= 10; level++) {
      expect(normalizeHeatedBeddingSpeed(level * 10)).toBe(level * 10);
    }
  });

  test.each([-0.1, 100.1, NaN, Infinity, -Infinity])(
    "rejects invalid speed %s",
    (value) => {
      expect(() => normalizeHeatedBeddingSpeed(value)).toThrow(RangeError);
    },
  );
});

describe("heated bedding fan command", () => {
  test("Active-on preserves the selected level", () => {
    expect(coalesceHeatedBeddingFanWrites([{ active: true }])).toEqual({
      power: true,
    });
  });

  test("a positive speed sends power and normalized level together", () => {
    expect(coalesceHeatedBeddingFanWrites([{ speed: 65 }])).toEqual({
      power: true,
      heat_level: 7,
    });
  });

  test("the last positive speed wins in a window", () => {
    expect(
      coalesceHeatedBeddingFanWrites([
        { speed: 20 },
        { active: true },
        { speed: 85 },
      ]),
    ).toEqual({
      power: true,
      heat_level: 9,
    });
  });

  test("a combined active and speed write applies both fields", () => {
    expect(
      coalesceHeatedBeddingFanWrites([{ active: true, speed: 50 }]),
    ).toEqual({
      power: true,
      heat_level: 5,
    });
    expect(
      coalesceHeatedBeddingFanWrites([{ active: true, speed: 0 }]),
    ).toEqual({
      power: false,
    });
    expect(
      coalesceHeatedBeddingFanWrites([{ active: false, speed: 50 }]),
    ).toEqual({
      power: false,
    });
  });

  test.each(
    [
      [{ active: false }, { speed: 80 }],
      [{ speed: 80 }, { active: false }],
      [{ speed: 0 }, { active: true }],
      [{ active: true }, { speed: 0 }],
      [{ active: false }, { active: true }],
      [{ speed: 0 }, { speed: 90 }],
    ].map((writes) => [writes] as const),
  )("an explicit off preserves level regardless of ordering: %j", (writes) => {
    expect(coalesceHeatedBeddingFanWrites(writes)).toEqual({ power: false });
  });

  test("a resume asks for power without a level", () => {
    expect(coalesceHeatedBeddingFanWrites([{ resume: true }])).toEqual({
      power: true,
    });
    expect(heatedBeddingResumeOnly([{ resume: true }, { resume: true }])).toBe(
      true,
    );
  });

  test.each([
    [{ active: true }],
    [{ active: false }],
    [{ speed: 50 }],
    [{ speed: 0 }],
  ])("a resume with %j is not resume-only", (write) => {
    expect(heatedBeddingResumeOnly([{ resume: true }, write])).toBe(false);
  });

  test("a resume yields to a speed or an explicit off in its window", () => {
    expect(
      coalesceHeatedBeddingFanWrites([{ resume: true }, { speed: 50 }]),
    ).toEqual({ power: true, heat_level: 5 });
    expect(
      coalesceHeatedBeddingFanWrites([{ resume: true }, { active: false }]),
    ).toEqual({ power: false });
    expect(
      coalesceHeatedBeddingFanWrites([{ resume: true }, { speed: 0 }]),
    ).toEqual({ power: false });
  });

  test("an empty window cannot produce a command", () => {
    expect(() => coalesceHeatedBeddingFanWrites([])).toThrow(RangeError);
  });

  test("an off does not hide another invalid write", () => {
    expect(() =>
      coalesceHeatedBeddingFanWrites([{ active: false }, { speed: NaN }]),
    ).toThrow(RangeError);
  });
});

describe("heated bedding reported state", () => {
  test("keeps only the MQTT contract fields", () => {
    expect(
      parseHeatedBeddingState({
        session_id: "session-a",
        power: false,
        heat_level: 4,
        preheat: true,
        auto_off_seconds: 86400,
        remaining_seconds: 0,
        preheat_remaining_seconds: 120,
        unrelated: { private_value: "discard" },
      }),
    ).toEqual({
      session_id: "session-a",
      power: false,
      heat_level: 4,
      preheat: true,
      auto_off_seconds: 86400,
      remaining_seconds: 0,
      preheat_remaining_seconds: 120,
    });
  });

  test.each([undefined, null])("missing fields remain unknown: %s", (value) => {
    expect(
      parseHeatedBeddingState({
        session_id: "session-a",
        power: value,
        heat_level: value,
        preheat: value,
      }),
    ).toEqual({
      session_id: "session-a",
      power: null,
      heat_level: null,
      preheat: null,
      auto_off_seconds: null,
      remaining_seconds: null,
      preheat_remaining_seconds: null,
    });
  });

  test.each([
    { power: 0 },
    { preheat: "false" },
    { heat_level: true },
    { heat_level: 0 },
    { heat_level: 11 },
    { heat_level: 1.5 },
    { heat_level: Infinity },
    { auto_off_seconds: 0 },
    { remaining_seconds: -1 },
    { preheat_remaining_seconds: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid mapped state %j", (fields) => {
    expect(() =>
      parseHeatedBeddingState({ session_id: "session-a", ...fields }),
    ).toThrow(RangeError);
  });
});

describe("heated bedding session and command result", () => {
  test("extracts the heartbeat session without copying other fields", () => {
    expect(
      parseHeatedBeddingHeartbeat({ session_id: "session-a", unrelated: true }),
    ).toBe("session-a");
  });

  test.each(
    [
      null,
      [],
      "session-a",
      1,
      {},
      { session_id: "" },
      { session_id: " " },
      { session_id: " session-a " },
      { session_id: 1 },
      { session_id: "a".repeat(129) },
    ].map((value) => [value] as const),
  )("rejects malformed heartbeat %j", (value) => {
    expect(() => parseHeatedBeddingHeartbeat(value)).toThrow(RangeError);
  });

  test("parses a confirmed result", () => {
    expect(
      parseHeatedBeddingResult({
        request_id: "write-1",
        outcome: "confirmed",
        unrelated: true,
      }),
    ).toEqual({ request_id: "write-1", outcome: "confirmed" });
  });

  test("accepts an explicit null error on a confirmed result", () => {
    expect(
      parseHeatedBeddingResult({
        request_id: "write-1",
        outcome: "confirmed",
        error_code: null,
      }),
    ).toEqual({ request_id: "write-1", outcome: "confirmed" });
  });

  test.each(["rejected", "unconfirmed"])("parses %s results", (outcome) => {
    expect(
      parseHeatedBeddingResult({
        request_id: "write-1",
        outcome,
        error_code: "unavailable",
      }),
    ).toEqual({ request_id: "write-1", outcome, error_code: "unavailable" });
  });

  test.each([
    null,
    { request_id: "write-1", outcome: "accepted" },
    { request_id: "", outcome: "confirmed" },
    { request_id: "a".repeat(129), outcome: "confirmed" },
    { request_id: "write-1", outcome: "rejected" },
    { request_id: "write-1", outcome: "unconfirmed", error_code: 1 },
    {
      request_id: "write-1",
      outcome: "unconfirmed",
      error_code: "a".repeat(65),
    },
    { request_id: "write-1", outcome: "confirmed", error_code: "unavailable" },
  ])("rejects malformed result %j", (value) => {
    expect(() => parseHeatedBeddingResult(value)).toThrow(RangeError);
  });
});
