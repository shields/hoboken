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
  published: { topic: string; message: string; opts?: object | undefined }[] =
    [];

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

    test("clamps out-of-range brightness to 255", () => {
      const sim = createSimulator();
      sendMessage("", "300");
      expect(sim.state.bri).toBe(255);
    });

    test("clamps negative brightness to 0", () => {
      const sim = createSimulator();
      sendMessage("", "-5");
      expect(sim.state.bri).toBe(0);
      expect(sim.state.briLast).toBe(128);
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

    test("{bri} clamps out-of-range value to 255", () => {
      const sim = createSimulator();
      sendMessage("/api", JSON.stringify({ bri: 300 }));
      expect(sim.state.bri).toBe(255);
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

    test("seg col as a 6-digit hex string sets color", () => {
      const sim = createSimulator();
      sendMessage("/api", JSON.stringify({ seg: [{ col: ["00FF00"] }] }));
      expect(sim.state.col).toEqual([0, 255, 0]);
    });

    test("seg col as an RGBW hex string keeps the white byte", () => {
      const sim = createSimulator();
      sendMessage("/api", JSON.stringify({ seg: [{ col: ["FF000080"] }] }));
      expect(sim.state.col).toEqual([255, 0, 0]);
      expect(sim.segments[0]?.col).toEqual([255, 0, 0, 128]);
    });

    test("seg col as an {r,g,b} object sets color", () => {
      const sim = createSimulator();
      sendMessage(
        "/api",
        JSON.stringify({ seg: [{ col: [{ r: 10, g: 20, b: 30 }] }] }),
      );
      expect(sim.state.col).toEqual([10, 20, 30]);
    });

    test("seg col as a partial object keeps unspecified channels", () => {
      const sim = createSimulator();
      // Initial col is [255, 160, 0]; only green is supplied.
      sendMessage("/api", JSON.stringify({ seg: [{ col: [{ g: 99 }] }] }));
      expect(sim.state.col).toEqual([255, 99, 0]);
    });

    test("seg col with a non-numeric array element reads it as 0", () => {
      const sim = createSimulator();
      sendMessage("/api", JSON.stringify({ seg: [{ col: [[1, 2, "x"]] }] }));
      expect(sim.segments[0]?.col).toEqual([1, 2, 0, 0]);
    });

    test("seg col with a primitive slot is a no-op", () => {
      const sim = createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ seg: [{ col: [42] }] }));
      expect(mockClient.published).toEqual([]);
      expect(sim.state.col).toEqual([255, 160, 0]);
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

    test("seg with col[0] fewer than 3 elements zero-fills the rest", () => {
      const sim = createSimulator();
      sendMessage("/api", JSON.stringify({ seg: [{ col: [[1, 2]] }] }));
      expect(sim.segments[0]?.col).toEqual([1, 2, 0, 0]);
    });

    test("seg with an empty col[0] array is a no-op", () => {
      createSimulator();
      clearPublished();
      sendMessage("/api", JSON.stringify({ seg: [{ col: [[]] }] }));
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
      mockClient.emit("message", `${TOPIC}/unknown`, Buffer.from("payload"));
      expect(mockClient.published).toEqual([]);
      expect(sim.state.bri).toBe(128);
    });
  });

  describe("segments", () => {
    function createSegmented(count: number) {
      const sim = new WledSimulator("mqtt://localhost", TOPIC, count);
      mockClient.emit("connect");
      return sim;
    }

    function api(body: unknown): void {
      sendMessage("/api", JSON.stringify(body));
    }

    function lastColor(): string | undefined {
      return mockClient.published.findLast((p) => p.topic === `${TOPIC}/c`)
        ?.message;
    }

    test("defaults to one selected, on segment with white 0", () => {
      expect(createSimulator().segments).toEqual([
        { on: true, sel: true, col: [255, 160, 0, 0] },
      ]);
    });

    test("only segment 0 is selected by default", () => {
      expect(createSegmented(3).segments.map((s) => s.sel)).toEqual([
        true,
        false,
        false,
      ]);
    });

    test("segments returns a copy", () => {
      const sim = createSegmented(2);
      const segs = sim.segments;
      (segs[0] as { col: number[] }).col[0] = 1;
      (segs[0] as { on: boolean }).on = false;
      expect(sim.segments[0]).toEqual({
        on: true,
        sel: true,
        col: [255, 160, 0, 0],
      });
    });

    test("array element without id addresses its index", () => {
      const sim = createSegmented(3);
      api({ seg: [{}, { col: [[1, 2, 3]] }] });
      expect(sim.segments.map((s) => s.col)).toEqual([
        [255, 160, 0, 0],
        [1, 2, 3, 0],
        [255, 160, 0, 0],
      ]);
    });

    test("array element with id addresses that segment", () => {
      const sim = createSegmented(3);
      api({ seg: [{ id: 2, col: [[1, 2, 3, 4]] }] });
      expect(sim.segments[2]?.col).toEqual([1, 2, 3, 4]);
      expect(sim.segments[0]?.col).toEqual([255, 160, 0, 0]);
    });

    test("an element without id still counts toward the index", () => {
      const sim = createSegmented(3);
      api({ seg: [{ id: 2, on: false }, { on: false }] });
      expect(sim.segments.map((s) => s.on)).toEqual([true, false, false]);
    });

    test("ids beyond the segment count are ignored", () => {
      const sim = createSegmented(2);
      clearPublished();
      api({
        seg: [
          { id: 5, col: [[1, 2, 3]] },
          { id: 7, on: false },
        ],
      });
      expect(sim.segments.map((s) => s.col)).toEqual([
        [255, 160, 0, 0],
        [255, 160, 0, 0],
      ]);
      expect(mockClient.published).toEqual([]);
    });

    test("non-object array elements are skipped but counted", () => {
      const sim = createSegmented(3);
      api({ seg: [7, null, { on: false }] });
      expect(sim.segments.map((s) => s.on)).toEqual([true, true, false]);
    });

    test("a seg object with id addresses that segment", () => {
      const sim = createSegmented(3);
      api({ seg: { id: 1, col: [[9, 8, 7]] } });
      expect(sim.segments[1]?.col).toEqual([9, 8, 7, 0]);
      expect(sim.segments[0]?.col).toEqual([255, 160, 0, 0]);
    });

    test("a seg object with an id beyond the count is ignored", () => {
      const sim = createSegmented(2);
      clearPublished();
      api({ seg: { id: 9, col: [[9, 8, 7]] } });
      expect(sim.segments[0]?.col).toEqual([255, 160, 0, 0]);
      expect(mockClient.published).toEqual([]);
    });

    test("a seg object without id applies to every selected segment", () => {
      const sim = createSegmented(3);
      api({ seg: [{}, { sel: true }] });
      api({ seg: { col: [[1, 2, 3, 4]] } });
      expect(sim.segments.map((s) => s.col)).toEqual([
        [1, 2, 3, 4],
        [1, 2, 3, 4],
        [255, 160, 0, 0],
      ]);
    });

    test("a seg object with a negative or non-numeric id applies to selected segments", () => {
      const sim = createSegmented(2);
      api({ seg: { id: "x", on: false } });
      expect(sim.segments.map((s) => s.on)).toEqual([false, true]);
      api({ seg: { id: -1, on: true } });
      expect(sim.segments.map((s) => s.on)).toEqual([true, true]);
    });

    test("a seg that is neither object nor array is ignored", () => {
      createSegmented(1);
      clearPublished();
      api({ seg: 5 });
      expect(mockClient.published).toEqual([]);
    });

    test("on false and true", () => {
      const sim = createSegmented(2);
      api({ seg: [{ on: false }, { on: false }] });
      expect(sim.segments.map((s) => s.on)).toEqual([false, false]);
      api({ seg: [{ id: 1, on: true }] });
      expect(sim.segments.map((s) => s.on)).toEqual([false, true]);
    });

    test("on 't' toggles and a non-boolean leaves it alone", () => {
      const sim = createSegmented(2);
      api({ seg: [{ on: "t" }, { on: 1 }] });
      expect(sim.segments.map((s) => s.on)).toEqual([false, true]);
      api({ seg: [{ on: "toggle" }] });
      expect(sim.segments[0]?.on).toBe(true);
      api({ seg: [{ on: "x" }] });
      expect(sim.segments[0]?.on).toBe(true);
    });

    test("sel true, false and 't'", () => {
      const sim = createSegmented(2);
      api({ seg: [{ sel: false }, { sel: true }] });
      expect(sim.segments.map((s) => s.sel)).toEqual([false, true]);
      api({ seg: [{ sel: "t" }, { sel: "t" }] });
      expect(sim.segments.map((s) => s.sel)).toEqual([true, false]);
    });

    test("seg on does not change brightness", () => {
      const sim = createSegmented(1);
      api({ seg: [{ on: false }] });
      expect(sim.state.bri).toBe(128);
    });

    test("RGB array zeroes white", () => {
      const sim = createSegmented(1);
      api({ seg: [{ col: [[1, 2, 3, 99]] }] });
      api({ seg: [{ col: [[4, 5, 6]] }] });
      expect(sim.segments[0]?.col).toEqual([4, 5, 6, 0]);
    });

    test("RGBW array sets all four channels", () => {
      const sim = createSegmented(1);
      api({ seg: [{ col: [[1, 2, 3, 4]] }] });
      expect(sim.segments[0]?.col).toEqual([1, 2, 3, 4]);
    });

    test("array channels are truncated to a byte", () => {
      const sim = createSegmented(1);
      api({ seg: [{ col: [[256, 300, -1, 1.9]] }] });
      expect(sim.segments[0]?.col).toEqual([0, 44, 255, 1]);
    });

    test("6-digit hex zeroes white", () => {
      const sim = createSegmented(1);
      api({ seg: [{ col: [[0, 0, 0, 9]] }] });
      api({ seg: [{ col: ["0A0B0C"] }] });
      expect(sim.segments[0]?.col).toEqual([10, 11, 12, 0]);
    });

    test("8-digit hex is RRGGBBWW", () => {
      const sim = createSegmented(1);
      api({ seg: [{ col: ["01020304"] }] });
      expect(sim.segments[0]?.col).toEqual([1, 2, 3, 4]);
    });

    test("hex of other lengths is ignored, non-hex digits read as 0", () => {
      const sim = createSegmented(1);
      clearPublished();
      api({ seg: [{ col: ["FFFFF"] }] });
      expect(mockClient.published).toEqual([]);
      api({ seg: [{ col: ["ZZZZZZ"] }] });
      expect(sim.segments[0]?.col).toEqual([0, 0, 0, 0]);
    });

    test("object keeps unspecified channels including white", () => {
      const sim = createSegmented(1);
      api({ seg: [{ col: [[1, 2, 3, 4]] }] });
      api({ seg: [{ col: [{ g: 50 }] }] });
      expect(sim.segments[0]?.col).toEqual([1, 50, 3, 4]);
      api({ seg: [{ col: [{ w: 7, r: "x", b: 1.5 }] }] });
      expect(sim.segments[0]?.col).toEqual([1, 50, 3, 7]);
    });

    test("only the first color slot is applied", () => {
      const sim = createSegmented(1);
      api({
        seg: [
          {
            col: [
              [1, 2, 3],
              [4, 5, 6],
            ],
          },
        ],
      });
      expect(sim.segments[0]?.col).toEqual([1, 2, 3, 0]);
    });

    test("/c publishes the first selected segment's color with white", () => {
      const sim = createSegmented(3);
      api({
        seg: [
          { id: 0, sel: false },
          { id: 1, sel: true, col: [[1, 2, 3, 4]] },
          { id: 2, sel: true, col: [[9, 9, 9]] },
        ],
      });
      expect(lastColor()).toBe("#4010203");
      expect(sim.state.col).toEqual([1, 2, 3]);
    });

    test("/c has 8 digits when white and red are high", () => {
      createSegmented(1);
      api({ seg: [{ col: [[255, 0, 0, 255]] }] });
      expect(lastColor()).toBe("#FFFF0000");
    });

    test("/c has 6 digits without white", () => {
      createSegmented(2);
      api({ seg: [{ id: 0, col: [[1, 2, 3]] }] });
      expect(lastColor()).toBe("#010203");
    });

    test("/c falls back to the main segment when none is selected", () => {
      const sim = createSegmented(2);
      api({
        seg: [
          { id: 1, col: [[1, 2, 3]] },
          { id: 0, sel: false },
        ],
      });
      expect(lastColor()).toBe("#FFA000");
      expect(sim.state.col).toEqual([255, 160, 0]);
    });

    test("a change to an unselected segment still publishes", () => {
      createSegmented(2);
      clearPublished();
      api({ seg: [{ id: 1, col: [[1, 2, 3]] }] });
      expect(lastColor()).toBe("#FFA000");
    });

    test("seg on change publishes", () => {
      createSegmented(2);
      clearPublished();
      api({ seg: [{ id: 1, on: false }] });
      expect(mockClient.published).toHaveLength(3);
    });

    test("selection change alone does not publish", () => {
      createSegmented(2);
      clearPublished();
      api({ seg: [{ id: 1, sel: true }] });
      expect(mockClient.published).toEqual([]);
    });

    test("an unchanged seg value does not publish", () => {
      createSegmented(2);
      clearPublished();
      api({ seg: [{ on: true, col: [[255, 160, 0, 0]] }] });
      expect(mockClient.published).toEqual([]);
    });

    test("/col applies to every selected segment including white", () => {
      const sim = createSegmented(3);
      api({ seg: [{}, { sel: true }] });
      sendMessage("/col", "#11223344");
      expect(sim.segments.map((s) => s.col)).toEqual([
        [0x22, 0x33, 0x44, 0x11],
        [0x22, 0x33, 0x44, 0x11],
        [255, 160, 0, 0],
      ]);
      expect(lastColor()).toBe("#11223344");
    });

    test("/col decimal carries white in the high byte", () => {
      const sim = createSegmented(1);
      sendMessage("/col", "4278190335");
      expect(sim.segments[0]?.col).toEqual([0, 0, 255, 255]);
    });

    test("/col with no selected segment changes nothing but still publishes", () => {
      const sim = createSegmented(2);
      api({ seg: [{ sel: false }] });
      clearPublished();
      sendMessage("/col", "#0000FF");
      expect(sim.segments.map((s) => s.col)).toEqual([
        [255, 160, 0, 0],
        [255, 160, 0, 0],
      ]);
      expect(lastColor()).toBe("#FFA000");
    });

    test("setColor sets selected segments with white 0", () => {
      const sim = createSegmented(2);
      api({ seg: [{ col: [[0, 0, 0, 5]] }, { sel: true }] });
      sim.setColor([1, 2, 3]);
      expect(sim.segments.map((s) => s.col)).toEqual([
        [1, 2, 3, 0],
        [1, 2, 3, 0],
      ]);
    });

    test("setColor falls back to segment 0 when none is selected", () => {
      const sim = createSegmented(2);
      api({ seg: [{ sel: false }] });
      sim.setColor([1, 2, 3]);
      expect(sim.segments.map((s) => s.col)).toEqual([
        [1, 2, 3, 0],
        [255, 160, 0, 0],
      ]);
    });
  });
});
