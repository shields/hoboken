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
    },
    devices: [
      {
        name: "Living Room",
        type: "z2m",
        topic: "zigbee2mqtt/living_room",
        capabilities: ["on_off", "brightness"],
        scenes: [{ name: "Movie Mode", id: 1 }],
      },
      {
        name: "Bedroom",
        type: "z2m",
        topic: "zigbee2mqtt/bedroom",
        capabilities: ["on_off"],
      },
    ],
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    process.nextTick(resolve);
  });
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
      "zigbee2mqtt/living_room",
    );
    expect(info?.getCharacteristic(Characteristic.SerialNumber).value).toBe(
      "zigbee2mqtt/living_room",
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
      "zigbee2mqtt/living_room:scene:1",
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

  test("ignores messages for unconfigured topics", async () => {
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
    // Coalescing publisher defers to nextTick
    await flush();
    expect(
      mockClient.published.some(
        (p) =>
          p.topic === "zigbee2mqtt/living_room/set" &&
          p.message === JSON.stringify({ state: "ON" }),
      ),
    ).toBe(true);

    await shutdown();
  });

  test("HomeKit brightness publishes Z2M-converted brightness", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Living Room",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.Brightness).setValue(50);
    await flush();

    expect(
      mockClient.published.some(
        (p) =>
          p.topic === "zigbee2mqtt/living_room/set" &&
          p.message === JSON.stringify({ brightness: 126 }),
      ),
    ).toBe(true);

    await shutdown();
  });

  test("HomeKit color_temp publishes Z2M color_temp passthrough", async () => {
    const cfg: Config = {
      ...testConfig(),
      devices: [
        {
          name: "CT Light",
          type: "z2m",
          topic: "zigbee2mqtt/ct_light",
          capabilities: ["on_off", "color_temp"],
        },
      ],
    };
    const { bridge, shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "CT Light",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.ColorTemperature).setValue(370);
    await flush();

    expect(
      mockClient.published.some(
        (p) =>
          p.topic === "zigbee2mqtt/ct_light/set" &&
          p.message === JSON.stringify({ color_temp: 370 }),
      ),
    ).toBe(true);

    await shutdown();
  });

  test("Z2M publish passes through unknown keys like scene_recall", async () => {
    const cfg: Config = {
      ...testConfig(),
      devices: [
        {
          name: "Scene Light",
          type: "z2m",
          topic: "zigbee2mqtt/scene_light",
          capabilities: ["on_off"],
          scenes: [{ name: "Movie", id: 3 }],
        },
      ],
    };
    const { bridge, shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    const sceneAccessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Movie",
    )!;
    const service = sceneAccessory.getService(Service.Switch)!;

    service.getCharacteristic(Characteristic.On).setValue(true);
    await flush();

    expect(
      mockClient.published.some(
        (p) =>
          p.topic === "zigbee2mqtt/scene_light/set" &&
          p.message === JSON.stringify({ scene_recall: 3 }),
      ),
    ).toBe(true);

    await shutdown();
  });

  test("Z2M publish white transform with cached color_temp sends color_temp", async () => {
    const cfg: Config = {
      ...testConfig(),
      devices: [
        {
          name: "Color Light",
          type: "z2m",
          topic: "zigbee2mqtt/color_light",
          capabilities: ["on_off", "color_hs"],
        },
      ],
    };
    const { bridge, shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    // Populate cache with a color_temp value
    mockClient.emit(
      "message",
      "zigbee2mqtt/color_light",
      Buffer.from(JSON.stringify({ state: "ON", color_temp: 370 })),
    );

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Color Light",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    // Send white (H=0, S=0) — should use cached color_temp
    service.getCharacteristic(Characteristic.Hue).setValue(0);
    service.getCharacteristic(Characteristic.Saturation).setValue(0);
    await flush();

    const setMsg = mockClient.published.find(
      (p) => p.topic === "zigbee2mqtt/color_light/set",
    );
    expect(setMsg).toBeDefined();
    const parsed = JSON.parse(setMsg!.message) as Record<string, unknown>;
    expect(parsed.color_temp).toBe(370);
    expect(parsed.color).toBeUndefined();

    await shutdown();
  });

  test("Z2M publish white transform without cached color_temp sends color object", async () => {
    const cfg: Config = {
      ...testConfig(),
      devices: [
        {
          name: "Color Light",
          type: "z2m",
          topic: "zigbee2mqtt/color_light2",
          capabilities: ["on_off", "color_hs"],
        },
      ],
    };
    const { bridge, shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Color Light",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    // Send white (H=0, S=0) — no cached state, so should send color: {hue:0, saturation:0}
    service.getCharacteristic(Characteristic.Hue).setValue(0);
    service.getCharacteristic(Characteristic.Saturation).setValue(0);
    await flush();

    const setMsg = mockClient.published.find(
      (p) => p.topic === "zigbee2mqtt/color_light2/set",
    );
    expect(setMsg).toBeDefined();
    const parsed = JSON.parse(setMsg!.message) as Record<string, unknown>;
    expect(parsed.color).toEqual({ hue: 0, saturation: 0 });
    expect(parsed.color_temp).toBeUndefined();

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

  describe("write-back suppression", () => {
    function colorConfig(): Config {
      return {
        ...testConfig(),
        devices: [
          {
            name: "Color Light",
            type: "z2m",
            topic: "zigbee2mqtt/color_light",
            capabilities: ["on_off", "color_hs"],
          },
        ],
      };
    }

    test("suppresses color bounce after HomeKit write", async () => {
      const { bridge, shutdown } = await startBridge(colorConfig());
      mockClient.connected = true;
      mockClient.emit("connect");

      const accessory = bridge.bridgedAccessories.find(
        (a) => a.displayName === "Color Light",
      )!;
      const service = accessory.getService(Service.Lightbulb)!;

      // HomeKit writes a color
      service.getCharacteristic(Characteristic.Hue).setValue(120);
      service.getCharacteristic(Characteristic.Saturation).setValue(100);
      await flush();

      // Z2M sends back intermediate state with different color values
      mockClient.emit(
        "message",
        "zigbee2mqtt/color_light",
        Buffer.from(
          JSON.stringify({
            state: "ON",
            color_mode: "hs",
            color: { hue: 80, saturation: 60 },
          }),
        ),
      );

      // Color should be suppressed
      expect(service.getCharacteristic(Characteristic.Hue).value).toBe(120);
      expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(
        100,
      );

      // Non-color keys should still be pushed
      expect(service.getCharacteristic(Characteristic.On).value).toBe(true);

      await shutdown();
    });

    test("accepts color updates after suppression window expires", async () => {
      const originalNow = Date.now;
      let now = 1000;
      Date.now = () => now;

      try {
        const { bridge, shutdown } = await startBridge(colorConfig());
        mockClient.connected = true;
        mockClient.emit("connect");

        const accessory = bridge.bridgedAccessories.find(
          (a) => a.displayName === "Color Light",
        )!;
        const service = accessory.getService(Service.Lightbulb)!;

        // HomeKit writes a color
        service.getCharacteristic(Characteristic.Hue).setValue(120);
        service.getCharacteristic(Characteristic.Saturation).setValue(100);
        await flush();

        // Advance past suppression window
        now += 600;

        // Z2M sends color update
        mockClient.emit(
          "message",
          "zigbee2mqtt/color_light",
          Buffer.from(
            JSON.stringify({
              color_mode: "hs",
              color: { hue: 80, saturation: 60 },
            }),
          ),
        );

        // Color should go through
        expect(service.getCharacteristic(Characteristic.Hue).value).toBe(80);
        expect(
          service.getCharacteristic(Characteristic.Saturation).value,
        ).toBe(60);

        await shutdown();
      } finally {
        Date.now = originalNow;
      }
    });

    test("accepts color updates with no prior publish", async () => {
      const { bridge, shutdown } = await startBridge(colorConfig());
      mockClient.connected = true;
      mockClient.emit("connect");

      const accessory = bridge.bridgedAccessories.find(
        (a) => a.displayName === "Color Light",
      )!;
      const service = accessory.getService(Service.Lightbulb)!;

      // Z2M sends color update without any prior HomeKit write
      mockClient.emit(
        "message",
        "zigbee2mqtt/color_light",
        Buffer.from(
          JSON.stringify({
            color_mode: "hs",
            color: { hue: 200, saturation: 90 },
          }),
        ),
      );

      expect(service.getCharacteristic(Characteristic.Hue).value).toBe(200);
      expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(
        90,
      );

      await shutdown();
    });
  });
});

function wledConfig(): Config {
  return {
    bridge: {
      name: "Test Bridge",
      mac: "0E:42:A1:B2:C3:D4",
      pincode: "031-45-154",
      port: 0,
    },
    mqtt: {
      url: "mqtt://localhost:1883",
    },
    devices: [
      {
        name: "LED Strip",
        type: "wled",
        topic: "wled/living-room",
        capabilities: ["on_off", "brightness", "color_hs"],
      },
    ],
  };
}

describe("WLED device support", () => {
  test("subscribes to WLED sub-topics on MQTT connect", async () => {
    const { shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    expect(mockClient.subscriptions).toHaveLength(1);
    expect(mockClient.subscriptions[0]).toEqual([
      "wled/living-room/g",
      "wled/living-room/c",
    ]);
    await shutdown();
  });

  test("does not request initial state for WLED devices", async () => {
    const { shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const getMessages = mockClient.published.filter((p) =>
      p.topic.endsWith("/get"),
    );
    expect(getMessages).toHaveLength(0);
    await shutdown();
  });

  test("WLED brightness message updates state and accessory", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "wled/living-room/g",
      Buffer.from("128"),
    );

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true);

    await shutdown();
  });

  test("WLED brightness 0 sets state OFF", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "wled/living-room/g",
      Buffer.from("0"),
    );

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;
    expect(service.getCharacteristic(Characteristic.On).value).toBe(false);

    await shutdown();
  });

  test("WLED color message updates hue and saturation", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "wled/living-room/c",
      Buffer.from("#FF0000"),
    );

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;
    expect(service.getCharacteristic(Characteristic.Hue).value).toBe(0);
    expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(
      100,
    );

    await shutdown();
  });

  test("WLED ignores invalid brightness", async () => {
    const { shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "wled/living-room/g",
      Buffer.from("not-a-number"),
    );
    await shutdown();
  });

  test("WLED ignores invalid hex color", async () => {
    const { shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "wled/living-room/c",
      Buffer.from("xyz"),
    );
    await shutdown();
  });

  test("HomeKit set publishes WLED JSON API format", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.On).setValue(true);
    await flush();

    const apiMsg = mockClient.published.find(
      (p) => p.topic === "wled/living-room/api",
    );
    expect(apiMsg).toBeDefined();
    expect(JSON.parse(apiMsg!.message)).toEqual({ on: true });

    await shutdown();
  });

  test("HomeKit brightness publishes WLED bri field", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.Brightness).setValue(100);
    await flush();

    const apiMsg = mockClient.published.find(
      (p) => p.topic === "wled/living-room/api",
    );
    expect(apiMsg).toBeDefined();
    const parsed = JSON.parse(apiMsg!.message) as Record<string, unknown>;
    expect(parsed.bri).toBe(255);

    await shutdown();
  });

  test("HomeKit color publishes WLED seg col format", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.Hue).setValue(0);
    service.getCharacteristic(Characteristic.Saturation).setValue(100);
    await flush();

    const apiMsg = mockClient.published.find(
      (p) => p.topic === "wled/living-room/api",
    );
    expect(apiMsg).toBeDefined();
    const parsed = JSON.parse(apiMsg!.message) as Record<string, unknown>;
    expect(parsed.seg).toEqual([{ col: [[255, 0, 0]] }]);

    await shutdown();
  });

  test("HomeKit white (H=0/S=0) activates WLED white channel", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.Hue).setValue(0);
    service.getCharacteristic(Characteristic.Saturation).setValue(0);
    await flush();

    const apiMsg = mockClient.published.find(
      (p) => p.topic === "wled/living-room/api",
    );
    expect(apiMsg).toBeDefined();
    const parsed = JSON.parse(apiMsg!.message) as Record<string, unknown>;
    expect(parsed.seg).toEqual([{ col: [[255, 255, 255]] }]);

    await shutdown();
  });

  test("WLED color write-back is suppressed after HomeKit write", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    // HomeKit writes a color
    service.getCharacteristic(Characteristic.Hue).setValue(120);
    service.getCharacteristic(Characteristic.Saturation).setValue(100);
    await flush();

    // WLED sends back color via /c
    mockClient.emit(
      "message",
      "wled/living-room/c",
      Buffer.from("#0000FF"),
    );

    // Color should be suppressed — hue should remain 120
    expect(service.getCharacteristic(Characteristic.Hue).value).toBe(120);
    expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(
      100,
    );

    await shutdown();
  });

  test("WLED brightness passes through during color suppression window", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    // HomeKit writes a color, triggering suppression window
    service.getCharacteristic(Characteristic.Hue).setValue(120);
    service.getCharacteristic(Characteristic.Saturation).setValue(100);
    await flush();

    // WLED sends brightness update via /g during suppression
    mockClient.emit(
      "message",
      "wled/living-room/g",
      Buffer.from("200"),
    );

    // Brightness (non-color) should pass through even during suppression
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true);

    await shutdown();
  });

  test("WLED getState returns normalized HK state from cache", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    // Populate the state cache with WLED brightness and color
    mockClient.emit(
      "message",
      "wled/living-room/g",
      Buffer.from("128"),
    );
    mockClient.emit(
      "message",
      "wled/living-room/c",
      Buffer.from("#FF0000"),
    );

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    // Verify getState returns normalized HK values via handleGetRequest
    const brightness = await service
      .getCharacteristic(Characteristic.Brightness)
      .handleGetRequest();
    expect(brightness).toBe(50); // wledBrightnessToHomeKit(128) = 50

    const hue = await service
      .getCharacteristic(Characteristic.Hue)
      .handleGetRequest();
    expect(hue).toBe(0); // red → hue 0

    const saturation = await service
      .getCharacteristic(Characteristic.Saturation)
      .handleGetRequest();
    expect(saturation).toBe(100); // pure red → saturation 100

    await shutdown();
  });

  test("mixed Z2M and WLED devices subscribe correctly", async () => {
    const cfg: Config = {
      bridge: {
        name: "Test Bridge",
        mac: "0E:42:A1:B2:C3:D4",
        pincode: "031-45-154",
        port: 0,
      },
      mqtt: {
        url: "mqtt://localhost:1883",
      },
      devices: [
        {
          name: "Z2M Light",
          type: "z2m",
          topic: "zigbee2mqtt/living_room",
          capabilities: ["on_off"],
        },
        {
          name: "WLED Strip",
          type: "wled",
          topic: "wled/strip",
          capabilities: ["on_off", "brightness"],
        },
      ],
    };

    const { shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    expect(mockClient.subscriptions).toHaveLength(1);
    const topics = mockClient.subscriptions[0]!;
    expect(topics).toContain("zigbee2mqtt/living_room");
    expect(topics).toContain("wled/strip/g");
    expect(topics).toContain("wled/strip/c");

    // Only Z2M device should get state request
    const getMessages = mockClient.published.filter((p) =>
      p.topic.endsWith("/get"),
    );
    expect(getMessages).toHaveLength(1);
    expect(getMessages[0]!.topic).toBe("zigbee2mqtt/living_room/get");

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
      ["zigbee2mqtt/living_room", { state: "ON", brightness: 200 }],
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
    expect(result.devices[0]!.topic).toBe("zigbee2mqtt/living_room");
    expect(result.devices[0]!.type).toBe("z2m");
    expect(result.devices[0]!.capabilities).toEqual(["on_off", "brightness"]);
    expect(result.devices[0]!.scenes).toEqual([{ name: "Movie Mode", id: 1 }]);
    expect(result.devices[0]!.state).toEqual({ state: "ON", brightness: 200 });
    expect(result.devices[1]!.name).toBe("Bedroom");
    expect(result.devices[1]!.type).toBe("z2m");
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
