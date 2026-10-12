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

export interface MattressState {
  session_id: string;
  power: boolean | null;
  heat_level: number | null;
  preheat: boolean | null;
  auto_off_seconds: number | null;
  remaining_seconds: number | null;
  preheat_remaining_seconds: number | null;
}

export interface MattressCommand {
  power?: boolean;
  heat_level?: number;
  preheat?: boolean;
}

export type MattressFanWrite = { active: boolean } | { speed: number };

export type MattressResult =
  | { request_id: string; outcome: "confirmed" }
  | {
      request_id: string;
      outcome: "rejected" | "unconfirmed";
      error_code: string;
    };

export function normalizeMattressSpeed(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError("Mattress speed must be finite and between 0 and 100");
  }
  return percent === 0
    ? 0
    : 10 * Math.min(10, Math.max(1, Math.floor(percent / 10 + 0.5)));
}

export function coalesceMattressFanWrites(
  writes: readonly MattressFanWrite[],
): MattressCommand {
  if (writes.length === 0) {
    throw new RangeError("Mattress fan commands require a write");
  }
  let off = false;
  let heatLevel: number | undefined;
  for (const write of writes) {
    if ("active" in write) {
      off ||= !write.active;
    }
    if ("speed" in write) {
      const speed = normalizeMattressSpeed(write.speed);
      if (speed === 0) {
        off = true;
      } else {
        heatLevel = speed / 10;
      }
    }
  }
  if (off) {
    return { power: false };
  }
  return heatLevel === undefined
    ? { power: true }
    : { power: true, heat_level: heatLevel };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("Mattress MQTT payload must be an object");
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string, maxLength = 128): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > maxLength
  ) {
    throw new RangeError(`Invalid mattress ${field}`);
  }
  return value;
}

function boolean(value: unknown): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new RangeError("Invalid mattress reported Boolean");
  }
  return value;
}

function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new RangeError("Invalid mattress reported integer");
  }
  return value;
}

export function parseMattressHeartbeat(value: unknown): string {
  return identifier(object(value).session_id, "session_id");
}

export function parseMattressState(value: unknown): MattressState {
  const data = object(value);
  return {
    session_id: identifier(data.session_id, "session_id"),
    power: boolean(data.power),
    heat_level: integer(data.heat_level, 1, 10),
    preheat: boolean(data.preheat),
    auto_off_seconds: integer(data.auto_off_seconds, 1),
    remaining_seconds: integer(data.remaining_seconds, 0),
    preheat_remaining_seconds: integer(data.preheat_remaining_seconds, 0),
  };
}

export function parseMattressResult(value: unknown): MattressResult {
  const data = object(value);
  const requestId = identifier(data.request_id, "request_id");
  if (data.outcome === "confirmed") {
    if (data.error_code !== undefined && data.error_code !== null) {
      throw new RangeError("Confirmed mattress result cannot include an error");
    }
    return { request_id: requestId, outcome: data.outcome };
  }
  if (data.outcome !== "rejected" && data.outcome !== "unconfirmed") {
    throw new RangeError("Invalid mattress result outcome");
  }
  return {
    request_id: requestId,
    outcome: data.outcome,
    error_code: identifier(data.error_code, "error_code", 64),
  };
}
