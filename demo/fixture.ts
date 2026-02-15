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
