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
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  Characteristic,
  HAPStatus,
  HAPStorage,
  Service,
} from "@homebridge/hap-nodejs";
import { HttpClient } from "hap-controller";
import { connectAsync } from "mqtt";
import { startBridge } from "../src/bridge.ts";
import { validateConfig } from "../src/config.ts";
import { freePortPair, poll, TestBroker } from "./test-broker.ts";

test(
  "paired Rockville switches follow device reports across commands and reconnect",
  { timeout: 60000 },
  async () => {
    const binary = process.env.HOBOKEN_TEST_BROKER;
    assert(binary);
    const directory = mkdtempSync(path.join(tmpdir(), "hoboken-vacuum-"));
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    HAPStorage.setCustomStoragePath(directory);
    const [brokerPort, hapPort] = await freePortPair();
    const broker = new TestBroker(binary, directory, brokerPort);
    cleanup.defer(() => broker.stop());
    await broker.start();

    const device = await connectAsync(broker.url, { reconnectPeriod: 0 });
    cleanup.defer(async () => {
      await device.endAsync(true);
    });
    const publish = (topic: string, value: string) =>
      device.publishAsync(`rockville/${topic}`, value, {
        qos: 1,
        retain: true,
      });
    const commands: [string, string][] = [];
    device.on("message", (topic, payload) => {
      commands.push([topic, payload.toString()]);
    });
    await device.subscribeAsync("rockville/+/command/set");
    await publish("upstairs/availability", "online");
    await publish("downstairs/state", "paused");
    await publish("upstairs/state", "charging");
    await publish("bridge/availability", "online");
    await publish("downstairs/availability", "online");

    const handle = await startBridge(
      validateConfig({
        bridge: {
          name: "Vacuum Bridge",
          mac: "0E:36:29:42:81:28",
          pincode: "031-45-154",
          port: hapPort,
        },
        mqtt: { url: broker.url },
        vacuums: [
          { name: "Downstairs", device: "downstairs" },
          { name: "Upstairs", device: "upstairs" },
        ],
      }),
      "integration",
    );
    cleanup.defer(() => handle.shutdown());
    const client = new HttpClient(
      "vacuum-test-controller",
      "127.0.0.1",
      handle.hapPort,
    );
    cleanup.defer(() => client.close());
    await client.pairSetup("031-45-154");
    const [down, up] = handle.bridge.bridgedAccessories.map((accessory) => {
      const characteristic = accessory
        .getService(Service.Switch)
        ?.getCharacteristic(Characteristic.On);
      assert(characteristic);
      return `${String(accessory.aid)}.${String(characteristic.iid)}`;
    });
    assert(down && up);
    const read = async (id: string) => {
      const response = await client.getCharacteristics([id]);
      const result = response.characteristics[0];
      assert(result);
      return result.value ?? result.status;
    };
    const write = async (id: string, value: boolean) => {
      const response = (await client.setCharacteristics({
        [id]: value,
      })) as unknown as { characteristics: { status?: number }[] };
      assert(response.characteristics[0]);
      return response.characteristics[0].status ?? 0;
    };
    const failure = HAPStatus.SERVICE_COMMUNICATION_FAILURE;
    await poll(async () => (await read(down)) === 0 && (await read(up)) === 0);
    assert.equal(await write(down, false), 0);
    assert.equal(await write(down, true), 0);
    await poll(() => commands.length >= 2);
    assert.deepEqual(commands, [
      ["rockville/downstairs/command/set", "return"],
      ["rockville/downstairs/command/set", "start"],
    ]);
    assert.equal(await read(down), 0);
    await publish("upstairs/state", "segment_cleaning");
    await poll(async () => (await read(up)) === 1);
    assert.equal(await read(down), 0);
    await publish("downstairs/state", "zoned_cleaning");
    await poll(async () => (await read(down)) === 1);
    await publish("downstairs/availability", "offline");
    await poll(async () => (await read(down)) === failure);
    assert.equal(await write(down, true), failure);
    assert.equal(await read(up), 1);
    await publish("bridge/availability", "offline");
    await poll(async () => (await read(up)) === failure);
    await publish("downstairs/state", "returning_home");
    await publish("downstairs/availability", "online");
    assert.equal(await read(down), failure);
    await publish("bridge/availability", "online");
    await poll(async () => (await read(down)) === 0 && (await read(up)) === 1);

    // A new subscription replays a retained command before the marker sent on the same connection.
    await device.unsubscribeAsync("rockville/+/command/set");
    await device.subscribeAsync(["rockville/+/command/set", "marker"]);
    await device.publishAsync("marker", "ready", { qos: 1 });
    await poll(() => commands.at(-1)?.[0] === "marker");
    assert.equal(commands.length, 3);

    await broker.stop();
    await poll(async () => (await read(up)) === failure);
    assert.equal(await write(down, false), failure);
    await broker.start();
    await poll(async () => (await read(down)) === 0 && (await read(up)) === 1);
  },
);
