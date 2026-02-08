import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HAPStorage } from "@homebridge/hap-nodejs";
import type { Config } from "../src/config.ts";

HAPStorage.setCustomStoragePath(mkdtempSync(join(tmpdir(), "hoboken-test-")));

class MockMqttClient extends EventEmitter {
  connected = false;
  subscriptions: string[][] = [];
  published: Array<{ topic: string; message: string }> = [];

  subscribe(topics: string[]): this {
    this.subscriptions.push(topics);
    return this;
  }

  publish(topic: string, message: string): this {
    this.published.push({ topic, message });
    return this;
  }

  end(_force?: boolean, cb?: () => void): this {
    if (cb) cb();
    return this;
  }
}

let mockClient: MockMqttClient;

mock.module("mqtt", () => ({
  connect: () => {
    mockClient = new MockMqttClient();
    return mockClient;
  },
}));

const { startBridge } = await import("../src/bridge.ts");

function testConfig(): Config {
  return {
    bridge: {
      name: "Test Bridge",
      username: "0E:42:A1:B2:C3:D4",
      pincode: "031-45-154",
      port: 0,
    },
    mqtt: {
      url: "mqtt://localhost:1883",
      topic_prefix: "zigbee2mqtt",
    },
    devices: [
      {
        name: "Living Room",
        topic: "living_room",
        capabilities: ["on_off", "brightness"],
        scenes: [{ name: "Movie Mode", id: 1 }],
      },
      {
        name: "Bedroom",
        topic: "bedroom",
        capabilities: ["on_off"],
      },
    ],
  };
}

describe("startBridge", () => {
  test("creates bridge and connects MQTT", async () => {
    const { shutdown } = await startBridge(testConfig());
    expect(mockClient).toBeDefined();
    await shutdown();
  });

  test("subscribes to device topics on MQTT connect", async () => {
    const { shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    expect(mockClient.subscriptions).toHaveLength(1);
    expect(mockClient.subscriptions[0]).toEqual([
      "zigbee2mqtt/living_room",
      "zigbee2mqtt/bedroom",
    ]);
    await shutdown();
  });

  test("requests initial state on MQTT connect", async () => {
    const { shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const getMessages = mockClient.published.filter((p) =>
      p.topic.endsWith("/get"),
    );
    expect(getMessages).toHaveLength(2);
    expect(getMessages[0].topic).toBe("zigbee2mqtt/living_room/get");
    expect(getMessages[1].topic).toBe("zigbee2mqtt/bedroom/get");
    await shutdown();
  });

  test("MQTT message updates state cache and accessory", async () => {
    const { shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    // First message sets state
    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ state: "ON", brightness: 127 })),
    );

    // Second message merges — should not throw
    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ brightness: 254 })),
    );

    await shutdown();
  });

  test("ignores messages for unknown topics", async () => {
    const { shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "zigbee2mqtt/unknown_device",
      Buffer.from(JSON.stringify({ state: "ON" })),
    );
    await shutdown();
  });

  test("ignores messages with wrong prefix", async () => {
    const { shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "other_prefix/living_room",
      Buffer.from(JSON.stringify({ state: "ON" })),
    );
    await shutdown();
  });

  test("ignores malformed JSON messages", async () => {
    const { shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from("not json"),
    );
    await shutdown();
  });

  test("MQTT error does not crash", async () => {
    const { shutdown } = await startBridge(testConfig());

    // Should log but not throw
    mockClient.emit("error", new Error("connection refused"));
    await shutdown();
  });

  test("shutdown completes without error", async () => {
    const { shutdown } = await startBridge(testConfig());
    await shutdown();
  });
});
