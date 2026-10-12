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
import { setTimeout as delay } from "node:timers/promises";
import {
  Characteristic,
  HAPStatus,
  HAPStorage,
  Service,
} from "@homebridge/hap-nodejs";
import { HttpClient } from "hap-controller";
import { startBridge } from "../src/bridge.ts";

interface WireResponse {
  characteristics: { value?: unknown; status?: number }[];
}

async function poll(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 35000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error("Timed out waiting for Tucson's reported HomeKit state");
}

assert(
  process.versions.node.startsWith("24."),
  "Qualification requires Node.js 24",
);
const url = process.env.MQTT_TEST_URL;
assert(url, "MQTT_TEST_URL must identify the qualification broker");
const directory = mkdtempSync(path.join(tmpdir(), "hoboken-tucson-"));
HAPStorage.setCustomStoragePath(directory);
let handle: Awaited<ReturnType<typeof startBridge>> | undefined;
let client: InstanceType<typeof HttpClient> | undefined;
const failures: unknown[] = [];

async function get(
  key: string,
): Promise<WireResponse["characteristics"][number]> {
  assert(client);
  const response = await client.getCharacteristics([key]);
  const value = response.characteristics[0];
  assert(value);
  return value;
}

async function write(values: Record<string, number | boolean>): Promise<void> {
  assert(client);
  const response = (await client.setCharacteristics(
    values,
  )) as unknown as WireResponse;
  assert.equal(response.characteristics.length, Object.keys(values).length);
  for (const value of response.characteristics)
    assert.equal(value.status ?? 0, 0);
}

try {
  handle = await startBridge({
    bridge: {
      name: "Tucson qualification",
      mac: "0E:36:29:42:81:20",
      pincode: "031-45-154",
      port: 0,
    },
    mqtt: { url },
    devices: [],
    mattresses: [
      { name: "Mattress A", prefix: "tuya", controller: "bed", zone: "side_a" },
      { name: "Mattress B", prefix: "tuya", controller: "bed", zone: "side_b" },
    ],
  });
  client = new HttpClient(
    "tucson-test-controller",
    "127.0.0.1",
    handle.hapPort,
  );
  await client.pairSetup("031-45-154");
  const [left, preheatAccessory, right] = handle.bridge.bridgedAccessories;
  assert(left && preheatAccessory && right);
  const fan = left.getService(Service.Fanv2);
  const rightFan = right.getService(Service.Fanv2);
  const preheatSwitch = preheatAccessory.getService(Service.Switch);
  assert(fan && rightFan && preheatSwitch);
  const speed = `${String(left.aid)}.${String(fan.getCharacteristic(Characteristic.RotationSpeed).iid)}`;
  const power = `${String(left.aid)}.${String(fan.getCharacteristic(Characteristic.Active).iid)}`;
  const rightSpeed = `${String(right.aid)}.${String(rightFan.getCharacteristic(Characteristic.RotationSpeed).iid)}`;
  const preheat = `${String(preheatAccessory.aid)}.${String(preheatSwitch.getCharacteristic(Characteristic.On).iid)}`;
  await poll(
    async () =>
      (await get(speed)).value === 40 && (await get(rightSpeed)).value === 40,
  );
  await write({ [speed]: 60 });
  await write({ [rightSpeed]: 80 });
  assert.equal((await get(speed)).value, 60);
  assert.equal((await get(rightSpeed)).value, 80);
  await write({ [preheat]: true });
  assert.equal((await get(preheat)).value, 1);
  await write({ [power]: 0, [speed]: 90 });
  assert.equal((await get(power)).value, 0);
  assert.equal((await get(speed)).value, 60);
  assert.equal((await get(rightSpeed)).value, 80);
  process.stdout.write(JSON.stringify({ event: "ready_for_push" }) + "\n");
  await poll(
    async () =>
      (await get(speed)).value === 30 && (await get(preheat)).value === 0,
  );
  assert.equal((await get(rightSpeed)).value, 80);
  process.stdout.write(JSON.stringify({ event: "ready_for_shutdown" }) + "\n");
  await poll(
    async () =>
      (await get(speed)).status === HAPStatus.SERVICE_COMMUNICATION_FAILURE,
  );
  assert.equal(
    (await get(rightSpeed)).status,
    HAPStatus.SERVICE_COMMUNICATION_FAILURE,
  );
  process.stdout.write(
    JSON.stringify({ event: "qualification_passed" }) + "\n",
  );
} catch (error: unknown) {
  failures.push(error);
} finally {
  const cleanup = await Promise.allSettled([
    client?.close(),
    handle?.shutdown(),
  ]);
  rmSync(directory, { recursive: true, force: true });
  for (const result of cleanup) {
    if (result.status === "rejected") failures.push(result.reason);
  }
}
if (failures.length)
  throw new AggregateError(failures, "Tucson qualification failed");
