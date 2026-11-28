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

export interface VacuumConfig {
  name: string;
  prefix: string;
  device: string;
}

export function vacuumTopics({ prefix, device }: VacuumConfig) {
  const base = `${prefix}/${device}`;
  return {
    base,
    state: `${base}/state`,
    availability: `${base}/availability`,
    bridgeAvailability: `${prefix}/bridge/availability`,
    command: `${base}/command/set`,
  };
}

const CLEANING = new Set([
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
const NON_CLEANING = new Set([
  "starting",
  "charger_disconnected",
  "idle",
  "remote_control_active",
  "returning_home",
  "manual_mode",
  "charging",
  "charging_problem",
  "paused",
  "error",
  "shutting_down",
  "updating",
  "docking",
  "docked",
  "going_to_target",
  "emptying_the_bin",
  "washing_the_mop",
  "washing_the_mop_2",
  "going_to_wash_the_mop",
  "in_call",
  "mapping",
  "egg_attack",
  "patrol",
  "attaching_the_mop",
  "detaching_the_mop",
  "charging_complete",
  "locked",
  "air_drying_stopping",
  "back_to_dock_washing_duster",
]);

export function vacuumStatus(
  config: VacuumConfig,
  reports: ReadonlyMap<string, string>,
) {
  const topics = vacuumTopics(config);
  const state = reports.get(topics.state);
  const availability = reports.get(topics.availability);
  const bridgeAvailability = reports.get(topics.bridgeAvailability);
  let on: boolean | undefined;
  if (availability === "online" && bridgeAvailability === "online" && state) {
    if (CLEANING.has(state)) on = true;
    if (NON_CLEANING.has(state)) on = false;
  }
  return {
    name: config.name,
    topics,
    state,
    availability,
    bridgeAvailability,
    on,
  };
}
