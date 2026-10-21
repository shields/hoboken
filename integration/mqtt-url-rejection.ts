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
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { after, before, describe, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { HAPStorage } from "@homebridge/hap-nodejs";
import { startBridge } from "../src/bridge.ts";
import {
  INVALID_MQTT_URL,
  MALFORMED_MQTT_URLS,
  SECRET,
  type URLReport,
} from "../test/mqtt-urls.ts";

const CHECKOUT = new URL("../", import.meta.url);
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPORT = fileURLToPath(
  new URL("../test/mqtt-url-report.ts", import.meta.url),
);
const SCRUBBED_ENVIRONMENT = new Set(["DEBUG", "NODE_TEST_CONTEXT"]);
const SPAWNED_URLS = [
  `mqtt://user:${SECRET}@127.0.0.1:18x3`,
  `mqtt://user:${SECRET}@bro ker:1883`,
  `mqtt://user:${SECRET}@`,
  String.raw`mqtt://user:${SECRET}\@broker`,
  `user:${SECRET}@broker:1883`,
  "broker",
];

// Stack frames carry the checkout's path, which can contain any word that the
// assertions look for.
function withoutCheckoutPath(output: string): string {
  return output
    .replaceAll(CHECKOUT.href, "")
    .replaceAll(fileURLToPath(CHECKOUT), "");
}

function childEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !SCRUBBED_ENVIRONMENT.has(key),
    ),
  );
}

function bridgeConfig(url: string) {
  return {
    bridge: {
      name: "MQTT URL integration",
      mac: "0E:36:29:42:81:31",
      pincode: "031-45-154",
      port: 51826,
    },
    mqtt: { url },
    devices: [
      {
        name: "Light",
        type: "z2m" as const,
        topic: "zigbee2mqtt/light",
        capabilities: ["on_off" as const],
      },
    ],
  };
}

// A bridge that starts anyway would keep the process alive after the assertion
// fails.
async function startThenStop(url: string): Promise<void> {
  const handle = await startBridge(bridgeConfig(url), "integration");
  await handle.shutdown();
}

describe("an mqtt.url that is not well formed", () => {
  let directory: string | undefined;

  before(() => {
    directory = mkdtempSync(path.join(tmpdir(), "hoboken-url-"));
    HAPStorage.setCustomStoragePath(directory);
  });

  after(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  async function runMain(
    name: string,
    url: string,
  ): Promise<{ code: number | null; output: string }> {
    assert(directory);
    const root = path.join(directory, name);
    const configPath = path.join(root, "config.yaml");
    mkdirSync(root);
    writeFileSync(configPath, JSON.stringify(bridgeConfig(url)));
    const child = spawn(process.execPath, [MAIN], {
      env: {
        ...childEnvironment(),
        CONFIG_PATH: configPath,
        PERSIST_PATH: path.join(root, "persist"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (data: Buffer) => {
        output += data.toString();
      });
    }
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, output: withoutCheckoutPath(output) };
  }

  for (const [index, url] of SPAWNED_URLS.entries()) {
    test(`main.ts refuses ${JSON.stringify(url)} and prints none of it`, async () => {
      const { code, output } = await runMain(`main-${String(index)}`, url);
      assert.notEqual(code, 0);
      assert.notEqual(code, null);
      assert(output.includes(INVALID_MQTT_URL), output);
      assert(!output.includes(SECRET), "the output quotes the URL");
      assert(!output.includes(url), "the output quotes the URL");
      assert(!/warning/i.test(output), "the output has a process warning");
    });
  }

  test("startBridge refuses every one without a message, log line, or warning", async () => {
    const warnings: string[] = [];
    const record = (warning: Error) => {
      warnings.push(`${warning.name}: ${warning.message}`);
    };
    const lines: string[] = [];
    const logs = ["log", "warn", "error"].map((method) =>
      mock.method(console, method as "log", (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      }),
    );
    process.on("warning", record);
    try {
      for (const url of MALFORMED_MQTT_URLS) {
        await assert.rejects(startThenStop(url), new Error(INVALID_MQTT_URL));
      }
      await nextMacrotask();
      assert.deepEqual(warnings, []);
      assert.deepEqual(lines, []);
    } finally {
      process.off("warning", record);
      for (const log of logs) log.mock.restore();
    }
  });

  test("a fresh process validates every URL as mqtt.js uses it, and warns of none", () => {
    const result = spawnSync(process.execPath, [REPORT], {
      encoding: "utf8",
      env: childEnvironment(),
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as URLReport;
    assert.deepEqual(report.rejectedValid, []);
    assert.deepEqual(report.acceptedMalformed, []);
    assert.deepEqual(report.mqttJSRejectedValid, []);
    assert.equal(report.mqttJSBareHostname, "Missing protocol");
    assert.deepEqual(report.warnings, []);
    assert.equal(result.stderr, "");
  });

  test("a fresh process started with --no-deprecation validates every URL too", () => {
    const result = spawnSync(process.execPath, ["--no-deprecation", REPORT], {
      encoding: "utf8",
      env: childEnvironment(),
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as URLReport;
    assert.deepEqual(report.rejectedValid, []);
    assert.deepEqual(report.acceptedMalformed, []);
    assert.equal(result.stderr, "");
  });
});
