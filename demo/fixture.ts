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

import type { StatusData } from "../src/metrics.ts";

export const fixtureData: StatusData = {
  mqtt: { url: "mqtt://zigbee-hub.local:1883", connected: true },
  hap: {
    connections: [
      { remoteAddress: "192.168.1.42", authenticated: true },
      { remoteAddress: "192.168.1.55", authenticated: false },
    ],
  },
  bridge: { name: "Hoboken Bridge", version: "0ae07fd" },
  devices: [
    {
      name: "Living Room",
      topic: "living_room",
      capabilities: ["on_off", "brightness", "color_temp"],
      scenes: [
        { name: "Movie Mode", id: 1 },
        { name: "Relax", id: 2 },
      ],
      state: {
        state: "ON",
        brightness: 200,
        color_temp: 370,
      },
    },
    {
      name: "Bedroom",
      topic: "bedroom",
      capabilities: ["on_off", "brightness", "color_hs"],
      state: {
        state: "OFF",
        brightness: 0,
        color: { hue: 240, saturation: 80 },
      },
    },
    {
      name: "Desk Lamp",
      topic: "desk_lamp",
      capabilities: ["on_off", "brightness", "color_temp"],
      state: { state: "ON", brightness: 127 },
    },
    {
      name: "Kitchen Pendant",
      topic: "kitchen_pendant",
      capabilities: ["on_off"],
      state: null,
    },
  ],
};
