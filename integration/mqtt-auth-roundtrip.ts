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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Characteristic, HAPStorage, Service } from "@homebridge/hap-nodejs";
import { HttpClient } from "hap-controller";
import { connectAsync, type MqttClient } from "mqtt";
import { startBridge } from "../src/bridge.ts";
import {
  credentialOptions,
  resolveMQTTCredentials,
  type MQTTCredentials,
} from "../src/config.ts";
import type { CurtainCommand } from "../src/curtain-profile.ts";
import type {
  HeatedBeddingCommand,
  HeatedBeddingState,
} from "../src/heated-bedding-profile.ts";
import {
  freePort,
  freePortPair,
  poll,
  TestBroker,
  type BrokerAuth,
} from "./test-broker.ts";

const PREFIX = "heated_bedding_test";
const Z2M_TOPIC = "zigbee2mqtt/auth_light";
const MAIN_ATTEMPTS = 3;
const HOBOKEN_SENTINEL = "hoboken-sentinel-4c1e9b27";
const BACKEND_PASSWORD = "backend-sentinel-7d20af83";
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const SCRUBBED_ENVIRONMENT = new Set(["DEBUG", "NODE_TEST_CONTEXT"]);
const ZONES = ["side_a", "side_b"].map((zone) => ({
  name: `Bed Side ${zone === "side_a" ? "A" : "B"}`,
  prefix: PREFIX,
  controller: "bed",
  zone,
}));
const CURTAIN = {
  name: "Window Curtain",
  prefix: PREFIX,
  controller: "window",
};
const CURTAIN_TOPIC = `${PREFIX}/${CURTAIN.controller}`;
const AUTH: BrokerAuth = {
  users: { hoboken: HOBOKEN_SENTINEL, backend: BACKEND_PASSWORD },
  acl: [
    "user hoboken",
    `topic read ${Z2M_TOPIC}`,
    `topic write ${Z2M_TOPIC}/set`,
    `topic write ${Z2M_TOPIC}/get`,
    `topic read ${PREFIX}/bridge/availability`,
    `topic read ${PREFIX}/bridge/heartbeat`,
    `topic read ${PREFIX}/bed/availability`,
    ...ZONES.flatMap(({ controller, zone }) => [
      `topic read ${PREFIX}/${controller}/${zone}`,
      `topic read ${PREFIX}/${controller}/${zone}/result`,
      `topic write ${PREFIX}/${controller}/${zone}/set`,
    ]),
    `topic read ${CURTAIN_TOPIC}/availability`,
    `topic read ${CURTAIN_TOPIC}`,
    `topic read ${CURTAIN_TOPIC}/result`,
    `topic write ${CURTAIN_TOPIC}/set`,
    "user backend",
    "topic readwrite #",
    "",
  ].join("\n"),
};

interface WireCharacteristic {
  aid: number;
  iid: number;
  value?: unknown;
  status?: number;
}
interface WireResponse {
  characteristics: WireCharacteristic[];
}
type Command = (HeatedBeddingCommand | CurtainCommand) & {
  request_id: string;
};

async function scrape(port: number | undefined): Promise<string> {
  assert(port);
  const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return response.text();
}

function sample(metrics: string, name: string): number | undefined {
  const value = new RegExp(String.raw`^${name} (\S+)$`, "m").exec(metrics)?.[1];
  return value === undefined ? undefined : Number(value);
}

function brokerBinary(): string {
  const binary = process.env.HOBOKEN_TEST_BROKER;
  assert(
    binary,
    "HOBOKEN_TEST_BROKER must name the pinned Mosquitto executable",
  );
  return binary;
}

describe(
  "authenticated MQTT broker and paired HomeKit integration",
  { timeout: 120000 },
  () => {
    let directory: string | undefined;
    let broker: TestBroker | undefined;
    let backend: MqttClient | undefined;
    let credentials: MQTTCredentials | undefined;
    let handle: Awaited<ReturnType<typeof startBridge>> | undefined;
    let client: InstanceType<typeof HttpClient> | undefined;
    let lightOn: string;
    let curtainCurrent: string;
    let curtainTarget: string;
    const speeds = new Map<string, string>();
    const session = "session-auth";
    const requests: unknown[] = [];
    const lightWrites: unknown[] = [];
    const ungrantedWrites: unknown[] = [];
    const commands: { topic: string; command: Command }[] = [];
    const states = new Map<string, object>();
    const children = new Set<ChildProcess>();

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

    async function get(...keys: string[]): Promise<WireCharacteristic[]> {
      assert(client);
      return ((await client.getCharacteristics(keys)) as WireResponse)
        .characteristics;
    }

    async function value(key: string): Promise<unknown> {
      return (await get(key))[0]?.value;
    }

    async function write(values: Record<string, unknown>): Promise<void> {
      assert(client);
      const response = (await client.setCharacteristics(
        values,
      )) as unknown as WireResponse;
      assert.equal(response.characteristics.length, Object.keys(values).length);
      for (const characteristic of response.characteristics)
        assert.equal(characteristic.status ?? 0, 0);
    }

    async function connected(): Promise<boolean> {
      assert(handle);
      return (
        sample(await scrape(handle.metricsPort), "hoboken_mqtt_connected") === 1
      );
    }

    function respond(topic: string, command: Command): void {
      const stateTopic = topic.slice(0, -4);
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
    }

    function runMain(environment: Record<string, string>): {
      child: ChildProcess;
      exited: Promise<number | null>;
      hasExited: () => boolean;
      output: () => string;
      stderr: () => string;
    } {
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !SCRUBBED_ENVIRONMENT.has(name),
        ),
      );
      const child = spawn(process.execPath, [MAIN], {
        env: { ...inherited, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 90000,
      });
      children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      let closed = false;
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          closed = true;
          children.delete(child);
          resolve(code);
        });
      });
      return {
        child,
        exited,
        hasExited: () => closed,
        output: () => stdout + stderr,
        stderr: () => stderr,
      };
    }

    function writeMainConfig(
      name: string,
      mac: string,
      url: string,
      ports: { bridge: number; metrics: number },
      passwordFile?: string,
    ): { CONFIG_PATH: string; PERSIST_PATH: string } {
      assert(directory);
      const root = path.join(directory, name);
      mkdirSync(root);
      const configPath = path.join(root, "config.yaml");
      writeFileSync(
        configPath,
        JSON.stringify({
          bridge: {
            name: `MQTT auth ${name}`,
            mac,
            pincode: "031-45-154",
            port: ports.bridge,
          },
          mqtt: {
            url,
            username: "hoboken",
            ...(passwordFile === undefined ? {} : { passwordFile }),
          },
          metrics: { port: ports.metrics, bind: "127.0.0.1" },
          devices: [
            {
              name: "Auth Light",
              type: "z2m",
              topic: Z2M_TOPIC,
              capabilities: ["on_off"],
            },
          ],
        }),
      );
      return {
        CONFIG_PATH: configPath,
        PERSIST_PATH: path.join(root, "persist"),
      };
    }

    async function expectMainAuthenticates(
      name: string,
      mac: string,
      source: { passwordFile: string; environment?: Record<string, string> },
    ): Promise<void> {
      assert(broker);
      for (let attempt = 1; ; attempt++) {
        const [bridge, metrics] = await freePortPair();
        const files = writeMainConfig(
          `${name}-${String(attempt)}`,
          mac,
          broker.url,
          { bridge, metrics },
          source.passwordFile,
        );
        const main = runMain({ ...files, ...source.environment });
        try {
          // The port answering is not enough: another process may hold it.
          await poll(() => {
            assert(!main.hasExited(), "main.ts exited early");
            return main
              .output()
              .includes(
                `Metrics server listening on 127.0.0.1:${String(metrics)}`,
              );
          }, 30000);
          await poll(async () => {
            assert(!main.hasExited(), "main.ts exited early");
            return (
              sample(await scrape(metrics), "hoboken_mqtt_connected") === 1
            );
          }, 30000);
        } catch (error) {
          // Another process can take a reserved port before the child binds it.
          if (
            attempt < MAIN_ATTEMPTS &&
            main.hasExited() &&
            main.output().includes("EADDRINUSE")
          ) {
            continue;
          }
          throw new Error(`main.ts did not authenticate:\n${main.output()}`, {
            cause: error,
          });
        } finally {
          main.child.kill("SIGTERM");
        }
        assert.equal(await main.exited, 0);
        assert(!main.output().includes(HOBOKEN_SENTINEL));
        return;
      }
    }

    before(() => {
      directory = mkdtempSync(path.join(tmpdir(), "hoboken-mqtt-auth-"));
      HAPStorage.setCustomStoragePath(path.join(directory, "hap"));
    });

    after(() => {
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    describe("with a broker that requires logins and enforces topic access", () => {
      before(async () => {
        assert(directory);
        const root = path.join(directory, "broker");
        mkdirSync(root);
        broker = new TestBroker(brokerBinary(), root, await freePort(), AUTH);
        await broker.start();
        backend = await connectAsync(broker.url, {
          protocolVersion: 5,
          clean: true,
          username: "backend",
          password: BACKEND_PASSWORD,
          properties: { sessionExpiryInterval: 0 },
          reconnectPeriod: 0,
          queueQoSZero: false,
          connectTimeout: 5000,
        });
        backend.on("error", (error) => {
          throw error;
        });
        backend.on("message", (topic, payload, packet) => {
          assert.equal(packet.retain, false);
          const body = JSON.parse(payload.toString()) as unknown;
          switch (topic) {
            case `${Z2M_TOPIC}/get`:
              requests.push(body);
              break;
            case `${Z2M_TOPIC}/set`:
              lightWrites.push(body);
              break;
            case "zigbee2mqtt/ungranted/set":
              ungrantedWrites.push(body);
              break;
            default: {
              const command = body as Command;
              assert.equal(typeof command.request_id, "string");
              commands.push({ topic, command });
              respond(topic, command);
            }
          }
        });
        await backend.subscribeAsync(
          [
            `${Z2M_TOPIC}/get`,
            `${Z2M_TOPIC}/set`,
            "zigbee2mqtt/ungranted/set",
            `${PREFIX}/bed/+/set`,
            `${CURTAIN_TOPIC}/set`,
          ],
          { qos: 0, rap: true },
        );

        const passwordFile = path.join(directory, "hoboken-password");
        writeFileSync(passwordFile, `${HOBOKEN_SENTINEL}\n`, { mode: 0o600 });
        credentials = resolveMQTTCredentials({
          url: broker.url,
          username: "hoboken",
          passwordFile,
        });
        handle = await startBridge(
          {
            bridge: {
              name: "MQTT auth integration",
              mac: "0E:36:29:42:81:14",
              pincode: "031-45-154",
              port: 0,
            },
            mqtt: { url: broker.url, username: "hoboken" },
            devices: [
              {
                name: "Auth Light",
                type: "z2m",
                topic: Z2M_TOPIC,
                capabilities: ["on_off"],
              },
            ],
            heatedBedding: ZONES,
            curtains: [CURTAIN],
            metrics: { port: 0, bind: "127.0.0.1" },
          },
          "integration",
          credentials,
        );
        client = new HttpClient(
          "mqtt-auth-test-controller",
          "127.0.0.1",
          handle.hapPort,
        );
        await client.pairSetup("031-45-154");
        const accessories = handle.bridge.bridgedAccessories;
        const light = accessories.find((accessory) =>
          accessory.getService(Service.Lightbulb),
        );
        const lightService = light?.getService(Service.Lightbulb);
        assert(light && lightService);
        lightOn = `${String(light.aid)}.${String(lightService.getCharacteristic(Characteristic.On).iid)}`;
        for (const { name, zone } of ZONES) {
          const bedding = accessories.find(
            (accessory) =>
              accessory.displayName === name &&
              accessory.getService(Service.Fanv2) !== undefined,
          );
          const fan = bedding?.getService(Service.Fanv2);
          assert(bedding && fan);
          speeds.set(
            zone,
            `${String(bedding.aid)}.${String(fan.getCharacteristic(Characteristic.RotationSpeed).iid)}`,
          );
        }
        const curtain = accessories.find(
          (accessory) => accessory.displayName === CURTAIN.name,
        );
        const covering = curtain?.getService(Service.WindowCovering);
        assert(curtain && covering);
        curtainCurrent = `${String(curtain.aid)}.${String(covering.getCharacteristic(Characteristic.CurrentPosition).iid)}`;
        curtainTarget = `${String(curtain.aid)}.${String(covering.getCharacteristic(Characteristic.TargetPosition).iid)}`;
      });

      after(async () => {
        const cleanup = await Promise.allSettled([
          client?.close(),
          handle?.shutdown(),
          backend?.endAsync(true),
        ]);
        try {
          await broker?.stop();
        } finally {
          for (const child of children) child.kill("SIGKILL");
        }
        for (const result of cleanup) {
          if (result.status === "rejected")
            throw new Error("Integration test cleanup failed", {
              cause: result.reason,
            });
        }
      });

      test("the broker refuses anonymous and wrong-password clients", async () => {
        assert(broker);
        for (const protocolVersion of [4, 5] as const) {
          for (const login of [
            {},
            { username: "hoboken", password: `wrong-${HOBOKEN_SENTINEL}` },
          ]) {
            await assert.rejects(
              connectAsync(broker.url, {
                ...login,
                protocolVersion,
                reconnectPeriod: 0,
                connectTimeout: 5000,
              }),
              /Connection refused/,
            );
          }
        }
      });

      test("every MQTT client authenticates from a password file with a trailing newline", async () => {
        assert.deepEqual(credentials, {
          username: "hoboken",
          password: HOBOKEN_SENTINEL,
        });
        await poll(connected);
      });

      test("Zigbee2MQTT requests state and carries writes under the ACL", async () => {
        await poll(() => requests.length > 0);
        assert.deepEqual(requests[0], { state: "" });
        await publish(Z2M_TOPIC, { state: "ON" }, true);
        await poll(async () => (await value(lightOn)) === 1);
        const count = lightWrites.length;
        await write({ [lightOn]: false });
        await poll(() => lightWrites.length > count);
        assert.deepEqual(lightWrites.at(-1), { state: "OFF" });
      });

      test("heated bedding reports state and carries a confirmed write under the ACL", async () => {
        await poll(connected);
        await publish(`${PREFIX}/bridge/availability`, "online", true);
        await publish(`${PREFIX}/bed/availability`, "online", true);
        for (const zone of ZONES) {
          const topic = `${PREFIX}/${zone.controller}/${zone.zone}`;
          const state: HeatedBeddingState = {
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
        await publish(`${PREFIX}/bridge/heartbeat`, { session_id: session });
        for (const { controller, zone } of ZONES) {
          const speed = speeds.get(zone);
          assert(speed);
          await poll(async () => (await value(speed)) === 40);

          const count = commands.length;
          await write({ [speed]: 80 });
          assert.equal(commands.length, count + 1);
          const latest = commands.at(-1);
          assert(latest);
          assert.equal(latest.topic, `${PREFIX}/${controller}/${zone}/set`);
          assert.deepEqual(latest.command, {
            request_id: latest.command.request_id,
            power: true,
            heat_level: 8,
          });
          assert.equal(await value(speed), 80);
        }
      });

      test("curtains report state and carry a confirmed target write under the ACL", async () => {
        await poll(connected);
        await publish(`${PREFIX}/bridge/availability`, "online", true);
        await publish(`${CURTAIN_TOPIC}/availability`, "online", true);
        const state = {
          session_id: session,
          current_position: 20,
          target_position: 20,
          motion: null,
        };
        states.set(CURTAIN_TOPIC, state);
        await publish(CURTAIN_TOPIC, state, true);
        await publish(`${PREFIX}/bridge/heartbeat`, { session_id: session });
        await poll(async () => (await value(curtainCurrent)) === 20);

        const count = commands.length;
        await write({ [curtainTarget]: 80 });
        assert.equal(commands.length, count + 1);
        const latest = commands.at(-1);
        assert(latest);
        assert.equal(latest.topic, `${CURTAIN_TOPIC}/set`);
        assert.deepEqual(latest.command, {
          request_id: latest.command.request_id,
          target_position: 80,
        });
        assert.equal(await value(curtainTarget), 80);
      });

      test("the ACL withholds topics outside Hoboken's grants", async () => {
        assert(broker);
        const control = { acl_control: true };
        const received: unknown[] = [];
        const ungranted: unknown[] = [];
        const probe = await connectAsync(broker.url, {
          username: "hoboken",
          password: HOBOKEN_SENTINEL,
          reconnectPeriod: 0,
          connectTimeout: 5000,
        });
        try {
          probe.on("message", (topic, payload) => {
            const body = JSON.parse(payload.toString()) as unknown;
            if (topic === "zigbee2mqtt/ungranted") ungranted.push(body);
            else received.push(body);
          });
          await probe.subscribeAsync(["zigbee2mqtt/ungranted", Z2M_TOPIC]);
          await publish("zigbee2mqtt/ungranted", { state: "ON" });
          await publish(Z2M_TOPIC, control);
          await probe.publishAsync("zigbee2mqtt/ungranted/set", "{}");
          await probe.publishAsync(`${Z2M_TOPIC}/get`, JSON.stringify(control));
          await poll(
            () =>
              received.some((body) => isDeepStrictEqual(body, control)) &&
              requests.some((body) => isDeepStrictEqual(body, control)),
          );
          assert.deepEqual(ungranted, []);
          assert.deepEqual(ungrantedWrites, []);
        } finally {
          await probe.endAsync(true);
        }
      });

      test("the status page and metrics never carry the password", async () => {
        assert(handle?.metricsPort);
        const base = `http://127.0.0.1:${String(handle.metricsPort)}`;
        for (const [route, content] of [
          ["/", "Auth Light"],
          ["/metrics", "hoboken_mqtt_connected 1"],
        ] as const) {
          const response = await fetch(`${base}${route}`);
          assert.equal(response.status, 200);
          const body = await response.text();
          assert(body.includes(content));
          assert(!body.includes(HOBOKEN_SENTINEL));
          assert(!body.includes(BACKEND_PASSWORD));
        }
      });

      test("main.ts refuses to start with a username and no password file, whatever MQTT_PASSWORD holds", async () => {
        assert(broker);
        const [bridge, metrics] = await freePortPair();
        const files = writeMainConfig(
          "refused-start",
          "0E:36:29:42:81:16",
          broker.url,
          { bridge, metrics },
        );
        const main = runMain({ ...files, MQTT_PASSWORD: HOBOKEN_SENTINEL });
        const code = await main.exited;
        assert.notEqual(code, 0);
        assert.notEqual(code, null);
        assert.match(
          main.stderr(),
          /mqtt\.username requires mqtt\.passwordFile/,
        );
        assert(!main.output().includes(HOBOKEN_SENTINEL));
      });

      test("main.ts reads the password file and ignores MQTT_PASSWORD", async () => {
        assert(directory);
        const passwordFile = path.join(directory, "main-ignored-password");
        writeFileSync(passwordFile, `${HOBOKEN_SENTINEL}\n`, { mode: 0o600 });
        await expectMainAuthenticates("ignored-start", "0E:36:29:42:81:18", {
          passwordFile,
          environment: { MQTT_PASSWORD: `wrong-${HOBOKEN_SENTINEL}` },
        });
      });

      test("main.ts authenticates with the password from a file with a byte order mark and CRLF", async () => {
        assert(directory);
        const passwordFile = path.join(directory, "main-crlf-password");
        writeFileSync(passwordFile, `\u{FEFF}${HOBOKEN_SENTINEL}\r\n`, {
          mode: 0o600,
        });
        await expectMainAuthenticates("crlf-file-start", "0E:36:29:42:81:1D", {
          passwordFile,
        });
      });

      test("configured credentials win over userinfo in the broker URL", async () => {
        assert(broker && credentials);
        const address = `127.0.0.1:${String(broker.port)}`;
        for (const userinfo of ["stranger:wrong@", "stranger@"]) {
          for (const url of [
            `mqtt://${userinfo}${address}`,
            `mqtt:${userinfo}${address}`,
            `mqtt:\\\\${userinfo}${address}`,
          ]) {
            for (const protocolVersion of [4, 5] as const) {
              const options = {
                protocolVersion,
                reconnectPeriod: 0,
                connectTimeout: 5000,
              };
              await assert.rejects(
                connectAsync(url, { ...credentials, ...options }),
                /Connection refused/,
              );
              const login = await connectAsync(url, {
                ...credentialOptions(credentials),
                ...options,
              });
              await login.endAsync(true);
            }
          }
        }
      });
    });

    for (const attempt of [
      {
        refused: "login",
        mac: "0E:36:29:42:81:1A",
        credentials: { username: "hoboken", password: HOBOKEN_SENTINEL },
        accepted: AUTH,
      },
      {
        refused: "anonymous connection",
        mac: "0E:36:29:42:81:1B",
        credentials: undefined,
        accepted: undefined,
      },
    ] as const)
      describe(`with a broker that first refuses the ${attempt.refused}`, () => {
        let root: string | undefined;
        let refusing: TestBroker | undefined;
        let accepting: TestBroker | undefined;
        let retrying: Awaited<ReturnType<typeof startBridge>> | undefined;

        before(async () => {
          assert(directory);
          root = path.join(directory, `refused-${attempt.mac.slice(-2)}`);
          mkdirSync(root);
          refusing = new TestBroker(brokerBinary(), root, await freePort(), {
            users: { backend: BACKEND_PASSWORD },
            acl: AUTH.acl,
          });
          await refusing.start();
          retrying = await startBridge(
            {
              bridge: {
                name: "MQTT auth retry",
                mac: attempt.mac,
                pincode: "031-45-154",
                port: 0,
              },
              mqtt: {
                url: refusing.url,
                ...(attempt.credentials && {
                  username: attempt.credentials.username,
                }),
              },
              devices: [
                {
                  name: "Auth Light",
                  type: "z2m",
                  topic: Z2M_TOPIC,
                  capabilities: ["on_off"],
                },
              ],
              metrics: { port: 0, bind: "127.0.0.1" },
            },
            "integration",
            attempt.credentials,
          );
        });

        after(async () => {
          try {
            await retrying?.shutdown();
          } finally {
            try {
              await refusing?.stop();
            } finally {
              await accepting?.stop();
            }
          }
        });

        test("a refused connection is retried until the broker accepts it", async () => {
          assert(root && refusing && retrying);
          const port = retrying.metricsPort;
          await poll(async () => {
            const metrics = await scrape(port);
            return (
              (sample(metrics, "hoboken_mqtt_errors_total") ?? 0) >= 2 &&
              sample(metrics, "hoboken_mqtt_connected") === 0
            );
          });
          await refusing.stop();
          accepting = new TestBroker(
            brokerBinary(),
            root,
            refusing.port,
            attempt.accepted,
          );
          await accepting.start();
          await poll(
            async () =>
              sample(await scrape(port), "hoboken_mqtt_connected") === 1,
            20000,
          );
        });
      });
  },
);
