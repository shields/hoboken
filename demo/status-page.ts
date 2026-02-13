import { Registry } from "prom-client";
import { startMetricsServer } from "../src/metrics.ts";
import type { StatusData } from "../src/metrics.ts";

const data: StatusData = {
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
        last_seen: new Date(Date.now() - 47 * 60_000).toISOString(),
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
      name: "Kitchen Pendant",
      topic: "kitchen_pendant",
      capabilities: ["on_off"],
      state: null,
    },
  ],
};

const register = new Registry();
const ms = startMetricsServer(0, register, "127.0.0.1", () => data);

ms.server.on("listening", () => {
  const addr = ms.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  console.log(`Status page: http://127.0.0.1:${String(port)}/`);
});
