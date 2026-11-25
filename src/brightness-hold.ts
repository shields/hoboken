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

// How long a brightness that a Zigbee2MQTT light reports must stand before
// HomeKit shows it. A group reports a brightness that it is passing through and
// corrects it about 5 s later, so a brightness that has stood for 10 s is the
// light's own.
export const BRIGHTNESS_SETTLE_MS = 10000;

export type BrightnessHold =
  // Show the brightness now, and drop any held one.
  | "apply"
  // The brightness is already held, and its timer keeps running.
  | "keep"
  // Hold the brightness, replacing any held one and restarting the timer.
  | "hold";

// What to do with the brightness that a report would apply to HomeKit. The
// first report of a device has no earlier state to be passing through from, so
// it is applied. A report that follows a write is held like any other: one
// that carries the written brightness shows nothing new, and a group answers a
// write with the brightnesses that it passes through as well.
export function decideBrightnessHold(input: {
  brightness: number;
  shown: number | undefined;
  held: number | undefined;
  first: boolean;
}): BrightnessHold {
  if (input.first || input.brightness === input.shown) return "apply";
  if (input.brightness === input.held) return "keep";
  return "hold";
}
