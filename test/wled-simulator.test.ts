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

import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

// eslint-disable-next-line unicorn/prefer-event-target -- mocks mqtt.js EventEmitter API
class MockMqttClient extends EventEmitter {
  connected = false;
  subscriptions: string[][] = [];
  published: { topic: string; message: string; opts?: object | undefined }[] = [];

  subscribe(topics: string[]): this {
    this.subscriptions.push(topics);
    return this;
  }

  publish(topic: string, message: string, opts?: object): this {
    this.published.push({ topic, message, opts });
    return this;
  }

  end(_force?: boolean, cb?: () => void): this {
    if (cb) cb();
    return this;
  }
}

let mockClient: MockMqttClient;
let lastConnectOpts: Record<string, unknown> | undefined;

mock.module("mqtt", () => ({
  connect: (_url: string, opts?: Record<string, unknown>) => {
    lastConnectOpts = opts;
    mockClient = new MockMqttClient();
    return mockClient;
  },
}));

const { WledSimulator } = await import("../integration/wled-simulator.ts");

const TOPIC = "wled/test";

function createSimulator() {
  const sim = new WledSimulator("mqtt://localhost", TOPIC);
  mockClient.emit("connect");
  return sim;
}

function sendMessage(suffix: string, payload: string): void {
  mockClient.emit("message", `${TOPIC}${suffix}`, Buffer.from(payload));
}

function clearPublished(): void {
  mockClient.published = [];
}

describe("WledSimulator", () => {
  describe("constructor and connect", () => {
    test("connects with LWT", () => {
      new WledSimulator("mqtt://localhost", TOPIC);
      expect(lastConnectOpts).toEqual({
        will: {
          topic: `${TOPIC}/status`,
          payload: Buffer.from("offline"),
          qos: 0,
          retain: true,
        },
      });
    });

    test("subscribes to [topic, topic/col, topic/api] on connect", () => {
      new WledSimulator("mqtt://localhost", TOPIC);
      mockClient.emit("connect");
      expect(mockClient.subscriptions).toEqual([
        [TOPIC, `${TOPIC}/col`, `${TOPIC}/api`],
      ]);
    });

    test("publishes initial state on connect", () => {
      new WledSimulator("mqtt://localhost", TOPIC);
      mockClient.emit("connect");
      expect(mockClient.published).toHaveLength(3);
      expect(mockClient.published[0]).toMatchObject({
        topic: `${TOPIC}/g`,
        message: "128",
      });
      expect(mockClient.published[1]).toMatchObject({
        topic: `${TOPIC}/c`,
        message: "#FFA000",
      });
      expect(mockClient.published[2]).toMatchObject({
        topic: `${TOPIC}/status`,
        message: "online",
        opts: { retain: true },
      });
    });
  });

  describe("state getter", () => {
    test("returns initial state", () => {
      const sim = createSimulator();
      expect(sim.state).toEqual({
        bri: 128,
        briLast: 128,
        col: [255, 160, 0],
      });
    });

    test("returns a copy", () => {
      const sim = createSimulator();
      const s = sim.state;
      s.bri = 999;
      s.col[0] = 0;
      expect(sim.state).toEqual({
        bri: 128,
        briLast: 128,
        col: [255, 160, 0],
      });
    });
  });

  describe("setBrightness", () => {
    test("sets brightness and publishes", () => {
      const sim = createSimulator();
      clearPublished();
      sim.setBrightness(200);
      expect(sim.state.bri).toBe(200);
      expect(mockClient.published[0]).toMatchObject({
        topic: `${TOPIC}/g`,
        message: "200",
      });
    });

    test("saves briLast when setting to 0", () => {
      const sim = createSimulator();
      sim.setBrightness(200);
      sim.setBrightness(0);
      expect(sim.state.bri).toBe(0);
      expect(sim.state.briLast).toBe(200);
    });

    test("does not overwrite briLast when already off", () => {
      const sim = createSimulator();
      sim.setBrightness(0);
      const { briLast } = sim.state;
      sim.setBrightness(0);
      expect(sim.state.briLast).toBe(briLast);
    });

    test("updates briLast via publishState when bri > 0", () => {
      const sim = createSimulator();
      sim.setBrightness(0);
      expect(sim.state.briLast).toBe(128);
      sim.setBrightness(77);
      expect(sim.state.briLast).toBe(77);
    });
  });

  describe("setColor", () => {
    test("sets color and publishes hex", () => {
      const sim = createSimulator();
      clearPublished();
      sim.setColor([0, 128, 255]);
      expect(sim.state.col).toEqual([0, 128, 255]);
      expect(mockClient.published[1]).toMatchObject({
        topic: `${TOPIC}/c`,
        message: "#0080FF",
      });
    });

    test("does not alias the input array", () => {
      const sim = createSimulator();
      const input: [number, number, number] = [10, 20, 30];
      sim.setColor(input);
      input[0] = 99;
      expect(sim.state.col).toEqual([10, 20, 30]);
    });
  });

  describe("close", () => {
    test("calls client.end and resolves", async () => {
      const sim = createSimulator();
      await sim.close();
    });
  });

  describe("brightness payload (root topic)", () => {
    test("ON restores briLast", () => {
      const sim = createSimulator();
      sim.setBrightness(0);
      clearPublished();
      sendMessage("", "ON");
      expect(sim.state.bri).toBe(128);
    });

    test("on restores briLast", () => {
      const sim = createSimulator();
      sim.setBrightness(0);
      clearPublished();
      sendMessage("", "on");
      expect(sim.state.bri).toBe(128);
    });

    test("true restores briLast", () => {
      const sim = createSimulator();
      sim.setBrightness(0);
      clearPublished();
      sendMessage("", "true");
      expect(sim.state.bri).toBe(128);
    });

    test("T toggles off", () => {
      const sim = createSimulator();
      sendMessage("", "T");
      expect(sim.state.bri).toBe(0);
    });

    test("t toggles on", () => {
      const sim = createSimulator();
      sim.setBrightness(0);
      sendMessage("", "t");
      expect(sim.state.bri).toBe(128);
    });

    test("numeric string sets brightness", () => {
      const sim = createSimulator();
      sendMessage("", "200");
      expect(sim.state.bri).toBe(200);
    });

    test("0 saves briLast", () => {
      const sim = createSimulator();
      sendMessage("", "0");
      expect(sim.state.bri).toBe(0);
      expect(sim.state.briLast).toBe(128);
    });

    test("0 when already off does not overwrite briLast", () => {
      const sim = createSimulator();
      sim.setBrightness(77);
      sim.setBrightness(0);
      const { briLast } = sim.state;
      sendMessage("", "0");
      expect(sim.state.briLast).toBe(briLast);
    });

    test("non-numeric ignored, still publishes", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage("", "abc");
      expect(sim.state.bri).toBe(128);
      expect(mockClient.published).toHaveLength(3);
    });
  });

  describe("color payload (/col)", () => {
    test("#RRGGBB hex format", () => {
      const sim = createSimulator();
      sendMessage("/col", "#FF0000");
      expect(sim.state.col).toEqual([255, 0, 0]);
    });

    test("hRRGGBB hex format", () => {
      const sim = createSimulator();
      sendMessage("/col", "h00FF00");
      expect(sim.state.col).toEqual([0, 255, 0]);
    });

    test("HRRGGBB hex format", () => {
      const sim = createSimulator();
      sendMessage("/col", "H0000FF");
      expect(sim.state.col).toEqual([0, 0, 255]);
    });

    test("decimal integer decomposes to RGB", () => {
      const sim = createSimulator();
      sendMessage("/col", "16711680");
      expect(sim.state.col).toEqual([255, 0, 0]);
    });

    test("NaN payload returns early, no publish", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage("/col", "xyz");
      expect(mockClient.published).toEqual([]);
      expect(sim.state.col).toEqual([255, 160, 0]);
    });
  });

  describe("API payload (/api)", () => {
    test("non-JSON starting char is ignored", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage("/api", "not json");
      expect(mockClient.published).toEqual([]);
      expect(sim.state.bri).toBe(128);
    });

    test("invalid JSON is ignored", () => {
      createSimulator();
      clearPublished();
      sendMessage("/api", "{bad");
      expect(mockClient.published).toEqual([]);
    });

    test("{bri: N} sets brightness", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ bri: 200 }));
      expect(sim.state.bri).toBe(200);
      expect(mockClient.published).toHaveLength(3);
    });

    test("{bri: 0} saves briLast", () => {
      const sim = createSimulator();
      sendMessage("/api", JSON.stringify({ bri: 0 }));
      expect(sim.state.bri).toBe(0);
      expect(sim.state.briLast).toBe(128);
    });

    test("{on: true} restores briLast when off", () => {
      const sim = createSimulator();
      sim.setBrightness(0);
      clearPublished();
      sendMessage("/api", JSON.stringify({ on: true }));
      expect(sim.state.bri).toBe(128);
    });

    test("{on: true} is a no-op when already on", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ on: true }));
      expect(mockClient.published).toEqual([]);
      expect(sim.state.bri).toBe(128);
    });

    test("{on: false} turns off", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ on: false }));
      expect(sim.state.bri).toBe(0);
      expect(sim.state.briLast).toBe(128);
    });

    test("{on: false} is a no-op when already off", () => {
      const sim = createSimulator();
      sim.setBrightness(0);
      clearPublished();
      sendMessage("/api", JSON.stringify({ on: false }));
      expect(mockClient.published).toEqual([]);
      expect(sim.state.bri).toBe(0);
    });

    test("{on: 't'} toggles", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ on: "t" }));
      expect(sim.state.bri).toBe(0);
    });

    test("{bri + on: 't'} toggle guard prevents double-toggle", () => {
      const sim = createSimulator();
      sim.setBrightness(0);
      clearPublished();
      sendMessage("/api", JSON.stringify({ bri: 100, on: "t" }));
      expect(sim.state.bri).toBe(100);
    });

    test("{seg: [{col: [[r,g,b]]}]} sets color", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ seg: [{ col: [[0, 255, 128]] }] }));
      expect(sim.state.col).toEqual([0, 255, 128]);
    });

    test("{} is a no-op", () => {
      createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({}));
      expect(mockClient.published).toEqual([]);
    });

    test("combined bri + on:false + seg", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage(
        "/api",
        JSON.stringify({
          bri: 50,
          on: false,
          seg: [{ col: [[0, 0, 255]] }],
        }),
      );
      expect(sim.state.bri).toBe(0);
      expect(sim.state.briLast).toBe(50);
      expect(sim.state.col).toEqual([0, 0, 255]);
    });

    test("seg with empty array is a no-op", () => {
      createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ seg: [] }));
      expect(mockClient.published).toEqual([]);
    });

    test("seg with missing col is a no-op", () => {
      createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ seg: [{}] }));
      expect(mockClient.published).toEqual([]);
    });

    test("seg with non-array col is a no-op", () => {
      createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ seg: [{ col: "not array" }] }));
      expect(mockClient.published).toEqual([]);
    });

    test("seg with non-array col[0] is a no-op", () => {
      createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ seg: [{ col: ["not array"] }] }));
      expect(mockClient.published).toEqual([]);
    });

    test("seg with col[0] fewer than 3 elements is a no-op", () => {
      createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ seg: [{ col: [[1, 2]] }] }));
      expect(mockClient.published).toEqual([]);
    });
  });

  describe("publishState format", () => {
    test("/g is String(bri)", () => {
      const sim = createSimulator();
      clearPublished();
      sim.setBrightness(42);
      expect(mockClient.published[0]).toMatchObject({
        topic: `${TOPIC}/g`,
        message: "42",
      });
    });

    test("/c is uppercase zero-padded hex", () => {
      const sim = createSimulator();
      sim.setColor([0, 0, 255]);
      const cMsg = mockClient.published.find(
        (p) => p.topic === `${TOPIC}/c` && p.message === "#0000FF",
      );
      expect(cMsg).toBeDefined();
    });

    test("/status is online with retain", () => {
      createSimulator();
      const statusMsg = mockClient.published.find(
        (p) => p.topic === `${TOPIC}/status`,
      );
      expect(statusMsg).toMatchObject({
        topic: `${TOPIC}/status`,
        message: "online",
        opts: { retain: true },
      });
    });
  });

  describe("message routing", () => {
    test("unrecognized suffix is ignored", () => {
      const sim = createSimulator();
      clearPublished();
      mockClient.emit(
        "message",
        `${TOPIC}/unknown`,
        Buffer.from("payload"),
      );
      expect(mockClient.published).toEqual([]);
      expect(sim.state.bri).toBe(128);
    });
  });
});
