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

import { object, identifier, integer } from "./tucson-profile.ts";
export {
  parseTucsonHeartbeat as parseHeatedBeddingHeartbeat,
  parseTucsonResult as parseHeatedBeddingResult,
} from "./tucson-profile.ts";
export interface HeatedBeddingState {
  session_id: string;
  power: boolean | null;
  heat_level: number | null;
  preheat: boolean | null;
  auto_off_seconds: number | null;
  remaining_seconds: number | null;
  preheat_remaining_seconds: number | null;
}

export interface HeatedBeddingCommand {
  power?: boolean;
  heat_level?: number;
  preheat?: boolean;
}

export type HeatedBeddingFanWrite = { active: boolean } | { speed: number };

export {
  tucsonTopic as heatedBeddingTopic,
  type TucsonResult as HeatedBeddingResult,
} from "./tucson-profile.ts";

export function normalizeHeatedBeddingSpeed(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError(
      "Heated bedding speed must be finite and between 0 and 100",
    );
  }
  return percent === 0
    ? 0
    : 10 * Math.min(10, Math.max(1, Math.floor(percent / 10 + 0.5)));
}

export function coalesceHeatedBeddingFanWrites(
  writes: readonly HeatedBeddingFanWrite[],
): HeatedBeddingCommand {
  if (writes.length === 0) {
    throw new RangeError("Heated bedding fan commands require a write");
  }
  let off = false;
  let heatLevel: number | undefined;
  for (const write of writes) {
    if ("active" in write) {
      off ||= !write.active;
    }
    if ("speed" in write) {
      const speed = normalizeHeatedBeddingSpeed(write.speed);
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

function boolean(value: unknown): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new RangeError("Invalid heated bedding reported Boolean");
  }
  return value;
}

export function parseHeatedBeddingState(value: unknown): HeatedBeddingState {
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
