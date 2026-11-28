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

import {
  type ActiveAdaptiveLightingTransition,
  type AdaptiveLightingTransitionCurveEntry,
  encode,
  uuid,
  writeFloat32LE,
  writeUInt16,
  writeUInt32,
  writeVariableUIntLE,
} from "@homebridge/hap-nodejs";

const DAY = 86_400_000;
const HAP_EPOCH = Date.UTC(2001, 0, 1);

// The last schedule that the home hub sent a light, and the start of the
// transition that the bridge made from it, which HAP-NodeJS persists and
// restores as if the hub had sent it.
export interface SavedSchedule {
  schedule: ActiveAdaptiveLightingTransition;
  restored?: string;
}

interface Knot {
  time: number;
  temperature: number;
  factor: number;
}

function isCount(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return (
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max
  );
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^(?:[\da-f]{2})*$/.test(value);
}

function isEntry(
  value: unknown,
): value is AdaptiveLightingTransitionCurveEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    Number.isFinite(entry.temperature) &&
    Number.isFinite(entry.brightnessAdjustmentFactor) &&
    isCount(entry.transitionTime) &&
    (entry.duration === undefined || isCount(entry.duration))
  );
}

// What storage holds, checked field by field: the file is outside the
// program's control, and a TLV built from a malformed value would throw.
export function parseSavedSchedule(value: unknown): SavedSchedule | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { schedule, restored } = value as Record<string, unknown>;
  if (typeof schedule !== "object" || schedule === null) return undefined;
  const t = schedule as Record<string, unknown>;
  const range = t.brightnessAdjustmentRange as
    Record<string, unknown> | null | undefined;
  const valid =
    isCount(t.iid) &&
    Number.isSafeInteger(t.transitionStartMillis) &&
    Number.isSafeInteger(t.timeMillisOffset) &&
    typeof t.transitionId === "string" &&
    uuid.isValid(t.transitionId) &&
    isHex(t.transitionStartBuffer) &&
    (t.id3 === undefined || isHex(t.id3)) &&
    Array.isArray(t.transitionCurve) &&
    t.transitionCurve.every((entry) => isEntry(entry)) &&
    isCount(t.brightnessCharacteristicIID) &&
    typeof range === "object" &&
    range !== null &&
    isCount(range.minBrightnessValue, 0xff_ff_ff_ff) &&
    isCount(range.maxBrightnessValue, 0xff_ff_ff_ff) &&
    isCount(t.updateInterval, 0xff_ff) &&
    isCount(t.notifyIntervalThreshold, 0xff_ff_ff_ff) &&
    (restored === undefined || isHex(restored));
  if (!valid) return undefined;
  return {
    schedule: schedule as ActiveAdaptiveLightingTransition,
    ...(restored === undefined ? {} : { restored }),
  };
}

// The curve as points in time from its start. A hold is a pair of equal
// points; the hold of the last entry is past the curve's end.
function knots(curve: AdaptiveLightingTransitionCurveEntry[]): Knot[] {
  const result: Knot[] = [];
  let time = 0;
  for (const [i, entry] of curve.entries()) {
    time += entry.transitionTime;
    const knot = {
      temperature: entry.temperature,
      factor: entry.brightnessAdjustmentFactor,
    };
    result.push({ time, ...knot });
    if (entry.duration && i < curve.length - 1) {
      time += entry.duration;
      result.push({ time, ...knot });
    }
  }
  return result;
}

function at(points: Knot[], time: number): Knot {
  const after = points.findIndex((p) => p.time > time);
  const [a, b] = points.slice(after - 1, after + 1) as [Knot, Knot];
  const share = (time - a.time) / (b.time - a.time);
  return {
    time,
    temperature: a.temperature + (b.temperature - a.temperature) * share,
    factor: a.factor + (b.factor - a.factor) * share,
  };
}

// The home hub's schedule wraps around to the point it started from after a
// day, and is the same every day by the local clock, so it can be started over
// at any point.
function isDailyLoop(points: Knot[]): boolean {
  const first = points[0];
  const last = points.at(-1);
  return (
    first !== undefined &&
    last !== undefined &&
    first.time === 0 &&
    last.time === DAY &&
    first.temperature === last.temperature &&
    first.factor === last.factor
  );
}

function rotated(points: Knot[], elapsed: number): Knot[] {
  const here = at(points, elapsed);
  const result = [
    { ...here, time: 0 },
    ...points
      .filter((p) => p.time > elapsed)
      .map((p) => ({ ...p, time: p.time - elapsed })),
    ...points
      .filter((p) => p.time > 0 && p.time < elapsed)
      .map((p) => ({ ...p, time: p.time + DAY - elapsed })),
  ];
  // Started at its own start, the schedule already ends at that point.
  return elapsed > 0 ? [...result, { ...here, time: DAY }] : result;
}

// The write to CharacteristicValueTransitionControl that starts the saved
// schedule at the present. HAP-NodeJS begins a transition at its first entry
// whatever its start time, so the curve is rotated to begin where the saved
// schedule's own clock is now. The saved transition id and controller context
// stay, since the hub knows its schedule by the context. Undefined when the
// schedule is not a daily loop.
export function restoredTransition(
  saved: ActiveAdaptiveLightingTransition,
  nowMs: number,
): string | undefined {
  const points = knots(saved.transitionCurve);
  if (!isDailyLoop(points)) return undefined;
  const elapsed =
    (((nowMs - saved.timeMillisOffset - saved.transitionStartMillis) % DAY) +
      DAY) %
    DAY;
  const curve = rotated(points, elapsed);
  const start = Buffer.alloc(8);
  start.writeBigUInt64LE(BigInt(nowMs - HAP_EPOCH));
  const parameters = encode(
    1,
    uuid.write(saved.transitionId),
    2,
    start,
    ...(saved.id3 === undefined ? [] : [3, Buffer.from(saved.id3, "hex")]),
  );
  const entries = curve.map((point, i) =>
    encode(
      1,
      writeFloat32LE(point.factor),
      2,
      writeFloat32LE(point.temperature),
      3,
      writeVariableUIntLE(point.time - (curve[i - 1]?.time ?? 0)),
    ),
  );
  const configuration = encode(
    1,
    writeVariableUIntLE(saved.iid),
    2,
    parameters,
    3,
    Buffer.from([1]),
    5,
    encode(
      1,
      entries,
      2,
      writeVariableUIntLE(saved.brightnessCharacteristicIID),
      3,
      encode(
        1,
        writeUInt32(saved.brightnessAdjustmentRange.minBrightnessValue),
        2,
        writeUInt32(saved.brightnessAdjustmentRange.maxBrightnessValue),
      ),
    ),
    6,
    writeUInt16(saved.updateInterval),
    8,
    writeUInt32(saved.notifyIntervalThreshold),
  );
  return encode(2, encode(1, configuration)).toString("base64");
}
