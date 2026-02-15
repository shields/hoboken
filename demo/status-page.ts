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
        last_seen: new Date(Date.now() - 47 * 60000).toISOString(),
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
        last_seen: new Date(Date.now() - 15000).toISOString(),
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

setInterval(() => {
  const lr = data.devices[0].state as Record<string, unknown>;
  lr.brightness = Math.floor(Math.random() * 254);
  lr.color_temp = 150 + Math.floor(Math.random() * 350);
  lr.state = lr.state === "ON" ? "OFF" : "ON";
  lr.last_seen = new Date().toISOString();

  const br = data.devices[1].state as Record<string, unknown>;
  const color = br.color as Record<string, unknown>;
  color.hue = Math.floor(Math.random() * 360);
  color.saturation = Math.floor(Math.random() * 100);
  br.brightness = Math.floor(Math.random() * 254);
  br.last_seen = new Date().toISOString();

  ms.notifyStateChange();
}, 3000);
