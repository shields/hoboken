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

import { readFileSync } from "node:fs";
import path from "node:path";

const MINIMUM_BRIGHTNESS = 10;
const MAXIMUM_BRIGHTNESS = 100;
const UPDATE_INTERVAL = 60000;
const NOTIFY_INTERVAL_THRESHOLD = 600000;

interface Knot {
  time: number;
  kelvin10: number;
  kelvin100: number;
}

interface LinearPoint {
  scale: number;
  offset: number;
  duration: number;
}

interface SchedulePoint {
  temperature: number;
  brightnessAdjustmentFactor: number;
  transitionTime: number;
  duration?: number;
}

function readCurve(file: string): Knot[] {
  const [header, ...rows] = readFileSync(file, "utf8").trimEnd().split("\n");
  if (header !== "time\tmilliseconds\tkelvin_10\tkelvin_100") {
    throw new Error(`${file}: unexpected header`);
  }
  const knots = rows.map((row) => {
    const [, time, kelvin10, kelvin100] = row.split("\t").map(Number);
    if (
      time === undefined ||
      kelvin10 === undefined ||
      kelvin100 === undefined ||
      [time, kelvin10, kelvin100].some((v) => !Number.isInteger(v))
    ) {
      throw new Error(`${file}: malformed row`);
    }
    return { time, kelvin10, kelvin100 };
  });
  const first = knots[0];
  const last = knots.at(-1);
  if (first?.time !== 0 || last?.time !== 86_400_000) {
    throw new Error(`${file}: the curve must run from 0:00 to 24:00`);
  }
  if (knots.some((knot, i) => knot.time <= (knots[i - 1]?.time ?? -1))) {
    throw new Error(`${file}: the times must increase`);
  }
  if (first.kelvin10 !== last.kelvin10 || first.kelvin100 !== last.kelvin100) {
    throw new Error(`${file}: 0:00 and 24:00 must have the same temperatures`);
  }
  return knots;
}

function mireds(kelvin: number): number {
  return Math.trunc(1_000_000 / kelvin);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// The hub's fmadd and fmsub round a * b + c to float32 once. For float32
// inputs a * b is exact in float64, and the sum's float64 rounding error,
// from Knuth's two-sum, settles the one case where rounding it again to
// float32 goes wrong: a sum that lands exactly halfway between two floats.
function fusedMultiplyAdd(a: number, b: number, c: number): number {
  const product = a * b;
  const sum = product + c;
  const virtualC = sum - product;
  const error = product - (sum - virtualC) + (c - virtualC);
  const rounded = Math.fround(sum);
  const other = 2 * sum - rounded;
  if (error === 0 || rounded === sum || Math.fround(other) !== other) {
    return rounded;
  }
  return error > 0 === other > rounded ? other : rounded;
}

function linearPoint(
  mireds10: number,
  mireds100: number,
  duration: number,
): LinearPoint {
  const scale = Math.fround(
    (mireds100 - mireds10) / (MAXIMUM_BRIGHTNESS - MINIMUM_BRIGHTNESS),
  );
  const offset = fusedMultiplyAdd(-scale, MINIMUM_BRIGHTNESS, mireds10);
  return { scale, offset, duration };
}

function exactMireds(point: LinearPoint, brightness: number): number {
  return fusedMultiplyAdd(point.scale, brightness, point.offset);
}

function roundedMireds(point: LinearPoint, brightness: number): number {
  const value = exactMireds(point, brightness);
  return Math.sign(value) * Math.round(Math.abs(value));
}

function buildPoints(
  knots: Knot[],
  minMireds: number,
  maxMireds: number,
): LinearPoint[] {
  if (!Number.isInteger(minMireds) || !Number.isInteger(maxMireds)) {
    throw new TypeError("the light's range must be two integers of mireds");
  }
  const all = knots.flatMap((knot) => [
    mireds(knot.kelvin10),
    mireds(knot.kelvin100),
  ]);
  if (
    minMireds > maxMireds ||
    minMireds > Math.max(...all) ||
    maxMireds < Math.min(...all)
  ) {
    throw new Error("the light's range does not overlap the curve");
  }
  return knots.map((knot, i) =>
    linearPoint(
      clamp(mireds(knot.kelvin10), minMireds, maxMireds),
      clamp(mireds(knot.kelvin100), minMireds, maxMireds),
      knot.time - (knots[i - 1]?.time ?? 0),
    ),
  );
}

function startingAt(points: LinearPoint[], elapsed: number): LinearPoint[] {
  let end = 0;
  for (const [k, point] of points.entries()) {
    const start = end;
    end += point.duration;
    if (end === elapsed) {
      return [
        { ...point, duration: 0 },
        ...points.slice(k + 1),
        ...points.slice(1, k + 1),
      ];
    }
    if (elapsed < start || elapsed >= end) continue;
    const previous = points[k - 1];
    if (previous === undefined) break;
    const sinceKnot = elapsed - start;
    const interpolate = (brightness: number): number => {
      const from = exactMireds(previous, brightness);
      const to = exactMireds(point, brightness);
      const slope = Math.fround(Math.fround(to - from) / point.duration);
      return Math.trunc(fusedMultiplyAdd(slope, sinceKnot, from));
    };
    const first = linearPoint(
      interpolate(MINIMUM_BRIGHTNESS),
      interpolate(MAXIMUM_BRIGHTNESS),
      0,
    );
    return [
      first,
      { ...point, duration: end - elapsed },
      ...points.slice(k + 1),
      ...points.slice(1, k),
      { ...first, duration: sinceKnot },
    ];
  }
  throw new Error(`time of day ${String(elapsed)} ms is outside the curve`);
}

function coalesced(points: LinearPoint[]): SchedulePoint[] {
  const same = (a: LinearPoint, b: LinearPoint): boolean =>
    roundedMireds(a, MINIMUM_BRIGHTNESS) ===
      roundedMireds(b, MINIMUM_BRIGHTNESS) &&
    roundedMireds(a, MAXIMUM_BRIGHTNESS) ===
      roundedMireds(b, MAXIMUM_BRIGHTNESS);
  const schedule: SchedulePoint[] = [];
  for (let i = 0; i < points.length;) {
    const point = points[i];
    if (point === undefined) break;
    let hold = 0;
    let j = i;
    for (
      let next = points[j + 1];
      next !== undefined && j + 2 < points.length && same(point, next);
      next = points[++j + 1]
    ) {
      hold += next.duration;
    }
    schedule.push({
      temperature: point.offset,
      brightnessAdjustmentFactor: point.scale,
      transitionTime: point.duration,
      ...(hold > 0 && { duration: hold }),
    });
    i = j + 1;
  }
  return schedule;
}

function schedule(
  knots: Knot[],
  timeOfDay: number,
  minMireds: number,
  maxMireds: number,
): SchedulePoint[] {
  return coalesced(
    startingAt(buildPoints(knots, minMireds, maxMireds), timeOfDay),
  );
}

function timeOfDay(millis: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(millis));
  const part = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return (part("hour") * 3600 + part("minute") * 60 + part("second")) * 1000;
}

interface StoredTransition {
  transitionStartMillis: number;
  brightnessAdjustmentRange: {
    minBrightnessValue: number;
    maxBrightnessValue: number;
  };
  updateInterval: number;
  notifyIntervalThreshold: number;
  transitionCurve: SchedulePoint[];
}

interface ControllerStorage {
  accessories: Record<
    string,
    { controllerData: { data: { activeTransition?: StoredTransition } } }[]
  >;
}

function endpoints(point: SchedulePoint): number[] {
  return [MINIMUM_BRIGHTNESS, MAXIMUM_BRIGHTNESS].map((brightness) =>
    Math.round(
      point.temperature + point.brightnessAdjustmentFactor * brightness,
    ),
  );
}

function compare(knots: Knot[], storageFile: string, timeZone: string): void {
  const storage = JSON.parse(
    readFileSync(storageFile, "utf8"),
  ) as ControllerStorage;
  const fields = (point: SchedulePoint): number[] => [
    point.temperature,
    point.brightnessAdjustmentFactor,
    point.transitionTime,
    point.duration ?? 0,
  ];
  let failed = false;
  let compared = 0;
  console.log(
    "accessory\tstart\tpoints\tminMireds\tmaxMireds\tmatches\tmaxDifference",
  );
  for (const [id, controllers] of Object.entries(storage.accessories)) {
    for (const controller of controllers) {
      const stored = controller.controllerData.data.activeTransition;
      if (stored === undefined) continue;
      compared++;
      const all = stored.transitionCurve.flatMap(endpoints);
      const minMireds = Math.min(...all);
      const maxMireds = Math.max(...all);
      const generated = schedule(
        knots,
        timeOfDay(stored.transitionStartMillis, timeZone),
        minMireds,
        maxMireds,
      );
      let difference = 0;
      for (const [i, point] of stored.transitionCurve.entries()) {
        const mine = generated[i];
        const a = fields(point);
        const b = mine === undefined ? [] : fields(mine);
        for (const [f, value] of a.entries()) {
          difference = Math.max(difference, Math.abs(value - (b[f] ?? NaN)));
        }
      }
      const matches =
        generated.length === stored.transitionCurve.length &&
        difference === 0 &&
        stored.brightnessAdjustmentRange.minBrightnessValue ===
          MINIMUM_BRIGHTNESS &&
        stored.brightnessAdjustmentRange.maxBrightnessValue ===
          MAXIMUM_BRIGHTNESS &&
        stored.updateInterval === UPDATE_INTERVAL &&
        stored.notifyIntervalThreshold === NOTIFY_INTERVAL_THRESHOLD;
      failed ||= !matches;
      console.log(
        [
          id,
          new Date(stored.transitionStartMillis).toISOString(),
          stored.transitionCurve.length,
          minMireds,
          maxMireds,
          matches,
          difference,
        ].join("\t"),
      );
    }
  }
  if (compared === 0) {
    console.error(`${storageFile}: no stored schedule to compare`);
    failed = true;
  }
  if (failed) process.exitCode = 1;
}

function parseTimeOfDay(text: string): number {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(text);
  const [hour, minute, second] = (match?.slice(1) ?? []).map(Number);
  if (
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error("time of day must be HH:MM:SS");
  }
  return (hour * 3600 + minute * 60 + second) * 1000;
}

const usage = `usage:
  node natural-lighting-schedule.ts HH:MM:SS [minMireds maxMireds]
  node natural-lighting-schedule.ts --compare ControllerStorage.json timeZone`;

const knots = readCurve(
  path.join(import.meta.dirname, "natural-lighting-curve.tsv"),
);
const args = process.argv.slice(2);
if (args[0] === "--compare" && args.length === 3) {
  compare(knots, args[1] ?? "", args[2] ?? "");
} else if (
  args[0] !== "--compare" &&
  (args.length === 1 || args.length === 3)
) {
  const [time = "", min = "140", max = "500"] = args;
  const points = schedule(
    knots,
    parseTimeOfDay(time),
    Number(min),
    Number(max),
  );
  console.log(
    "transitionTime\tduration\ttemperature\tbrightnessAdjustmentFactor",
  );
  for (const point of points) {
    console.log(
      [
        point.transitionTime,
        point.duration ?? "",
        point.temperature,
        point.brightnessAdjustmentFactor,
      ].join("\t"),
    );
  }
} else {
  console.error(usage);
  process.exitCode = 2;
}
