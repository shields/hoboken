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
import { after, before, beforeEach, describe, test } from "node:test";

import { Aedes, type AedesPublishPacket, type Subscription } from "aedes";
import { HAPStorage } from "@homebridge/hap-nodejs";
import { HttpClient } from "hap-controller";

import type { Config } from "../src/config.ts";
import { startBridge } from "../src/bridge.ts";
import { WledSimulator } from "./wled-simulator.ts";

// Characteristic UUIDs
const ON_UUID = "00000025-0000-1000-8000-0026BB765291";
const BRIGHTNESS_UUID = "00000008-0000-1000-8000-0026BB765291";
const HUE_UUID = "00000013-0000-1000-8000-0026BB765291";
const SATURATION_UUID = "0000002F-0000-1000-8000-0026BB765291";
const COLOR_TEMPERATURE_UUID = "000000CE-0000-1000-8000-0026BB765291";

// --- Helpers ---

interface AccessoryList {
  accessories: {
    aid: unknown;
    services: {
      characteristics: {
        type: string;
        iid: unknown;
        value?: unknown;
      }[];
    }[];
  }[];
}

// `nth` picks among the accessories that have the characteristic, in the order
// of the configured devices.
function findChar(accs: AccessoryList, typeUuid: string, nth = 0): string {
  const keys = accs.accessories.flatMap((acc) =>
    acc.services.flatMap((svc) =>
      svc.characteristics
        .filter((ch) => ch.type.toUpperCase() === typeUuid)
        .map((ch) => `${String(acc.aid)}.${String(ch.iid)}`),
    ),
  );
  const key = keys[nth];
  if (key === undefined)
    throw new Error(`Characteristic ${typeUuid} not found`);
  return key;
}

async function getCharValues(
  c: InstanceType<typeof HttpClient>,
  ...keys: string[]
): Promise<Map<string, unknown>> {
  const res = (await c.getCharacteristics(keys)) as {
    characteristics: { aid: unknown; iid: unknown; value: unknown }[];
  };
  return new Map(
    res.characteristics.map((ch) => [
      `${String(ch.aid)}.${String(ch.iid)}`,
      ch.value,
    ]),
  );
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T constrains match+handler together
function waitFor<T>(
  broker: Aedes,
  event: string,
  match: (arg: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      broker.removeListener(event, handler);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);

    function handler(arg: T): void {
      if (!match(arg)) {
        return;
      }

      clearTimeout(timer);
      broker.removeListener(event, handler);
      resolve();
    }

    broker.on(event, handler);
  });
}

async function poll(
  fn: () => Promise<boolean> | boolean,
  intervalMs: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error("poll timed out");
}

// --- Tests ---

// The baseline differs from every brightness and color the tests set, so a test
// that fails to change anything cannot pass.
const BASELINE_BRI = 255;
const BASELINE_HOMEKIT_BRIGHTNESS = 100;
const BASELINE_COL: [number, number, number] = [0, 0, 255];
const BASELINE_HUE = 240;
const BASELINE_SATURATION = 100;

describe("WLED integration", { timeout: 30000 }, () => {
  let simulator: WledSimulator | undefined;
  let nook: WledSimulator | undefined;
  let handle: Awaited<ReturnType<typeof startBridge>> | undefined;
  let client: InstanceType<typeof HttpClient> | undefined;
  let broker: Aedes | undefined;
  let server: Server | undefined;
  let tmpDir: string | undefined;

  let onKey: string;
  let briKey: string;
  let hueKey: string;
  let satKey: string;
  let nookHueKey: string;
  let nookSatKey: string;
  let nookTempKey: string;

  async function waitForValues(
    expected: Record<string, unknown>,
  ): Promise<void> {
    await poll(
      async () => {
        const values = await getCharValues(client!, ...Object.keys(expected));
        return Object.entries(expected).every(
          ([key, value]) => values.get(key) === value,
        );
      },
      50,
      3000,
    );
  }

  async function baseline(): Promise<void> {
    simulator!.setBrightness(BASELINE_BRI);
    simulator!.setColor(BASELINE_COL);
    await waitForValues({
      [onKey]: 1,
      [briKey]: BASELINE_HOMEKIT_BRIGHTNESS,
      [hueKey]: BASELINE_HUE,
      [satKey]: BASELINE_SATURATION,
    });
  }

  async function writeGreen(): Promise<void> {
    await client!.setCharacteristics({ [hueKey]: 120, [satKey]: 100 });
    await poll(
      () => {
        const { col } = simulator!.state;
        return col[0] === 0 && col[1] === 255 && col[2] === 0;
      },
      50,
      3000,
    );
  }

  before(async () => {
    broker = await Aedes.createBroker();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const addr = server.address();
    if (typeof addr !== "object" || !addr)
      throw new Error("Failed to bind server");
    const aedesPort = addr.port;

    if (process.env.VERBOSE === "1") {
      broker.on("publish", (packet: AedesPublishPacket) => {
        if (packet.topic.startsWith("$SYS")) return;
        console.log(`  MQTT: ${packet.topic} = ${packet.payload.toString()}`);
      });
    }

    const simReadyPromise = waitFor<AedesPublishPacket>(
      broker,
      "publish",
      (p) => p.topic === "wled/test1/g",
      5000,
      "topic wled/test1/g",
    );
    simulator = new WledSimulator(
      `mqtt://127.0.0.1:${String(aedesPort)}`,
      "wled/test1",
    );
    await simReadyPromise;

    const nookReadyPromise = waitFor<AedesPublishPacket>(
      broker,
      "publish",
      (p) => p.topic === "wled/nook/g",
      5000,
      "topic wled/nook/g",
    );
    nook = new WledSimulator(
      `mqtt://127.0.0.1:${String(aedesPort)}`,
      "wled/nook",
      3,
    );
    await nookReadyPromise;

    tmpDir = mkdtempSync(path.join(tmpdir(), "hoboken-integ-"));
    HAPStorage.setCustomStoragePath(tmpDir);

    const config: Config = {
      bridge: {
        name: "Test Bridge",
        mac: "0E:36:29:42:81:10",
        pincode: "031-45-154",
        port: 0,
      },
      mqtt: { url: `mqtt://127.0.0.1:${String(aedesPort)}` },
      devices: [
        {
          name: "Test WLED",
          type: "wled",
          topic: "wled/test1",
          capabilities: ["on_off", "brightness", "color_hs"],
        },
        {
          name: "Test Nook",
          type: "wled",
          topic: "wled/nook",
          capabilities: ["on_off", "brightness", "color_temp", "color_hs"],
          colorSegments: [0],
          whiteSegments: [1, 2],
          whiteChannels: { r: 5500, g: 2400, b: 5500, w: 2400 },
          gamma: 2.2,
        },
      ],
    };

    const bridgeSubPromise = waitFor<Subscription[]>(
      broker,
      "subscribe",
      (subs) => subs.some((s) => s.topic === "wled/nook/g"),
      5000,
      "subscribe wled/nook/g",
    );
    handle = await startBridge(config, "integration");
    await bridgeSubPromise;

    client = new HttpClient("test-client", "127.0.0.1", handle.hapPort);
    await client.pairSetup("031-45-154");

    const accs = (await client.getAccessories()) as AccessoryList;
    onKey = findChar(accs, ON_UUID);
    briKey = findChar(accs, BRIGHTNESS_UUID);
    hueKey = findChar(accs, HUE_UUID);
    satKey = findChar(accs, SATURATION_UUID);
    nookHueKey = findChar(accs, HUE_UUID, 1);
    nookSatKey = findChar(accs, SATURATION_UUID, 1);
    nookTempKey = findChar(accs, COLOR_TEMPERATURE_UUID);
  });

  after(async () => {
    const cleanup = await Promise.allSettled([
      client?.close(),
      handle?.shutdown(),
      simulator?.close(),
      nook?.close(),
    ]);
    if (broker) {
      await new Promise<void>((resolve) => {
        broker!.close(() => {
          resolve();
        });
      });
    }
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => {
          resolve();
        });
      });
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true });
    }
    for (const result of cleanup) {
      assert.equal(result.status, "fulfilled");
    }
  });

  test("no initial WLED state → SERVICE_COMMUNICATION_FAILURE", async () => {
    // WLED has no side-effect-free state request. The simulator published its
    // state on connect, but the bridge wasn't subscribed yet. Without MQTT
    // retain, the bridge has no cached state — onGet throws HapStatusError.
    const res = (await client!.getCharacteristics([
      onKey,
      briKey,
      hueKey,
      satKey,
    ])) as {
      characteristics: {
        aid: unknown;
        iid: unknown;
        value?: unknown;
        status?: number;
      }[];
    };
    // Guard against a vacuous pass: every requested characteristic must report
    // the failure status, so the loop below must actually iterate over all four.
    assert.equal(res.characteristics.length, 4);
    for (const ch of res.characteristics) {
      const key = `${String(ch.aid)}.${String(ch.iid)}`;
      assert.equal(
        ch.status,
        -70402,
        `Expected SERVICE_COMMUNICATION_FAILURE for ${key}`,
      );
    }
  });

  describe("from a known baseline", () => {
    beforeEach(baseline);

    test("HK→WLED turn off", async () => {
      await client!.setCharacteristics({ [onKey]: false });
      await poll(() => simulator!.state.bri === 0, 50, 3000);
      assert.equal(simulator!.state.bri, 0);
    });

    test("HK→WLED turn on", async () => {
      simulator!.setBrightness(0);
      await waitForValues({ [onKey]: 0 });
      await client!.setCharacteristics({ [onKey]: true });
      await poll(() => simulator!.state.bri > 0, 50, 3000);
      assert.ok(simulator!.state.bri > 0);
    });

    test("HK→WLED brightness 75%", async () => {
      await client!.setCharacteristics({ [briKey]: 75 });
      await poll(() => simulator!.state.bri === 191, 50, 3000);
      assert.equal(simulator!.state.bri, 191);
    });

    test("HK→WLED color green", async () => {
      await writeGreen();
      assert.deepEqual(simulator!.state.col, [0, 255, 0]);
    });

    test("color round-trip read-back", async () => {
      // HomeKit reads come from the state cache, and only inbound MQTT
      // updates change it, so the baseline's hue 240 gives way to the written
      // 120 only once WLED's echo of the write reaches the bridge.
      await writeGreen();
      await waitForValues({ [hueKey]: 120, [satKey]: 100 });
    });

    test("WLED→HK brightness 128→50%", async () => {
      simulator!.setBrightness(128);
      await waitForValues({ [briKey]: 50 });
    });

    test("WLED→HK color red→hue 0", async () => {
      simulator!.setColor([255, 0, 0]);
      await waitForValues({ [hueKey]: 0, [satKey]: 100 });
    });

    test("WLED→HK turn off", async () => {
      simulator!.setBrightness(0);
      await waitForValues({ [onKey]: 0 });
    });

    test("WLED→HK turn on", async () => {
      simulator!.setBrightness(0);
      await waitForValues({ [onKey]: 0 });
      simulator!.setBrightness(200);
      await waitForValues({ [onKey]: 1, [briKey]: 78 });
    });
  });

  describe("white segments", () => {
    const lit = (col: number[]) => ({ on: true, sel: true, col });

    async function waitForSegments(expected: unknown[]): Promise<void> {
      await poll(
        () => {
          try {
            assert.deepEqual(nook!.segments, expected);
            return true;
          } catch {
            return false;
          }
        },
        50,
        3000,
      );
    }

    test("HK→WLED color temperature blends the white strips", async () => {
      await client!.setCharacteristics({ [nookTempKey]: 299 });
      await waitForSegments([
        { on: false, sel: false, col: [255, 160, 0, 0] },
        lit([255, 255, 255, 255]),
        lit([255, 255, 255, 255]),
      ]);
      await waitForValues({
        [nookTempKey]: 299,
        [nookHueKey]: 30,
        [nookSatKey]: 50,
      });
    });

    test("HK→WLED white lights the white segments at 2700 K", async () => {
      await client!.setCharacteristics({ [nookHueKey]: 0, [nookSatKey]: 0 });
      await poll(() => nook!.segments[1]?.col[0] === 167, 50, 3000);
      assert.deepEqual(nook!.segments.slice(1), [
        lit([167, 255, 167, 255]),
        lit([167, 255, 167, 255]),
      ]);
      await waitForValues({ [nookTempKey]: 370 });
    });

    test("HK→WLED color lights the color segment alone", async () => {
      await client!.setCharacteristics({
        [nookHueKey]: 120,
        [nookSatKey]: 100,
      });
      await poll(() => nook!.segments[0]?.on === true, 50, 3000);
      assert.deepEqual(
        nook!.segments.map(({ on, sel }) => ({ on, sel })),
        [
          { on: true, sel: true },
          { on: false, sel: false },
          { on: false, sel: false },
        ],
      );
      assert.deepEqual(nook!.segments[0]?.col, [0, 255, 0, 0]);
      await waitForValues({
        [nookHueKey]: 120,
        [nookSatKey]: 100,
        [nookTempKey]: 182,
      });
    });

    test("HK→WLED color and white end an effect set in WLED", async () => {
      nook!.setEffect(0, 9);
      nook!.setEffect(1, 9);
      nook!.setEffect(2, 9);
      await client!.setCharacteristics({
        [nookHueKey]: 240,
        [nookSatKey]: 100,
      });
      await poll(() => nook!.effects[0] === 0, 50, 3000);
      assert.deepEqual(nook!.effects, [0, 9, 9]);
      await client!.setCharacteristics({ [nookHueKey]: 0, [nookSatKey]: 0 });
      await poll(() => nook!.effects[1] === 0, 50, 3000);
      assert.deepEqual(nook!.effects, [0, 0, 0]);
    });

    test("WLED→HK a white set on the device reads as its temperature", async () => {
      await client!.setCharacteristics({
        [nookHueKey]: 120,
        [nookSatKey]: 100,
      });
      await waitForValues({ [nookTempKey]: 182 });
      broker!.publish(
        {
          cmd: "publish",
          topic: "wled/nook/api",
          payload: Buffer.from(
            JSON.stringify({
              seg: [
                { id: 0, on: false, sel: false },
                { id: 1, on: true, sel: true, col: [[0, 255, 0, 255]] },
                { id: 2, on: true, sel: true, col: [[0, 255, 0, 255]] },
              ],
            }),
          ),
          qos: 0,
          retain: false,
          dup: false,
        },
        () => {
          /* published */
        },
      );
      await waitForValues({
        [nookTempKey]: 416,
        [nookHueKey]: 30,
        [nookSatKey]: 76,
      });
    });
  });

  test("MQTT disconnect → SERVICE_COMMUNICATION_FAILURE", async () => {
    await new Promise<void>((resolve) => {
      broker!.close(() => {
        server!.close(() => {
          resolve();
        });
      });
    });
    broker = undefined;
    server = undefined;

    await new Promise<void>((r) => setTimeout(r, 500));

    let gotExpectedError = false;
    try {
      const result = await client!.setCharacteristics({ [onKey]: true });
      const chars = result.characteristics as { status?: number }[] | undefined;
      if (chars?.[0]?.status === -70402) {
        gotExpectedError = true;
      }
    } catch (e: unknown) {
      const msg = String(e);
      if (
        msg.includes("-70402") ||
        msg.includes("SERVICE_COMMUNICATION_FAILURE")
      ) {
        gotExpectedError = true;
      }
    }
    assert.ok(
      gotExpectedError,
      "Expected SERVICE_COMMUNICATION_FAILURE (-70402)",
    );
  });
});
