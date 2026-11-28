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

import { expect, test } from "bun:test";
import { Categories } from "@homebridge/hap-nodejs";
import { createVacuumAccessory } from "../src/vacuum-accessory.ts";
import { vacuumStatus } from "../src/vacuum-profile.ts";

const vacuum = {
  name: "Downstairs Vacuum",
  prefix: "rockville",
  device: "downstairs",
};

test("the prefix and device identify a Rockville switch across HomeKit renames", () => {
  const accessory = (changes: Partial<typeof vacuum>) =>
    createVacuumAccessory(
      { ...vacuum, ...changes },
      () => false,
      () => Promise.resolve(),
    ).accessory;
  const original = accessory({});
  expect(original.category).toBe(Categories.SWITCH);
  expect(original.UUID).toBe(accessory({ name: "Kitchen Vacuum" }).UUID);
  expect(original.UUID).not.toBe(accessory({ device: "upstairs" }).UUID);
  expect(original.UUID).not.toBe(accessory({ prefix: "other" }).UUID);
});

test("Rockville floor-cleaning states, inactive states, and unavailable reports", () => {
  const reports = new Map([
    ["rockville/bridge/availability", "online"],
    ["rockville/downstairs/availability", "online"],
  ]);
  const check = (expected: boolean | undefined, states: string[]) => {
    for (const state of states) {
      reports.set("rockville/downstairs/state", state);
      expect(vacuumStatus(vacuum, reports).on, state).toBe(expected);
    }
  };
  check(true, [
    "cleaning",
    "spot_cleaning",
    "zoned_cleaning",
    "segment_cleaning",
    "robot_status_mopping",
    "clean_mop_cleaning",
    "clean_mop_mopping",
    "segment_mopping",
    "segment_clean_mop_cleaning",
    "segment_clean_mop_mopping",
    "zoned_mopping",
    "zoned_clean_mop_cleaning",
    "zoned_clean_mop_mopping",
  ]);
  check(false, [
    "returning_home",
    "going_to_target",
    "docking",
    "docked",
    "charging",
    "charging_complete",
    "idle",
    "paused",
    "starting",
    "shutting_down",
    "updating",
    "locked",
    "mapping",
    "remote_control_active",
    "manual_mode",
    "patrol",
    "egg_attack",
    "in_call",
    "charging_problem",
    "error",
    "charger_disconnected",
    "emptying_the_bin",
    "washing_the_mop",
    "washing_the_mop_2",
    "going_to_wash_the_mop",
    "attaching_the_mop",
    "detaching_the_mop",
    "air_drying_stopping",
    "back_to_dock_washing_duster",
  ]);
  check(undefined, [
    "",
    "unknown",
    "device_offline",
    "some_future_cleaning_mode",
  ]);
});
