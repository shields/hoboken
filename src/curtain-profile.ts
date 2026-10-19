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

import { identifier, integer, object } from "./tucson-profile.ts";

export type CurtainMotion = "opening" | "closing" | "stopped";
export interface CurtainState {
  session_id: string;
  current_position: number;
  target_position: number;
  motion: CurtainMotion | null;
}
export interface CurtainCommand {
  target_position: number;
}

export function curtainIdentity(config: { controller: string }): string {
  return config.controller;
}

export function parseCurtainState(value: unknown): CurtainState | undefined {
  const data = object(value);
  const session = identifier(data.session_id, "session_id");
  const current = integer(data.current_position, 0, 100);
  const target = integer(data.target_position, 0, 100);
  const motion = data.motion ?? null;
  if (
    motion !== null &&
    motion !== "opening" &&
    motion !== "closing" &&
    motion !== "stopped"
  )
    throw new RangeError("Invalid curtain motion");
  if (current === null || target === null) return undefined;
  return {
    session_id: session,
    current_position: current,
    target_position: target,
    motion,
  };
}

export function curtainMotion(state: CurtainState): CurtainMotion {
  return (
    state.motion ??
    (state.current_position < state.target_position
      ? "opening"
      : state.current_position > state.target_position
        ? "closing"
        : "stopped")
  );
}
