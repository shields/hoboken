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

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, test } from "node:test";
import { HAPStorage } from "@homebridge/hap-nodejs";
import { Aedes } from "aedes";
import { startBridge } from "../src/bridge.ts";
import { poll } from "./test-broker.ts";

const SESSIONS = 4;
const MINIMUM_WAITS_MS = [1000, 2000, 4000];
const TIMER_SLACK_MS = 50;

describe(
  "a broker that accepts the login and then drops the session",
  { timeout: 60000 },
  () => {
    const accepted: number[] = [];
    let broker: Aedes | undefined;
    let server: Server | undefined;
    let directory: string | undefined;
    let handle: Awaited<ReturnType<typeof startBridge>> | undefined;

    before(async () => {
      broker = await Aedes.createBroker();
      broker.on("clientReady", () => {
        accepted.push(performance.now());
      });
      broker.on("subscribe", (_subscriptions, client) => {
        client.close();
      });
      server = createServer(broker.handle);
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert(address && typeof address === "object");

      directory = mkdtempSync(path.join(tmpdir(), "hoboken-drop-"));
      HAPStorage.setCustomStoragePath(directory);
      handle = await startBridge(
        {
          bridge: {
            name: "MQTT dropped session integration",
            mac: "0E:36:29:42:81:23",
            pincode: "031-45-155",
            port: 0,
          },
          mqtt: { url: `mqtt://127.0.0.1:${String(address.port)}` },
          devices: [
            {
              name: "Light",
              type: "z2m",
              topic: "zigbee2mqtt/light",
              capabilities: ["on_off"],
            },
          ],
        },
        "integration",
      );
    });

    after(async () => {
      const stopped = await Promise.allSettled([handle?.shutdown()]);
      if (broker) {
        await new Promise<void>((resolve) => {
          broker!.close(resolve);
        });
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => {
            resolve();
          });
        });
      }
      if (directory) rmSync(directory, { recursive: true });
      for (const result of stopped) assert.equal(result.status, "fulfilled");
    });

    test("the bridge waits longer after each dropped session", async () => {
      await poll(() => accepted.length >= SESSIONS, 30000);
      const waits = accepted
        .slice(0, SESSIONS)
        .slice(1)
        .map((time, index) => time - accepted[index]!);
      for (const [index, minimum] of MINIMUM_WAITS_MS.entries()) {
        assert(
          waits[index]! >= minimum - TIMER_SLACK_MS,
          `wait ${String(index + 1)} was ${String(Math.round(waits[index]!))} ms, expected at least ${String(minimum)} ms (waits: ${waits.map((wait) => String(Math.round(wait))).join(", ")})`,
        );
      }
    });
  },
);
