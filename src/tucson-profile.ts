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

export type TucsonResult =
  | { request_id: string; outcome: "confirmed" }
  | {
      request_id: string;
      outcome: "rejected" | "unconfirmed";
      error_code: string;
    };

export function tucsonTopic(zone: {
  prefix: string;
  controller: string;
  zone: string;
}): string {
  return `${zone.prefix}/${zone.controller}/${zone.zone}`;
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("Tucson MQTT payload must be an object");
  }
  return value as Record<string, unknown>;
}

export function identifier(
  value: unknown,
  field: string,
  maxLength = 128,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > maxLength
  ) {
    throw new RangeError(`Invalid Tucson ${field}`);
  }
  return value;
}

export function integer(
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
    throw new RangeError("Invalid Tucson reported integer");
  }
  return value;
}

export function parseTucsonHeartbeat(value: unknown): string {
  return identifier(object(value).session_id, "session_id");
}

export function parseTucsonResult(value: unknown): TucsonResult {
  const data = object(value);
  const requestId = identifier(data.request_id, "request_id");
  if (data.outcome === "confirmed") {
    if (data.error_code !== undefined && data.error_code !== null) {
      throw new RangeError("Confirmed Tucson result cannot include an error");
    }
    return { request_id: requestId, outcome: data.outcome };
  }
  if (data.outcome !== "rejected" && data.outcome !== "unconfirmed") {
    throw new RangeError("Invalid Tucson result outcome");
  }
  return {
    request_id: requestId,
    outcome: data.outcome,
    error_code: identifier(data.error_code, "error_code", 64),
  };
}
