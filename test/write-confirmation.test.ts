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
  changedGroups,
  CONFIRMATION_MS,
  expireWrites,
  groupValues,
  nextDeadline,
  overlayOf,
  recordWrite,
  settleReport,
  withoutWritten,
  writtenGroups,
} from "../src/write-confirmation.ts";

describe("recordWrite", () => {
  test("a group is written by any of its keys, each with its own deadline", () => {
    expect(recordWrite({}, { on: true }, 100)).toEqual({
      power: {
        deadline: 100 + CONFIRMATION_MS,
        written: true,
        overlay: { on: true },
      },
    });
    expect(recordWrite({}, { brightness: 0 }, 100)).toEqual({
      power: { deadline: 2100, written: false, overlay: { on: false } },
      brightness: { deadline: 2100, written: true, overlay: {} },
    });
    for (const key of ["hue", "saturation"])
      expect(recordWrite({}, { [key]: 1 }, 0)).toEqual({
        color: { deadline: 2000, written: true, overlay: {} },
      });
    expect(recordWrite({}, { color_temp: 350, hue: 1 }, 0)).toEqual({
      color: { deadline: 2000, written: true, overlay: { color_temp: 350 } },
    });
    expect(recordWrite({}, { scene_recall: 1 }, 0)).toEqual({});
  });

  test("a write of a group restarts its deadline and leaves the others", () => {
    const first = recordWrite({}, { on: true, hue: 1 }, 0);
    const second = recordWrite(first, { on: false }, 500);
    expect(second.power).toEqual({
      deadline: 2500,
      written: true,
      overlay: { on: false },
    });
    expect(second.color).toBe(first.color);
  });

  test("a power that a brightness implies keeps the deadline of a written power", () => {
    const first = recordWrite({}, { on: true }, 0);
    expect(recordWrite(first, { brightness: 0 }, 500).power).toEqual({
      deadline: 2000,
      written: true,
      overlay: { on: false },
    });
  });

  test("a power that a brightness implies replaces an implied one with a new deadline", () => {
    const first = recordWrite({}, { brightness: 10 }, 0);
    expect(recordWrite(first, { brightness: 10 }, 500).power).toEqual({
      deadline: 2500,
      written: false,
      overlay: { on: true },
    });
  });

  test("a power of no boolean has no overlay", () => {
    expect(recordWrite({}, { on: "yes" }, 0).power).toEqual({
      deadline: 2000,
      written: true,
      overlay: {},
    });
  });
});

describe("settleReport", () => {
  const written = (payload: Record<string, unknown>) =>
    recordWrite({}, payload, 0);

  test("values equal to the previous report's are withheld", () => {
    const { applied, pending } = settleReport(
      written({ on: true, brightness: 60, hue: 1 }),
      { on: false, brightness: 100, hue: 30, saturation: 40 },
      { on: false, brightness: 100, hue: 30, saturation: 40 },
    );
    expect(applied).toEqual({});
    expect(Object.keys(pending)).toEqual(["power", "brightness", "color"]);
  });

  test("one value that differs confirms its group and applies all of its values", () => {
    const { applied, pending } = settleReport(
      written({ hue: 1, brightness: 5 }),
      { hue: 30, saturation: 41, brightness: 100, on: true },
      { hue: 30, saturation: 40, brightness: 100, on: false },
    );
    expect(applied).toEqual({
      hue: 30,
      saturation: 41,
      on: true,
    });
    expect(Object.keys(pending)).toEqual(["brightness"]);
  });

  test("a group that the report has no values for keeps its status", () => {
    const pending = written({ on: true, hue: 1 });
    const previous = { on: false, hue: 30, brightness: 4 };
    const result = settleReport(pending, { brightness: 3 }, previous);
    expect(result.applied).toEqual({ brightness: 3 });
    expect(result.pending).toEqual(pending);
    expect(settleReport(pending, { brightness: 3 }, undefined).pending).toEqual(
      pending,
    );
  });

  test("a value with no previous report is applied and confirms the group", () => {
    const result = settleReport(
      written({ on: true }),
      { on: false },
      undefined,
    );
    expect(result.applied).toEqual({ on: false });
    expect(result.pending).toEqual({});
  });

  test("a power that a brightness implies withholds nothing and ends with a change", () => {
    const pending = { power: written({ brightness: 10 }).power! };
    const repeat = settleReport(pending, { on: false }, { on: false });
    expect(repeat.applied).toEqual({ on: false });
    expect(repeat.pending).toEqual(pending);
    const change = settleReport(pending, { on: true }, { on: false });
    expect(change.applied).toEqual({ on: true });
    expect(change.pending).toEqual({});
  });
});

describe("expireWrites", () => {
  test("a written group whose deadline has come is expired", () => {
    const pending = {
      ...recordWrite({}, { on: true }, 0),
      ...recordWrite({}, { hue: 1 }, 1),
    };
    expect(expireWrites(pending, 1999)).toEqual({ expired: [], pending });
    const at = expireWrites(pending, 2000);
    expect(at.expired).toEqual(["power"]);
    expect(Object.keys(at.pending)).toEqual(["color"]);
    expect(expireWrites(pending, 2001).expired).toEqual(["power", "color"]);
  });

  test("an overlay expires without being applied", () => {
    const pending = recordWrite({}, { brightness: 1 }, 0);
    const result = expireWrites(pending, 2000);
    expect(result.expired).toEqual(["brightness"]);
    expect(result.pending).toEqual({});
    const implied = recordWrite({}, { brightness: 1 }, 0);
    expect(expireWrites({ power: implied.power! }, 2000)).toEqual({
      expired: [],
      pending: {},
    });
  });
});

test("nextDeadline is the earliest one", () => {
  expect(nextDeadline({})).toBeUndefined();
  expect(
    nextDeadline({
      ...recordWrite({}, { hue: 1 }, 300),
      ...recordWrite({}, { brightness: 1 }, 100),
    }),
  ).toBe(2100);
});

test("overlayOf gives the power and temperature of unconfirmed writes", () => {
  expect(overlayOf({})).toEqual({});
  expect(
    overlayOf(recordWrite({}, { on: true, brightness: 5, color_temp: 300 }, 0)),
  ).toEqual({ on: true, color_temp: 300 });
});

test("groupValues keeps the values of the groups", () => {
  const state = { on: true, brightness: 3, hue: 4, color_temp: 5 };
  expect(groupValues(state, ["power", "color"])).toEqual({
    on: true,
    hue: 4,
    color_temp: 5,
  });
  expect(groupValues(state, [])).toEqual({});
});

test("a state is without the values of the groups written and not yet confirmed", () => {
  const state = { on: true, brightness: 60, hue: 4, color_temp: 5 };
  const write = { deadline: 2000, overlay: {} };
  const pending = {
    power: { ...write, written: false },
    brightness: { ...write, written: true },
  };
  expect(writtenGroups(pending)).toEqual(["brightness"]);
  expect(withoutWritten(state, pending)).toEqual({
    on: true,
    hue: 4,
    color_temp: 5,
  });
  expect(withoutWritten(state, { color: { ...write, written: true } })).toEqual(
    { on: true, brightness: 60 },
  );
  expect(withoutWritten(state, {})).toEqual(state);
});

test("a group has changed when a value of it differs from what HomeKit shows", () => {
  const groups = ["power", "brightness", "color"] as const;
  const shown = { on: true, brightness: 60, hue: 4, saturation: 5 };
  expect(changedGroups(groups, shown, shown)).toEqual([]);
  expect(changedGroups(groups, { ...shown, on: false }, shown)).toEqual([
    "power",
  ]);
  expect(changedGroups(groups, { ...shown, brightness: 61 }, shown)).toEqual([
    "brightness",
  ]);
  expect(changedGroups(groups, { ...shown, saturation: 6 }, shown)).toEqual([
    "color",
  ]);
  expect(
    changedGroups(
      groups,
      { on: false, brightness: 1, hue: 1, saturation: 1 },
      shown,
    ),
  ).toEqual(["power", "brightness", "color"]);
});

test("a group is not changed by a value that HomeKit has no characteristic for, or that the state lacks", () => {
  expect(changedGroups(["color"], { color_temp: 300 }, {})).toEqual([]);
  expect(changedGroups(["color"], {}, { color_temp: 300 })).toEqual([]);
  expect(changedGroups(["power"], { brightness: 5 }, { on: true })).toEqual([]);
  expect(changedGroups(["power"], { on: false }, { on: true })).toEqual([
    "power",
  ]);
});

test("a fraction of a unit is not a change, because HomeKit holds whole numbers", () => {
  const shown = { on: true, hue: 100, saturation: 50 };
  expect(
    changedGroups(["color"], { hue: 100.4, saturation: 49.6 }, shown),
  ).toEqual([]);
  expect(
    changedGroups(["color"], { hue: 100.6, saturation: 50 }, shown),
  ).toEqual(["color"]);
});
