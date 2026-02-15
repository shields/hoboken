import { Registry } from "prom-client";
import { startMetricsServer } from "../src/metrics.ts";
import type { StatusData } from "../src/metrics.ts";
import { fixtureData } from "./fixture.ts";

const data: StatusData = structuredClone(fixtureData);

// Add dynamic fields for the live demo
for (const device of data.devices) {
  if (device.state) {
    device.state.last_seen = new Date(Date.now() - 47 * 60000).toISOString();
  }
}

const register = new Registry();
const ms = startMetricsServer(0, register, "127.0.0.1", () => data);

ms.server.on("listening", () => {
  const addr = ms.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  console.log(`Status page: http://127.0.0.1:${String(port)}/`);
});

const brState = data.devices[1]?.state;
if (!brState) throw new Error("demo data missing");
const brColor = brState.color as Record<string, unknown>;

const mutations: (() => void)[] = [
  () => {
    brState.state = brState.state === "ON" ? "OFF" : "ON";
  },
  () => {
    brState.brightness = Math.floor(Math.random() * 254);
  },
  () => {
    brColor.hue = Math.floor(Math.random() * 360);
  },
  () => {
    brColor.saturation = Math.floor(Math.random() * 100);
  },
];
let idx = 0;

setInterval(() => {
  const mutate = mutations[idx % mutations.length];
  if (mutate) mutate();
  idx++;
  brState.last_seen = new Date().toISOString();
  ms.notifyStateChange();
}, 3000);
