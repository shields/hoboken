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
import { after, before, describe, test } from "node:test";
import { HAPStorage } from "@homebridge/hap-nodejs";
import { Aedes, type Client } from "aedes";
import { startBridge } from "../src/bridge.ts";
import { poll } from "./test-broker.ts";

const GRANTED = "zigbee2mqtt/granted_light";
const REFUSED = "zigbee2mqtt/refused_light";

async function scrape(port: number | undefined): Promise<string> {
  assert(port);
  const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.text();
}

function sample(metrics: string, series: string): number | undefined {
  const line = metrics
    .split("\n")
    .find((text) => text.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe(
  "MQTT subscriptions that the broker refuses",
  { timeout: 60000 },
  () => {
    const refused = new Set([REFUSED]);
    const clients = new Set<Client>();
    const errors: string[] = [];
    const consoleError = console.error.bind(console);
    let disconnects = 0;
    let subscribes = 0;
    let broker: Aedes | undefined;
    let server: Server | undefined;
    let directory: string | undefined;
    let handle: Awaited<ReturnType<typeof startBridge>> | undefined;

    function subscriptionErrors(): string[] {
      return errors.filter((line) => line.includes("MQTT subscription"));
    }

    function received(topic: string): string {
      return `hoboken_mqtt_messages_received_total{device="${topic}"}`;
    }

    async function deliver(topic: string): Promise<void> {
      assert(broker);
      await new Promise<void>((resolve, reject) => {
        broker!.publish(
          {
            cmd: "publish",
            topic,
            payload: Buffer.from('{"state":"ON"}'),
            qos: 0,
            retain: false,
            dup: false,
          },
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      });
    }

    async function reconnect(): Promise<void> {
      const before = subscribes;
      assert.equal(clients.size, 1);
      for (const client of clients) client.close();
      await poll(() => subscribes === before + 1);
    }

    before(async () => {
      console.error = (...args: unknown[]) => {
        errors.push(args.join(" "));
        consoleError(...args);
      };
      broker = await Aedes.createBroker({
        authorizeSubscribe: (_client, subscription, callback) => {
          callback(null, refused.has(subscription.topic) ? null : subscription);
        },
      });
      broker.on("clientReady", (client: Client) => {
        clients.add(client);
      });
      broker.on("subscribe", () => {
        subscribes++;
      });
      broker.on("clientDisconnect", (client: Client) => {
        clients.delete(client);
        disconnects++;
      });
      server = createServer(broker.handle);
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert(address && typeof address === "object");

      directory = mkdtempSync(path.join(tmpdir(), "hoboken-subscribe-"));
      HAPStorage.setCustomStoragePath(directory);
      handle = await startBridge(
        {
          bridge: {
            name: "MQTT subscription integration",
            mac: "0E:36:29:42:81:22",
            pincode: "031-45-154",
            port: 0,
          },
          mqtt: { url: `mqtt://127.0.0.1:${String(address.port)}` },
          devices: [
            {
              name: "Granted Light",
              type: "z2m",
              topic: GRANTED,
              capabilities: ["on_off"],
            },
            {
              name: "Refused Light",
              type: "z2m",
              topic: REFUSED,
              capabilities: ["on_off"],
            },
          ],
          metrics: { port: 0, bind: "127.0.0.1" },
        },
        "integration",
      );
    });

    after(async () => {
      console.error = consoleError;
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

    test("the bridge names the refused topic, counts it, and stays connected", async () => {
      await poll(() => subscriptionErrors().length === 1);
      const [line] = subscriptionErrors();
      assert(line);
      assert(line.includes(`refused for ${REFUSED}`));
      assert(!line.includes(GRANTED));
      const metrics = await scrape(handle?.metricsPort);
      assert.equal(sample(metrics, "hoboken_mqtt_errors_total"), 1);
      assert.equal(sample(metrics, "hoboken_mqtt_connected"), 1);
      assert.equal(disconnects, 0);
    });

    test("the topic that the broker granted still delivers", async () => {
      await deliver(GRANTED);
      await poll(async () => {
        return (
          sample(await scrape(handle?.metricsPort), received(GRANTED)) === 1
        );
      });
    });

    test("a reconnect that the broker grants reports nothing", async () => {
      refused.clear();
      await reconnect();
      // The broker writes the SUBACK before it delivers on the new
      // subscription, so the counted message shows that the bridge has
      // handled the reply.
      await deliver(GRANTED);
      await poll(async () => {
        return (
          sample(await scrape(handle?.metricsPort), received(GRANTED)) === 2
        );
      });
      assert.equal(subscriptionErrors().length, 1);
      const metrics = await scrape(handle?.metricsPort);
      assert.equal(sample(metrics, "hoboken_mqtt_errors_total"), 1);
    });

    test("a refusal that starts at a later reconnect is reported too", async () => {
      refused.add(GRANTED);
      await reconnect();
      await poll(() => subscriptionErrors().length === 2);
      const line = subscriptionErrors()[1];
      assert(line);
      assert(line.includes(`refused for ${GRANTED}:`));
      assert(!line.includes(REFUSED));
      const metrics = await scrape(handle?.metricsPort);
      assert.equal(sample(metrics, "hoboken_mqtt_errors_total"), 2);
      assert.equal(sample(metrics, "hoboken_mqtt_connected"), 1);
    });
  },
);
