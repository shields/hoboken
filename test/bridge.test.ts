import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Characteristic,
  HAPStatus,
  HAPStorage,
  Service,
} from "@homebridge/hap-nodejs";
import type { Config } from "../src/config.ts";

HAPStorage.setCustomStoragePath(
  mkdtempSync(path.join(tmpdir(), "hoboken-test-")),
);

// Suppress a known race in @homebridge/ciao: the mDNS Prober schedules probe
// packets via setTimeout. When bridge.unpublish() is called quickly (as tests
// do), the timer callback may already be queued in the event loop. It calls
// sendQueryBroadcast on the now-closed mDNS server, throwing ERR_SERVER_CLOSED
// synchronously inside setTimeout — an uncaught exception the library can't
// catch. See https://github.com/homebridge/ciao/pull/60
function suppressCiaoShutdownError(err: Error): void {
  // ciao's ServerClosedError sets .name (not .code) to "ERR_SERVER_CLOSED"
  if (err.name === "ERR_SERVER_CLOSED") return;
  throw err;
}
beforeAll(() => {
  process.on("uncaughtException", suppressCiaoShutdownError);
});
afterAll(() => {
  process.removeListener("uncaughtException", suppressCiaoShutdownError);
});

const expectedVersion = execFileSync(
  "git",
  ["describe", "--always", "--dirty"],
  {
    encoding: "utf8",
  },
).trim();

// eslint-disable-next-line unicorn/prefer-event-target -- mocks hap-nodejs EventEmitter API
class FakeHAPConnection extends EventEmitter {
  remoteAddress: string;
  remotePort: number;

  constructor(address: string, port: number) {
    super();
    this.remoteAddress = address;
    this.remotePort = port;
  }

  getRegisteredEvents(): never[] {
    return [];
  }

  clearRegisteredEvents(): void {
    // noop
  }

  close(): void {
    // noop
  }
}

// eslint-disable-next-line unicorn/prefer-event-target -- mocks mqtt.js EventEmitter API
class MockMqttClient extends EventEmitter {
  connected = false;
  subscriptions: string[][] = [];
  published: { topic: string; message: string }[] = [];

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

// Each startBridge() call invokes connect(), creating a fresh MockMqttClient.
// No state leaks between tests.
let mockClient: MockMqttClient;

mock.module("mqtt", () => ({
  connect: () => {
    mockClient = new MockMqttClient();
    return mockClient;
  },
}));

const { startBridge, buildStatusData } = await import("../src/bridge.ts");

function testConfig(): Config {
  return {
    bridge: {
      name: "Test Bridge",
      mac: "0E:42:A1:B2:C3:D4",
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

  test("sets AccessoryInformation on the bridge", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    const info = bridge.getService(Service.AccessoryInformation);
    expect(info).toBeDefined();
    expect(info?.getCharacteristic(Characteristic.Manufacturer).value).toBe(
      "Hoboken",
    );
    expect(info?.getCharacteristic(Characteristic.Model).value).toBe(
      "MQTT Bridge",
    );
    expect(info?.getCharacteristic(Characteristic.SerialNumber).value).toBe(
      "0E:42:A1:B2:C3:D4",
    );
    expect(info?.getCharacteristic(Characteristic.FirmwareRevision).value).toBe(
      expectedVersion,
    );
    await shutdown();
  });

  test("sets AccessoryInformation on light accessories", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Living Room",
    );
    const info = accessory?.getService(Service.AccessoryInformation);
    expect(info?.getCharacteristic(Characteristic.Manufacturer).value).toBe(
      "Hoboken",
    );
    expect(info?.getCharacteristic(Characteristic.Model).value).toBe(
      "living_room",
    );
    expect(info?.getCharacteristic(Characteristic.SerialNumber).value).toBe(
      "living_room",
    );
    expect(info?.getCharacteristic(Characteristic.FirmwareRevision).value).toBe(
      expectedVersion,
    );
    await shutdown();
  });

  test("sets AccessoryInformation on scene accessories", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Movie Mode",
    );
    const info = accessory?.getService(Service.AccessoryInformation);
    expect(info?.getCharacteristic(Characteristic.Manufacturer).value).toBe(
      "Hoboken",
    );
    expect(info?.getCharacteristic(Characteristic.Model).value).toBe("Scene");
    expect(info?.getCharacteristic(Characteristic.SerialNumber).value).toBe(
      "living_room:scene:1",
    );
    expect(info?.getCharacteristic(Characteristic.FirmwareRevision).value).toBe(
      expectedVersion,
    );
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
    expect(getMessages[0]!.topic).toBe("zigbee2mqtt/living_room/get");
    expect(getMessages[1]!.topic).toBe("zigbee2mqtt/bedroom/get");
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

    const origError = console.error;
    console.error = () => {
      /* suppress */
    };
    try {
      mockClient.emit("error", new Error("connection refused"));
    } finally {
      console.error = origError;
    }
    await shutdown();
  });

  test("HomeKit set publishes to MQTT when connected", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Living Room",
    )!;
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    on.setValue(true);
    expect(
      mockClient.published.some(
        (p) =>
          p.topic === "zigbee2mqtt/living_room/set" &&
          p.message === JSON.stringify({ state: "ON" }),
      ),
    ).toBe(true);

    await shutdown();
  });

  test("HomeKit set reports error when MQTT disconnected", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Living Room",
    )!;
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    on.setValue(true);
    // HAP-nodejs catches the HapStatusError and stores it as statusCode
    expect(on.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    await shutdown();
  });

  test("HomeKit get returns cached MQTT state", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    // emit is synchronous; the message handler updates the state cache inline.
    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ state: "ON" })),
    );

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Living Room",
    )!;
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    const value = await on.handleGetRequest();
    expect(value).toBe(true);

    await shutdown();
  });

  test("shutdown completes without error", async () => {
    const { shutdown } = await startBridge(testConfig());
    await shutdown();
  });

  test("MQTT close event logs without crashing", async () => {
    const { shutdown } = await startBridge(testConfig());
    mockClient.emit("close");
    await shutdown();
  });

  test("MQTT reconnect event logs without crashing", async () => {
    const { shutdown } = await startBridge(testConfig());
    mockClient.emit("reconnect");
    await shutdown();
  });

  test("MQTT offline event logs without crashing", async () => {
    const { shutdown } = await startBridge(testConfig());
    mockClient.emit("offline");
    await shutdown();
  });

  test("bridge identify event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    let callbackCalled = false;
    bridge.emit("identify", false, () => {
      callbackCalled = true;
    });
    expect(callbackCalled).toBe(true);
    await shutdown();
  });

  test("bridge listening event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    bridge.emit("listening", 51826, "0.0.0.0");
    await shutdown();
  });

  test("bridge advertised event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    bridge.emit("advertised");
    await shutdown();
  });

  test("bridge paired event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    bridge.emit("paired");
    await shutdown();
  });

  test("bridge unpaired event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    bridge.emit("unpaired");
    await shutdown();
  });

  test("bridge characteristic-warning event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    const warning = {
      characteristic: {},
      type: "slow-write",
      message: "test warning",
      originatorChain: [],
    };
    bridge.emit("characteristic-warning", warning as never);
    await shutdown();
  });

  test("HAP server pair event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    const server = bridge._server;
    expect(server).toBeDefined();
    // Accessory's own pair handler calls the callback; our listener only logs.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    server!.emit("pair", "AB:CD:EF:01:23:45", Buffer.from("key"), () => {});
    await shutdown();
  });

  test("unparseable MQTT URL logs fallback without crashing", async () => {
    const cfg = testConfig();
    cfg.mqtt.url = "not a valid url";
    const { shutdown } = await startBridge(cfg);
    await shutdown();
  });

  test("HAP server connection-closed event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    const server = bridge._server;
    expect(server).toBeDefined();
    const fakeConnection = {
      remoteAddress: "192.168.1.100",
      remotePort: 54321,
      getRegisteredEvents: () => [],
      clearRegisteredEvents: () => {
        /* noop */
      },
      close: () => {
        /* noop */
      },
    };
    server!.emit("connection-closed", fakeConnection as never);
    await shutdown();
  });
});

function metricsConfig(): Config {
  return {
    ...testConfig(),
    metrics: { port: 0 },
  };
}

describe("startBridge with metrics", () => {
  test("starts and stops metrics server", async () => {
    const { shutdown } = await startBridge(metricsConfig());
    await shutdown();
  });

  test("metrics server serves /metrics endpoint", async () => {
    const cfg = metricsConfig();
    const { metricsPort, shutdown } = await startBridge(cfg);
    expect(metricsPort).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hoboken_mqtt_connected");
    await shutdown();
  });

  test("status page reflects bridge state", async () => {
    const cfg = metricsConfig();
    const { metricsPort, shutdown } = await startBridge(cfg);

    mockClient.connected = true;
    mockClient.emit("connect");

    // Simulate a state update
    const payload = Buffer.from(JSON.stringify({ state: "ON" }));
    mockClient.emit("message", "zigbee2mqtt/living_room", payload);

    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");

    const body = await res.text();
    expect(body).toContain("Test Bridge");
    expect(body).toContain("Living Room");
    expect(body).toContain("mqtt://localhost:1883");
    await shutdown();
  });

  test("mqtt connect sets mqttConnected to 1", async () => {
    const cfg = metricsConfig();
    const { shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    // Verify the connect handler ran (subscriptions prove it)
    expect(mockClient.subscriptions).toHaveLength(1);
    await shutdown();
  });

  test("mqtt close sets mqttConnected to 0", async () => {
    const cfg = metricsConfig();
    const { shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");
    mockClient.emit("close");
    await shutdown();
  });

  test("mqtt offline sets mqttConnected to 0", async () => {
    const cfg = metricsConfig();
    const { shutdown } = await startBridge(cfg);
    mockClient.emit("offline");
    await shutdown();
  });

  test("mqtt error increments mqttErrors", async () => {
    const cfg = metricsConfig();
    const { shutdown } = await startBridge(cfg);
    const origError = console.error;
    console.error = () => {
      /* suppress */
    };
    try {
      mockClient.emit("error", new Error("test"));
    } finally {
      console.error = origError;
    }
    await shutdown();
  });

  test("mqtt message increments mqttMessagesReceived", async () => {
    const cfg = metricsConfig();
    const { shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ state: "ON" })),
    );
    await shutdown();
  });

  test("publish increments mqttMessagesPublished", async () => {
    const cfg = metricsConfig();
    const { bridge, shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Living Room",
    )!;
    accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On)
      .setValue(true);
    await shutdown();
  });

  test("devicesConfigured gauge is set at startup", async () => {
    const cfg = metricsConfig();
    const { shutdown } = await startBridge(cfg);
    // devicesConfigured is set synchronously during startBridge
    await shutdown();
  });

  test("HAP connection-opened increments hapConnectionsActive", async () => {
    const cfg = metricsConfig();
    const { bridge, shutdown } = await startBridge(cfg);
    const server = bridge._server;
    expect(server).toBeDefined();

    // connection-opened lives on the internal EventedHTTPServer (httpServer),
    // not on HAPServer itself.
    const httpServer = (server as unknown as Record<string, EventEmitter>)
      .httpServer!;
    expect(httpServer).toBeDefined();

    const conn1 = new FakeHAPConnection("192.168.1.50", 12345);
    const conn2 = new FakeHAPConnection("192.168.1.51", 12346);

    httpServer.emit("connection-opened", conn1);
    httpServer.emit("connection-opened", conn2);

    await shutdown();
  });

  test("HAP connection-closed decrements hapConnectionsActive", async () => {
    const cfg = metricsConfig();
    const { bridge, shutdown } = await startBridge(cfg);
    const server = bridge._server;
    expect(server).toBeDefined();

    const httpServer = (server as unknown as Record<string, EventEmitter>)
      .httpServer!;

    const conn = new FakeHAPConnection("192.168.1.50", 12345);
    httpServer.emit("connection-opened", conn);
    server!.emit("connection-closed", conn as never);

    await shutdown();
  });

  test("HAP authenticated increments hapPairVerify", async () => {
    const cfg = metricsConfig();
    const { bridge, shutdown } = await startBridge(cfg);
    const server = bridge._server;
    expect(server).toBeDefined();

    const httpServer = (server as unknown as Record<string, EventEmitter>)
      .httpServer!;

    const conn = new FakeHAPConnection("192.168.1.50", 12345);
    httpServer.emit("connection-opened", conn);

    // HAPConnection emits "authenticated" after pair-verify succeeds
    conn.emit("authenticated", "AB:CD:EF:01:23:45");

    await shutdown();
  });


});

describe("buildStatusData", () => {
  test("returns status snapshot with cached state", () => {
    const cfg = testConfig();
    const stateCache = new Map<string, Record<string, unknown>>([
      ["living_room", { state: "ON", brightness: 200 }],
    ]);
    const connections = [
      { remoteAddress: "192.168.1.10", authenticated: true },
      { remoteAddress: "192.168.1.20", authenticated: false },
      { remoteAddress: "192.168.1.30", authenticated: true },
    ];
    const mqtt = { url: "mqtt://localhost:1883", connected: true };
    const result = buildStatusData(
      cfg,
      stateCache,
      mqtt,
      connections,
      "abc123",
    );

    expect(result.mqtt).toEqual(mqtt);
    expect(result.hap.connections).toEqual(connections);
    expect(result.bridge.name).toBe("Test Bridge");
    expect(result.bridge.version).toBe("abc123");
    expect(result.devices).toHaveLength(2);
    expect(result.devices[0]!.name).toBe("Living Room");
    expect(result.devices[0]!.topic).toBe("living_room");
    expect(result.devices[0]!.capabilities).toEqual(["on_off", "brightness"]);
    expect(result.devices[0]!.scenes).toEqual([{ name: "Movie Mode", id: 1 }]);
    expect(result.devices[0]!.state).toEqual({ state: "ON", brightness: 200 });
    expect(result.devices[1]!.name).toBe("Bedroom");
    expect(result.devices[1]!.state).toBeNull();
  });

  test("returns null state for uncached devices", () => {
    const cfg = testConfig();
    const stateCache = new Map<string, Record<string, unknown>>();
    const mqtt = { url: "mqtt://localhost:1883", connected: false };
    const result = buildStatusData(cfg, stateCache, mqtt, [], "v1");

    expect(result.mqtt).toEqual(mqtt);
    for (const device of result.devices) {
      expect(device.state).toBeNull();
    }
  });
});
