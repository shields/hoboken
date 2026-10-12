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
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  HAPStorage,
  HAPStatus,
  Service,
  Characteristic,
} from "@homebridge/hap-nodejs";
import { HttpClient } from "hap-controller";
import { connectAsync, type MqttClient } from "mqtt";
import { startBridge } from "../src/bridge.ts";
import type {
  MattressCommand,
  MattressState,
} from "../src/mattress-profile.ts";

const PREFIX = "mattress_test";
const TOPIC = `${PREFIX}/bed/side_a`;
const ZONES = ["side_a", "side_b"].map((zone) => ({
  name: `Mattress ${zone}`,
  prefix: PREFIX,
  controller: "bed",
  zone,
}));

async function poll(
  predicate: () => boolean | Promise<boolean>,
  timeout = 10000,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for mattress integration state");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(200);
    const finish = (ready: boolean): void => {
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.once("timeout", () => {
      finish(false);
    });
  });
}

class TestBroker {
  readonly port: number;
  readonly url: string;
  #binary: string;
  #config: string;
  #process: ChildProcess | undefined;
  #error: Error | undefined;
  #stderr = "";

  constructor(binary: string, directory: string, port: number) {
    this.port = port;
    this.url = `mqtt://127.0.0.1:${String(port)}`;
    this.#binary = binary;
    this.#config = path.join(directory, "mosquitto.conf");
    writeFileSync(
      this.#config,
      `listener ${String(port)} 127.0.0.1\nallow_anonymous true\npersistence true\npersistence_location ${directory}/\n`,
    );
  }

  async start(): Promise<void> {
    this.#error = undefined;
    this.#stderr = "";
    this.#process = spawn(this.#binary, ["-c", this.#config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.#process.stderr?.on("data", (data: Buffer) => {
      this.#stderr = (this.#stderr + data.toString()).slice(-8192);
    });
    this.#process.once("error", (error) => {
      this.#error = error;
    });
    this.#process.once("close", (code) => {
      if (code !== 0)
        this.#error = new Error(
          `MQTT test broker exited unsuccessfully: ${this.#stderr.trim()}`,
        );
    });
    await poll(async () => {
      if (this.#error) throw this.#error;
      return listening(this.port);
    });
  }

  async stop(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    if (
      child?.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("MQTT test broker shutdown timed out"));
      }, 5000);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("MQTT test broker shutdown failed"));
      });
      child.kill("SIGTERM");
    });
  }
}

interface WireCharacteristic {
  aid: number;
  iid: number;
  value?: unknown;
  status?: number;
}
interface WireResponse {
  characteristics: WireCharacteristic[];
}
type Command = MattressCommand & { request_id: string };

describe(
  "mattress MQTT and paired HomeKit integration",
  { timeout: 180000 },
  () => {
    let directory: string | undefined;
    let broker: TestBroker | undefined;
    let backend: MqttClient | undefined;
    let handle: Awaited<ReturnType<typeof startBridge>> | undefined;
    let client: InstanceType<typeof HttpClient> | undefined;
    let active: string;
    let speed: string;
    let preheat: string;
    let rightSpeed: string;
    let mode: "confirm" | "drop" | "reject" = "confirm";
    let session = "session-one";
    const commands: { topic: string; command: Command }[] = [];
    const states = new Map<string, MattressState>();
    const warnings: string[] = [];

    async function publish(
      topic: string,
      value: string | object,
      retain = false,
    ): Promise<void> {
      assert(backend);
      await backend.publishAsync(
        topic,
        typeof value === "string" ? value : JSON.stringify(value),
        { qos: retain ? 1 : 0, retain },
      );
    }

    async function connectBackend(): Promise<void> {
      assert(broker);
      backend = await connectAsync(broker.url, {
        protocolVersion: 5,
        clean: true,
        properties: { sessionExpiryInterval: 0 },
        reconnectPeriod: 0,
        queueQoSZero: false,
        connectTimeout: 5000,
      });
      backend.on("error", (error) => {
        throw error;
      });
      await backend.subscribeAsync(`${PREFIX}/bed/+/set`, {
        qos: 0,
        rh: 2,
        rap: true,
      });
      backend.on("message", (topic, payload, packet) => {
        assert.equal(packet.retain, false);
        const command = JSON.parse(payload.toString()) as Command;
        assert.equal(typeof command.request_id, "string");
        commands.push({ topic, command });
        if (mode === "drop") return;
        const stateTopic = topic.slice(0, -4);
        if (mode === "reject") {
          void publish(`${stateTopic}/result`, {
            request_id: command.request_id,
            outcome: "rejected",
            error_code: "invalid_command",
          });
          return;
        }
        const state = states.get(stateTopic);
        assert(state);
        Object.assign(
          state,
          Object.fromEntries(
            Object.entries(command).filter(([key]) => key !== "request_id"),
          ),
        );
        void (async () => {
          await publish(`${stateTopic}/result`, {
            request_id: command.request_id,
            outcome: "confirmed",
          });
          await publish(stateTopic, state, true);
        })();
      });
    }

    async function get(...keys: string[]): Promise<WireCharacteristic[]> {
      assert(client);
      return ((await client.getCharacteristics(keys)) as WireResponse)
        .characteristics;
    }

    async function value(key: string): Promise<unknown> {
      return (await get(key))[0]?.value;
    }

    async function write(
      values: Record<string, unknown>,
      expectedStatus = 0,
    ): Promise<void> {
      assert(client);
      const response = (await client.setCharacteristics(
        values,
      )) as unknown as WireResponse;
      assert.equal(response.characteristics.length, Object.keys(values).length);
      for (const characteristic of response.characteristics)
        assert.equal(characteristic.status ?? 0, expectedStatus);
    }

    async function seed(): Promise<void> {
      await publish(`${PREFIX}/bridge/availability`, "online", true);
      await publish(`${PREFIX}/bed/availability`, "online", true);
      for (const zone of ZONES) {
        const topic = `${PREFIX}/bed/${zone.zone}`;
        const state: MattressState = {
          session_id: session,
          power: false,
          heat_level: 4,
          preheat: false,
          auto_off_seconds: 3600,
          remaining_seconds: 3300,
          preheat_remaining_seconds: null,
        };
        states.set(topic, state);
        await publish(topic, state, true);
      }
    }

    before(async () => {
      const binary = process.env.HOBOKEN_TEST_BROKER;
      assert(
        binary,
        "HOBOKEN_TEST_BROKER must name the pinned Mosquitto executable",
      );
      directory = mkdtempSync(path.join(tmpdir(), "hoboken-mattress-"));
      broker = new TestBroker(binary, directory, await freePort());
      await broker.start();
      await connectBackend();
      await seed();
      await publish(
        `${PREFIX}/bridge/heartbeat`,
        { session_id: session },
        true,
      );
      HAPStorage.setCustomStoragePath(path.join(directory, "hap"));
      handle = await startBridge({
        bridge: {
          name: "Mattress integration",
          mac: "0E:36:29:42:81:12",
          pincode: "031-45-154",
          port: 0,
        },
        mqtt: { url: broker.url },
        devices: [],
        mattresses: ZONES,
        metrics: { port: 0, bind: "127.0.0.1" },
      });
      handle.bridge.on("characteristic-warning", (warning) => {
        warnings.push(warning.type);
      });
      client = new HttpClient(
        "mattress-test-controller",
        "127.0.0.1",
        handle.hapPort,
      );
      await client.pairSetup("031-45-154");
      const accessories = handle.bridge.bridgedAccessories;
      const left = accessories[0];
      const switchAccessory = accessories[1];
      const right = accessories[2];
      assert(left && switchAccessory && right);
      const fan = left.getService(Service.Fanv2);
      const rightFan = right.getService(Service.Fanv2);
      const preheatSwitch = switchAccessory.getService(Service.Switch);
      assert(fan && rightFan && preheatSwitch);
      active = `${String(left.aid)}.${String(fan.getCharacteristic(Characteristic.Active).iid)}`;
      speed = `${String(left.aid)}.${String(fan.getCharacteristic(Characteristic.RotationSpeed).iid)}`;
      rightSpeed = `${String(right.aid)}.${String(rightFan.getCharacteristic(Characteristic.RotationSpeed).iid)}`;
      preheat = `${String(switchAccessory.aid)}.${String(preheatSwitch.getCharacteristic(Characteristic.On).iid)}`;
    });

    beforeEach(() => {
      mode = "confirm";
      warnings.length = 0;
    });

    after(async () => {
      const cleanup = await Promise.allSettled([
        client?.close(),
        handle?.shutdown(),
        backend?.endAsync(true),
      ]);
      await broker?.stop();
      if (directory) rmSync(directory, { recursive: true, force: true });
      for (const result of cleanup) assert.equal(result.status, "fulfilled");
    });

    test("retained snapshots and heartbeats cannot establish initial liveness", async () => {
      assert(
        (await get(speed, rightSpeed)).every(
          (characteristic) =>
            characteristic.status === HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        ),
      );
      await publish(`${PREFIX}/bridge/heartbeat`, { session_id: session });
      await poll(async () => (await value(speed)) === 40);
      assert.equal(await value(active), 0);
    });

    test("fan off wins over a positive speed in either HTTP write order", async () => {
      for (const input of [
        { [speed]: 80, [active]: 0 },
        { [active]: 0, [speed]: 80 },
      ]) {
        const count = commands.length;
        await write(input);
        assert.equal(commands.length, count + 1);
        const command = commands.at(-1)?.command;
        assert(command);
        assert.deepEqual(command, {
          request_id: command.request_id,
          power: false,
        });
        assert.equal(await value(speed), 40);
        assert.equal(await value(active), 0);
      }
    });

    test("both zones have independent reported speeds", async () => {
      await write({ [rightSpeed]: 95 });
      assert.equal(await value(rightSpeed), 100);
      assert.equal(await value(speed), 40);
      const state = states.get(TOPIC);
      assert(state);
      state.heat_level = 6;
      await publish(TOPIC, state, true);
      await poll(async () => (await value(speed)) === 60);
      assert.equal(await value(rightSpeed), 100);
    });

    test("preheat stays on until a controller-style state push ends it", async () => {
      await write({ [preheat]: true });
      await delay(1200);
      assert.equal(await value(preheat), 1);
      const state = states.get(TOPIC);
      assert(state);
      state.preheat = false;
      await publish(TOPIC, state, true);
      await poll(async () => (await value(preheat)) === 0);
    });

    test("rejected writes preserve reported values", async () => {
      mode = "reject";
      await write({ [speed]: 80 }, HAPStatus.INVALID_VALUE_IN_REQUEST);
      assert.equal(await value(speed), 60);
    });

    test("retained results cannot confirm a matching reported state", async () => {
      mode = "drop";
      const count = commands.length;
      let settled = false;
      const pending = (async (): Promise<void> => {
        await write({ [speed]: 80 });
        settled = true;
      })();
      await poll(() => commands.length > count);
      const command = commands.at(-1)?.command;
      assert(command);
      const result = { request_id: command.request_id, outcome: "confirmed" };
      await publish(`${TOPIC}/result`, result, true);
      const state = states.get(TOPIC);
      assert(state);
      Object.assign(state, { power: true, heat_level: 8 });
      await publish(TOPIC, state, true);
      await delay(150);
      assert.equal(settled, false);
      await publish(`${TOPIC}/result`, result);
      await pending;
      assert.equal(await value(speed), 80);
    });

    test("a new bridge session cancels pending work and requires matching snapshots", async () => {
      mode = "drop";
      const count = commands.length;
      const cancelled = write(
        { [preheat]: true },
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
      await poll(() => commands.length > count);
      session = "session-two";
      await publish(`${PREFIX}/bridge/heartbeat`, { session_id: session });
      await cancelled;
      assert.equal(
        (await get(speed))[0]?.status,
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
      for (const [topic, state] of states) {
        state.session_id = session;
        await publish(topic, state, true);
      }
      await poll(async () => (await value(speed)) === 80);
      assert.equal(commands.length, count + 1);
    });

    test("the full HTTP write fails before HAP emits its own timeout", async () => {
      mode = "drop";
      await write({ [speed]: 20 }, HAPStatus.OPERATION_TIMED_OUT);
      assert(!warnings.includes("timeout-write"));
      assert.equal(await value(speed), 80);
    });

    test("broker restart invalidates state and never replays a pending command", async () => {
      assert(broker);
      mode = "drop";
      const count = commands.length;
      const cancelled = write(
        { [preheat]: true },
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
      await poll(() => commands.length > count);
      await backend?.endAsync(true);
      backend = undefined;
      await broker.stop();
      await cancelled;
      assert.equal(
        (await get(speed))[0]?.status,
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
      await broker.start();
      await connectBackend();
      assert(handle?.metricsPort);
      await poll(async () =>
        (
          await (
            await fetch(
              `http://127.0.0.1:${String(handle?.metricsPort)}/metrics`,
            )
          ).text()
        ).includes("hoboken_mqtt_connected 1"),
      );
      assert.equal(
        (await get(speed))[0]?.status,
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
      session = "session-after-restart";
      await seed();
      await publish(`${PREFIX}/bridge/heartbeat`, { session_id: session });
      await poll(async () => (await value(speed)) === 40);
      await delay(100);
      assert.equal(commands.length, count + 1);
    });
  },
);
