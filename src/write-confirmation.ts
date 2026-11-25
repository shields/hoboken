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

import { writtenState } from "./adaptive-lighting.ts";
import type { HomeKitState } from "./convert.ts";

// How long a published write waits for a report that shows it, before the
// bridge gives up on it and takes HomeKit back to what the device reports.
export const CONFIRMATION_MS = 2000;

// The characteristics that a report confirms together: a report that has a
// value for one of a group's keys shows what the device did with a write of
// that group.
export type WriteGroup = "power" | "brightness" | "color";

const GROUP_KEYS = {
  power: ["on"],
  brightness: ["brightness"],
  color: ["hue", "saturation", "color_temp"],
} as const satisfies Record<WriteGroup, readonly (keyof HomeKitState)[]>;

const GROUPS = Object.keys(GROUP_KEYS) as WriteGroup[];

// A write that no report has confirmed. `overlay` is what the write gives the
// light until a report changes its group: a power that a brightness implies
// is an overlay with `written` false, which withholds no report.
export interface UnconfirmedWrite {
  deadline: number;
  written: boolean;
  overlay: HomeKitState;
}

export type Unconfirmed = Partial<Record<WriteGroup, UnconfirmedWrite>>;

export function recordWrite(
  pending: Unconfirmed,
  payload: Record<string, unknown>,
  now: number,
): Unconfirmed {
  const deadline = now + CONFIRMATION_MS;
  const wrote = writtenState(payload);
  const next = { ...pending };
  if ("on" in payload) {
    next.power = {
      deadline,
      written: true,
      overlay: wrote.on === undefined ? {} : { on: wrote.on },
    };
  } else if (wrote.on !== undefined) {
    const earlier = pending.power;
    next.power = {
      deadline: earlier?.written ? earlier.deadline : deadline,
      written: earlier?.written ?? false,
      overlay: { on: wrote.on },
    };
  }
  if ("brightness" in payload)
    next.brightness = { deadline, written: true, overlay: {} };
  if ("hue" in payload || "saturation" in payload || "color_temp" in payload) {
    next.color = {
      deadline,
      written: true,
      overlay:
        wrote.color_temp === undefined ? {} : { color_temp: wrote.color_temp },
    };
  }
  return next;
}

// The values of a report that should reach HomeKit, and the writes that are
// still unconfirmed. A group whose values in the report all equal the
// device's previous report repeats the old state, and a written group does not
// apply them. A group with a different value is confirmed, and the report's
// values are applied. Without a previous report there is nothing to compare.
export function settleReport(
  pending: Unconfirmed,
  report: HomeKitState,
  previous: HomeKitState | undefined,
): { applied: HomeKitState; pending: Unconfirmed } {
  const withheld = new Set<string>();
  const confirmed = new Set<WriteGroup>();
  for (const group of GROUPS) {
    const write = pending[group];
    if (!write) continue;
    const keys = GROUP_KEYS[group].filter((key) => report[key] !== undefined);
    if (keys.length === 0) continue;
    if (!previous || keys.some((key) => report[key] !== previous[key]))
      confirmed.add(group);
    else if (write.written) for (const key of keys) withheld.add(key);
  }
  return {
    applied: Object.fromEntries(
      Object.entries(report).filter(([key]) => !withheld.has(key)),
    ),
    pending: Object.fromEntries(
      Object.entries(pending).filter(
        ([group]) => !confirmed.has(group as WriteGroup),
      ),
    ),
  };
}

export function expireWrites(
  pending: Unconfirmed,
  now: number,
): { expired: WriteGroup[]; pending: Unconfirmed } {
  const due = GROUPS.filter((group) => {
    const write = pending[group];
    return write && write.deadline <= now;
  });
  return {
    expired: due.filter((group) => pending[group]?.written),
    pending: Object.fromEntries(
      Object.entries(pending).filter(
        ([group]) => !due.includes(group as WriteGroup),
      ),
    ),
  };
}

export function nextDeadline(pending: Unconfirmed): number | undefined {
  const deadlines = GROUPS.flatMap((group) => pending[group]?.deadline ?? []);
  return deadlines.length === 0 ? undefined : Math.min(...deadlines);
}

export function overlayOf(pending: Unconfirmed): HomeKitState {
  return {
    ...pending.power?.overlay,
    ...pending.color?.overlay,
  };
}

export function groupValues(
  state: HomeKitState,
  groups: readonly WriteGroup[],
): HomeKitState {
  const keys = new Set<string>(groups.flatMap((group) => GROUP_KEYS[group]));
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => keys.has(key)),
  );
}

export function writtenGroups(pending: Unconfirmed): WriteGroup[] {
  return GROUPS.filter((group) => pending[group]?.written);
}

// HomeKit holds what it wrote for a group that no report has confirmed, and
// the device's state does not have it yet.
export function withoutWritten(
  state: HomeKitState,
  pending: Unconfirmed,
): HomeKitState {
  const keys = new Set<string>(
    writtenGroups(pending).flatMap((group) => GROUP_KEYS[group]),
  );
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => !keys.has(key)),
  );
}
