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

function findChar(accs: AccessoryList, typeUuid: string): string {
  for (const acc of accs.accessories) {
    for (const svc of acc.services) {
      for (const ch of svc.characteristics) {
        if (ch.type.toUpperCase() === typeUuid) {
          return `${String(acc.aid)}.${String(ch.iid)}`;
        }
      }
    }
  }
  throw new Error(`Characteristic ${typeUuid} not found`);
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
      if (match(arg)) {
        clearTimeout(timer);
        broker.removeListener(event, handler);
        resolve();
      }
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

describe("WLED integration", { timeout: 30000 }, () => {
  let simulator: WledSimulator | undefined;
  let handle: Awaited<ReturnType<typeof startBridge>> | undefined;
  let client: InstanceType<typeof HttpClient> | undefined;
  let broker: Aedes | undefined;
  let server: Server | undefined;
  let tmpDir: string | undefined;

  let onKey: string;
  let briKey: string;
  let hueKey: string;
  let satKey: string;

  before(async () => {
    broker = await Aedes.createBroker();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const addr = server.address();
    if (typeof addr !== "object" || !addr) throw new Error("Failed to bind server");
    const aedesPort = addr.port;

    if (process.env.VERBOSE === "1") {
      broker.on("publish", (packet: AedesPublishPacket) => {
        if (packet.topic.startsWith("$SYS")) return;
        console.log(`  MQTT: ${packet.topic} = ${packet.payload.toString()}`);
      });
    }

    const simReadyPromise = waitFor<AedesPublishPacket>(
      broker, "publish", (p) => p.topic === "wled/test1/g", 5000, "topic wled/test1/g",
    );
    simulator = new WledSimulator(`mqtt://127.0.0.1:${String(aedesPort)}`, "wled/test1");
    await simReadyPromise;

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
      ],
    };

    const bridgeSubPromise = waitFor<Subscription[]>(
      broker, "subscribe", (subs) => subs.some((s) => s.topic === "wled/test1/g"),
      5000, "subscribe wled/test1/g",
    );
    handle = await startBridge(config);
    await bridgeSubPromise;

    client = new HttpClient("test-client", "127.0.0.1", handle.hapPort);
    await client.pairSetup("031-45-154");

    const accs = (await client.getAccessories()) as AccessoryList;
    onKey = findChar(accs, ON_UUID);
    briKey = findChar(accs, BRIGHTNESS_UUID);
    hueKey = findChar(accs, HUE_UUID);
    satKey = findChar(accs, SATURATION_UUID);
  });

  after(async () => {
    try { await client?.close(); } catch { /* ignore */ }
    try { if (handle) await handle.shutdown(); } catch { /* ignore */ }
    try { if (simulator) await simulator.close(); } catch { /* ignore */ }
    if (broker) {
      await new Promise<void>((resolve) => {
        broker!.close(() => { resolve(); });
      });
    }
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => { resolve(); });
      });
    }
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }
  });

  test("no initial WLED state → SERVICE_COMMUNICATION_FAILURE", async () => {
    // WLED has no side-effect-free state request. The simulator published its
    // state on connect, but the bridge wasn't subscribed yet. Without MQTT
    // retain, the bridge has no cached state — onGet throws HapStatusError.
    const res = (await client!.getCharacteristics([onKey, briKey, hueKey, satKey])) as {
      characteristics: { aid: unknown; iid: unknown; value?: unknown; status?: number }[];
    };
    for (const ch of res.characteristics) {
      const key = `${String(ch.aid)}.${String(ch.iid)}`;
      assert.equal(ch.status, -70402, `Expected SERVICE_COMMUNICATION_FAILURE for ${key}`);
    }
  });

  test("HK→WLED turn off", async () => {
    await client!.setCharacteristics({ [onKey]: false });
    await poll(() => simulator!.state.bri === 0, 50, 3000);
    assert.equal(simulator!.state.bri, 0);
  });

  test("HK→WLED turn on", async () => {
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
    await client!.setCharacteristics({ [hueKey]: 120, [satKey]: 100 });
    await poll(() => {
      const { col } = simulator!.state;
      return col[0] === 0 && col[1] === 255 && col[2] === 0;
    }, 50, 3000);
    assert.deepEqual(simulator!.state.col, [0, 255, 0]);
  });

  test("color round-trip read-back", async () => {
    // After setting green (H=120, S=100) above, wait for the WLED echo to
    // propagate back through the bridge, then verify HK reads the same values.
    await new Promise<void>((r) => setTimeout(r, 600));
    const values = await getCharValues(client!, hueKey, satKey);
    assert.equal(values.get(hueKey), 120);
    assert.equal(values.get(satKey), 100);
  });

  test("WLED→HK brightness 128→50%", async () => {
    simulator!.setBrightness(128);
    await poll(async () => {
      const values = await getCharValues(client!, briKey);
      return values.get(briKey) === 50;
    }, 50, 3000);
  });

  test("WLED→HK color red→hue 0", async () => {
    simulator!.setColor([255, 0, 0]);
    await poll(async () => {
      const values = await getCharValues(client!, hueKey, satKey);
      return values.get(hueKey) === 0 && values.get(satKey) === 100;
    }, 50, 3000);
  });

  test("WLED→HK turn off", async () => {
    simulator!.setBrightness(0);
    await poll(async () => {
      const values = await getCharValues(client!, onKey);
      return values.get(onKey) === 0;
    }, 50, 3000);
  });

  test("WLED→HK turn on", async () => {
    simulator!.setBrightness(200);
    await poll(async () => {
      const values = await getCharValues(client!, onKey, briKey);
      return values.get(onKey) === 1 && values.get(briKey) === 78;
    }, 50, 3000);
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
      if (msg.includes("-70402") || msg.includes("SERVICE_COMMUNICATION_FAILURE")) {
        gotExpectedError = true;
      }
    }
    assert.ok(gotExpectedError, "Expected SERVICE_COMMUNICATION_FAILURE (-70402)");
  });
});
