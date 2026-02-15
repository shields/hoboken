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

export function z2mBrightnessToHomeKit(z2m: number): number {
  if (Number.isNaN(z2m)) throw new RangeError("brightness must be a number");
  return Math.round((Math.max(0, Math.min(254, z2m)) / 254) * 100);
}

export function homeKitBrightnessToZ2M(hk: number): number {
  if (Number.isNaN(hk)) throw new RangeError("brightness must be a number");
  return Math.round((Math.max(0, Math.min(100, hk)) / 100) * 254);
}

// HAP ColorTemperature characteristic only accepts 140–500 mireds.
// Zigbee2MQTT devices can report values outside this range (e.g. 0 or 65535
// when color_temp mode isn't active). Without clamping, hap-nodejs emits
// characteristic warnings and HomeKit may reject the update entirely.
const COLOR_TEMP_MIN = 140;
const COLOR_TEMP_MAX = 500;

export function clampColorTemp(mireds: number): number {
  return Math.max(COLOR_TEMP_MIN, Math.min(COLOR_TEMP_MAX, mireds));
}
