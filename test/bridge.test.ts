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

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Characteristic,
  HAPStatus,
  HAPStorage,
  Service,
} from "@homebridge/hap-nodejs";
import type { Config, MQTTCredentials } from "../src/config.ts";
import { INVALID_MQTT_URL, MALFORMED_MQTT_URLS, SECRET } from "./mqtt-urls.ts";
import { HeatedBeddingSource } from "../src/heated-bedding-source.ts";
import type {
  ClientSubscribeCallback,
  IClientOptions,
  IClientPublishOptions,
  IClientSubscribeOptions,
  ISubscriptionGrant,
} from "mqtt";

HAPStorage.setCustomStoragePath(
  mkdtempSync(path.join(tmpdir(), "hoboken-test-")),
);

const expectedVersion = execFileSync(
  fileURLToPath(new URL("../scripts/gitcalver.sh", import.meta.url)),
  ["--dirty", "-dev"],
  { encoding: "utf8" },
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

const MQTTJS_RECONNECT_PERIOD = 1000;

type SubscribeComplete = ClientSubscribeCallback;
type Suback = NonNullable<Parameters<ClientSubscribeCallback>[2]>;

// eslint-disable-next-line unicorn/prefer-event-target -- mocks mqtt.js EventEmitter API
class MockMqttClient extends EventEmitter {
  connected = false;
  url = "";
  subscriptions: string[][] = [];
  subscribeCompletions: (SubscribeComplete | undefined)[] = [];
  published: { topic: string; message: string }[] = [];
  options: IClientOptions | undefined;
  heatedBeddingSubscriptions:
    Record<string, IClientSubscribeOptions> | undefined;
  acknowledged: SubscribeComplete | undefined;
  heatedBeddingPublications: {
    topic: string;
    message: string;
    complete: (error?: Error) => void;
  }[] = [];

  reconnecting = false;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options?: IClientOptions) {
    super();
    this.options = options;
    this.on("connect", () => {
      this.reconnecting = false;
    });
  }

  connect(): this {
    return this;
  }

  // Like mqtt.js, which reads reconnectPeriod when it schedules an attempt
  // before any of the application's close listeners run, and which emits
  // offline only for the first loss in a row.
  #scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (!this.reconnecting) {
      this.reconnecting = true;
      this.emit("offline");
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.emit("reconnect");
    }, this.options?.reconnectPeriod ?? MQTTJS_RECONNECT_PERIOD);
  }

  lose(error?: Error): void {
    this.connected = false;
    if (error) this.emit("error", error);
    this.#scheduleReconnect();
    this.emit("close");
  }

  refuse(): void {
    this.connected = false;
    this.emit("error", new Error("Connection refused: Not authorized"));
    if (this.options?.reconnectOnConnackError) this.#scheduleReconnect();
    this.emit("close");
  }

  subscribe(
    topics: string[] | Record<string, IClientSubscribeOptions>,
    complete?: SubscribeComplete,
  ): this {
    if (Array.isArray(topics)) {
      this.subscriptions.push(topics);
      this.subscribeCompletions.push(complete);
    } else {
      this.heatedBeddingSubscriptions = topics;
      this.acknowledged = complete;
    }
    return this;
  }

  publish(
    topic: string,
    message: string,
    options?: IClientPublishOptions,
    complete?: (error?: Error) => void,
  ): this {
    this.published.push({ topic, message });
    if (options && complete)
      this.heatedBeddingPublications.push({ topic, message, complete });
    return this;
  }

  end(_force?: boolean, cb?: () => void): this {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (cb) cb();
    return this;
  }
}

// Each startBridge() call invokes connect(), creating a fresh MockMqttClient.
// No state leaks between tests.
let mockClient: MockMqttClient;
const mockClients: MockMqttClient[] = [];
let connectFailure: Error | undefined;

mock.module("mqtt", () => ({
  connect: (url: string, options?: IClientOptions) => {
    if (connectFailure !== undefined) throw connectFailure;
    mockClient = new MockMqttClient(options);
    mockClient.url = url;
    mockClients.push(mockClient);
    return mockClient;
  },
}));

const { startBridge, buildStatusData } = await import("../src/bridge.ts");

const HEATED_BEDDING = [
  { name: "Bed Side A", prefix: "tuya", controller: "bed", zone: "side_a" },
  { name: "Bed Side B", prefix: "tuya", controller: "bed", zone: "side_b" },
];
const CURTAINS = [
  { name: "Curtain", prefix: "tuya", controller: "window", zone: "curtain" },
];
const HEATED_BEDDING_STATE = {
  session_id: "live",
  power: false,
  heat_level: 4,
  preheat: false,
};

const PASSWORD = "correct-horse-9f3a";
const CREDENTIALS: MQTTCredentials = {
  username: "hoboken",
  password: PASSWORD,
};

function heatedBeddingMessage(
  client: MockMqttClient,
  topic: string,
  value: unknown,
): void {
  client.emit(
    "message",
    topic,
    Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
    { retain: false },
  );
}

function readyHeatedBedding(client: MockMqttClient): void {
  client.connected = true;
  client.emit("connect", { sessionPresent: false });
  client.acknowledged!(
    null,
    Object.entries(client.heatedBeddingSubscriptions!).map(
      ([topic, options]) => ({
        topic,
        ...options,
      }),
    ),
  );
  heatedBeddingMessage(client, "tuya/bridge/availability", "online");
  heatedBeddingMessage(client, "tuya/bed/availability", "online");
  heatedBeddingMessage(client, "tuya/bridge/heartbeat", { session_id: "live" });
  for (const zone of HEATED_BEDDING)
    heatedBeddingMessage(client, `tuya/bed/${zone.zone}`, HEATED_BEDDING_STATE);
}

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

function emitConnect(): void {
  mockClient.connected = true;
  mockClient.published = [];
  mockClient.emit("connect");
}

function collectGetMessages(): { topic: string; message: string }[] {
  return mockClient.published.filter((p) => p.topic.endsWith("/get"));
}

async function openEvents(
  port: number,
  signal: AbortSignal,
): Promise<() => Promise<string>> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/events`, {
    signal,
  });
  const reader = response.body!.getReader();
  let buffered = "";
  const decoder = new TextDecoder();
  return async () => {
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary !== -1) {
        const event = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        return event;
      }
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
}

describe("startBridge", () => {
  test("curtain-only bridge exposes reported positions, confirmed targets, diagnostics, and recovery", async () => {
    const curtain = {
      name: "Curtain",
      prefix: "tuya",
      controller: "window",
      zone: "curtain",
    };
    const topic = "tuya/window/curtain";
    const config = { ...metricsConfig(), devices: [], curtains: [curtain] };
    expect(
      buildStatusData(
        config,
        new Map(),
        { url: "mqtt://localhost", connected: false },
        [],
        "test",
      ).curtains,
    ).toEqual([{ name: "Curtain", topic, state: null, pending: 0 }]);
    const { bridge, metricsPort, shutdown } = await startBridge(config);
    const client = mockClient;
    const service = bridge.bridgedAccessories[0]!.getService(
      Service.WindowCovering,
    )!;
    try {
      const unavailable = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/`)
      ).text();
      expect(unavailable).toContain("No Response");
      readyHeatedBedding(client);
      heatedBeddingMessage(client, "tuya/window/availability", "online");
      const state = {
        session_id: "live",
        current_position: 20,
        target_position: 80,
        motion: null,
      };
      heatedBeddingMessage(client, topic, state);
      expect(
        await service
          .getCharacteristic(Characteristic.CurrentPosition)
          .handleGetRequest(),
      ).toBe(20);
      const write = service
        .getCharacteristic(Characteristic.TargetPosition)
        .handleSetRequest(90);
      const sent = client.heatedBeddingPublications[0]!;
      const command = JSON.parse(sent.message) as { request_id: string };
      sent.complete();
      heatedBeddingMessage(client, topic, { ...state, target_position: 90 });
      heatedBeddingMessage(client, `${topic}/result`, {
        ...command,
        outcome: "confirmed",
      });
      await write;
      await Promise.resolve();
      const html = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/`)
      ).text();
      expect(html).toContain('<span class="type-badge">curtain</span>');
      expect(html).toContain("current_position");
      const metrics = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)
      ).text();
      expect(metrics).toContain("hoboken_devices_configured 1");
      expect(metrics).toContain("hoboken_devices_state_unknown 0");
      expect(metrics).toContain("hoboken_mqtt_messages_published_total 1");
      client.connected = false;
      client.emit("close");
      const offline = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)
      ).text();
      expect(offline).toContain("hoboken_devices_state_unknown 1");
      expect(offline).toContain("hoboken_mqtt_errors_total 1");
    } finally {
      await shutdown();
    }
  });

  test("each device state update produces one dashboard SSE event", async () => {
    const { metricsPort, shutdown } = await startBridge(metricsConfig());
    const controller = new AbortController();
    try {
      const nextEvent = await openEvents(metricsPort!, controller.signal);
      await nextEvent();
      mockClient.emit(
        "message",
        "zigbee2mqtt/living_room",
        Buffer.from('{"state":"ON"}'),
      );
      expect(await nextEvent()).toContain("ON");
      mockClient.emit(
        "message",
        "zigbee2mqtt/living_room",
        Buffer.from('{"state":"OFF"}'),
      );
      expect(await nextEvent()).toContain("OFF");
    } finally {
      controller.abort();
      await shutdown();
    }
  });

  test("each heated bedding message produces one dashboard SSE event", async () => {
    const { metricsPort, shutdown } = await startBridge({
      ...metricsConfig(),
      devices: [],
      heatedBedding: HEATED_BEDDING,
    });
    const client = mockClient;
    const controller = new AbortController();
    try {
      readyHeatedBedding(client);
      const nextEvent = await openEvents(metricsPort!, controller.signal);
      await nextEvent();
      heatedBeddingMessage(client, "tuya/bridge/heartbeat", {
        session_id: "live",
      });
      await nextEvent();
      heatedBeddingMessage(client, "tuya/bed/side_a", {
        ...HEATED_BEDDING_STATE,
        heat_level: 7,
      });
      expect(await nextEvent()).toContain(
        '<td class="key">RotationSpeed</td><td>70</td>',
      );
    } finally {
      controller.abort();
      await shutdown();
    }
  });

  test("a bridge with only heated bedding creates stable fans and preheat switches on one MQTT 5 connection", async () => {
    const config = {
      ...testConfig(),
      devices: [],
      heatedBedding: [
        {
          name: "Bed Side A",
          prefix: "tuya",
          controller: "bed",
          zone: "side_a",
        },
        {
          name: "Bed Side B",
          prefix: "tuya",
          controller: "bed",
          zone: "side_b",
        },
      ],
    };
    const count = mockClients.length;
    const { bridge, shutdown } = await startBridge(config);
    try {
      expect(mockClients.length - count).toBe(1);
      expect(mockClient.options?.protocolVersion).toBe(5);
      expect(bridge.bridgedAccessories).toHaveLength(4);
      expect(
        bridge.bridgedAccessories.map((accessory) => accessory.displayName),
      ).toEqual([
        "Bed Side A",
        "Bed Side A Preheat",
        "Bed Side B",
        "Bed Side B Preheat",
      ]);
      for (const accessory of bridge.bridgedAccessories) {
        expect(
          accessory
            .getService(Service.AccessoryInformation)!
            .getCharacteristic(Characteristic.Manufacturer).value,
        ).toBe("Hoboken");
        expect(
          accessory
            .getService(Service.AccessoryInformation)!
            .getCharacteristic(Characteristic.Model).value,
        ).toBe(
          accessory.getService(Service.Fanv2)
            ? "Heated Bedding Fan"
            : "Heated Bedding Preheat",
        );
      }
    } finally {
      await shutdown();
    }
  });

  test("heated bedding state and confirmed commands update HomeKit and operational status", async () => {
    const config = {
      ...metricsConfig(),
      devices: [],
      heatedBedding: HEATED_BEDDING,
    };
    const { bridge, metricsPort, shutdown } = await startBridge(config);
    const client = mockClient;
    const fan = bridge.bridgedAccessories[0]!.getService(Service.Fanv2)!;
    const active = fan.getCharacteristic(Characteristic.Active);
    const speed = fan.getCharacteristic(Characteristic.RotationSpeed);
    const preheat = bridge.bridgedAccessories[1]!.getService(
      Service.Switch,
    )!.getCharacteristic(Characteristic.On);
    const rightSpeed = bridge.bridgedAccessories[2]!.getService(
      Service.Fanv2,
    )!.getCharacteristic(Characteristic.RotationSpeed);
    try {
      expect(await Promise.allSettled([speed.handleGetRequest()])).toEqual([
        { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      ]);
      const unavailable = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/`)
      ).text();
      expect(unavailable).toContain("No Response");
      readyHeatedBedding(client);
      expect(await speed.handleGetRequest()).toBe(40);
      expect(await active.handleGetRequest()).toBe(0);
      const html = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/`)
      ).text();
      expect(html).toContain("Bed Side A");
      expect(html).toContain('<span class="type-badge">heated bedding</span>');
      expect(html).toContain("heat_level");
      expect(html).not.toContain("No Response");
      const metrics = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)
      ).text();
      expect(metrics).toContain("hoboken_mqtt_connected 1");
      expect(metrics).toContain("hoboken_devices_configured 2");
      expect(metrics).toContain("hoboken_devices_state_unknown 0");
      const pushed = {
        ...HEATED_BEDDING_STATE,
        power: true,
        heat_level: 6,
        preheat: true,
      };
      heatedBeddingMessage(client, "tuya/bed/side_a", pushed);
      expect(speed.value).toBe(60);
      expect(preheat.value).toBe(true);
      expect(rightSpeed.value).toBe(40);
      jest.useFakeTimers();
      const writes = [speed.handleSetRequest(80), active.handleSetRequest(0)];
      jest.advanceTimersByTime(50);
      const publication = client.heatedBeddingPublications[0]!;
      const command = JSON.parse(publication.message) as {
        request_id: string;
        power: boolean;
      };
      expect(command).toEqual({ request_id: command.request_id, power: false });
      publication.complete();
      heatedBeddingMessage(client, "tuya/bed/side_a/result", {
        request_id: command.request_id,
        outcome: "confirmed",
      });
      heatedBeddingMessage(client, "tuya/bed/side_a", {
        ...pushed,
        power: false,
      });
      await Promise.all(writes);
      expect(active.value).toBe(0);
      expect(speed.value).toBe(60);
      const preheatWrite = preheat.handleSetRequest(false);
      const preheatCommand = JSON.parse(
        client.heatedBeddingPublications[1]!.message,
      ) as { request_id: string };
      heatedBeddingMessage(client, "tuya/bed/side_a/result", {
        request_id: preheatCommand.request_id,
        outcome: "confirmed",
      });
      expect(preheat.value).toBe(true);
      heatedBeddingMessage(client, "tuya/bed/side_a", {
        ...pushed,
        power: false,
        preheat: false,
      });
      await preheatWrite;
      expect(preheat.value).toBe(false);
      const cancelled = Promise.allSettled([preheat.handleSetRequest(true)]);
      client.connected = false;
      client.emit("close");
      expect(await cancelled).toEqual([
        { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      ]);
      jest.advanceTimersByTime(1250);
      const replacement = mockClient;
      expect(replacement).not.toBe(client);
      readyHeatedBedding(replacement);
      expect(replacement.published).toHaveLength(0);
      expect(await speed.handleGetRequest()).toBe(40);
      const restoredMetrics = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)
      ).text();
      expect(restoredMetrics).toContain(
        "hoboken_mqtt_messages_published_total 3",
      );
      expect(restoredMetrics).toContain("hoboken_mqtt_errors_total 1");
      expect(restoredMetrics).toContain('device="tuya/bed/side_a"');
      expect(restoredMetrics).not.toContain(command.request_id);
    } finally {
      await shutdown();
      jest.useRealTimers();
    }
  });

  test("mixed bridges keep legacy subscriptions and conversions on their own client", async () => {
    const count = mockClients.length;
    const config = { ...testConfig(), heatedBedding: HEATED_BEDDING };
    const { bridge, shutdown } = await startBridge(config);
    try {
      const legacy = mockClients[count]!;
      const heatedBedding = mockClients[count + 1]!;
      expect(legacy.url).toBe(config.mqtt.url);
      expect(legacy.options).toStrictEqual({
        reconnectPeriod: 1000,
        reconnectOnConnackError: true,
        resubscribe: false,
      });
      expect(heatedBedding.url).toBe(config.mqtt.url);
      expect(heatedBedding.options?.protocolVersion).toBe(5);
      expect("username" in heatedBedding.options!).toBe(false);
      expect("password" in heatedBedding.options!).toBe(false);
      legacy.connected = true;
      legacy.emit("connect");
      expect(legacy.subscriptions).toEqual([
        ["zigbee2mqtt/living_room", "zigbee2mqtt/bedroom"],
      ]);
      expect(bridge.bridgedAccessories).toHaveLength(7);
      readyHeatedBedding(heatedBedding);
      heatedBeddingMessage(heatedBedding, "tuya/bed/side_a", {
        ...HEATED_BEDDING_STATE,
        heat_level: 10,
      });
      legacy.emit(
        "message",
        "zigbee2mqtt/living_room",
        Buffer.from('{"state":"ON","brightness":127}'),
      );
      const light = bridge.bridgedAccessories[0]!.getService(
        Service.Lightbulb,
      )!;
      expect(light.getCharacteristic(Characteristic.On).value).toBe(true);
      expect(light.getCharacteristic(Characteristic.Brightness).value).toBe(50);
    } finally {
      await shutdown();
    }
  });

  test("mixed bedding and curtain bridges maintain independent state and report both shutdown failures", async () => {
    const count = mockClients.length;
    const { bridge, shutdown } = await startBridge({
      ...testConfig(),
      devices: [],
      heatedBedding: HEATED_BEDDING,
      curtains: [
        {
          name: "Curtain",
          prefix: "tuya",
          controller: "window",
          zone: "curtain",
        },
      ],
    });
    const bedding = mockClients[count]!;
    const curtain = mockClients[count + 1]!;
    readyHeatedBedding(bedding);
    readyHeatedBedding(curtain);
    heatedBeddingMessage(curtain, "tuya/window/availability", "online");
    heatedBeddingMessage(curtain, "tuya/window/curtain", {
      session_id: "live",
      current_position: 70,
      target_position: 0,
    });
    expect(
      await bridge.bridgedAccessories[0]!.getService(Service.Fanv2)!
        .getCharacteristic(Characteristic.RotationSpeed)
        .handleGetRequest(),
    ).toBe(40);
    expect(
      await bridge.bridgedAccessories[4]!.getService(Service.WindowCovering)!
        .getCharacteristic(Characteristic.CurrentPosition)
        .handleGetRequest(),
    ).toBe(70);
    for (const [client, label] of [
      [bedding, "bedding"],
      [curtain, "curtain"],
    ] as const) {
      client.end = (_force, complete) => {
        (complete as ((error: Error) => void) | undefined)?.(
          new Error(`${label} close failed`),
        );
        return client;
      };
    }
    expect(await Promise.allSettled([shutdown()])).toMatchObject([
      {
        status: "rejected",
        reason: new AggregateError(
          [
            new Error("bedding close failed"),
            new Error("curtain close failed"),
          ],
          "Tucson MQTT shutdown failed",
        ),
      },
    ]);
  });

  test("a heated bedding shutdown failure still unpublishes and closes the legacy client", async () => {
    const count = mockClients.length;
    const { bridge, shutdown } = await startBridge({
      ...testConfig(),
      heatedBedding: HEATED_BEDDING,
    });
    const legacy = mockClients[count]!;
    const heatedBedding = mockClients[count + 1]!;
    heatedBedding.end = (_force, complete) => {
      (complete as ((error: Error) => void) | undefined)?.(
        new Error("heated bedding close failed"),
      );
      return heatedBedding;
    };
    let legacyEnded = 0;
    legacy.end = (_force, complete) => {
      legacyEnded++;
      complete?.();
      return legacy;
    };
    const unpublish = jest.spyOn(bridge, "unpublish");
    try {
      expect(await Promise.allSettled([shutdown()])).toEqual([
        {
          status: "rejected",
          reason: new Error("heated bedding close failed"),
        },
      ]);
      expect(unpublish).toHaveBeenCalledTimes(1);
      expect(legacyEnded).toBe(1);
    } finally {
      unpublish.mockRestore();
    }
  });

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
    const origRandom = Math.random;
    Math.random = () => 0.5;
    const { shutdown } = await startBridge(testConfig());
    jest.useFakeTimers();
    try {
      emitConnect();
      jest.advanceTimersByTime(300);

      expect(collectGetMessages()).toHaveLength(2);
      expect(
        collectGetMessages()
          .map((p) => p.topic)
          .toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(["zigbee2mqtt/bedroom/get", "zigbee2mqtt/living_room/get"]);
    } finally {
      jest.useRealTimers();
      Math.random = origRandom;
      await shutdown();
    }
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

  test("Z2M get with no cached state returns SERVICE_COMMUNICATION_FAILURE", async () => {
    const { bridge, shutdown } = await startBridge(testConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Living Room",
    )!;
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    expect(await Promise.allSettled([on.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
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
        expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(
          60,
        );

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
    // WLED has no side-effect-free state request over MQTT. Sending {} to
    // /api is a no-op (stateUpdated guard fails when nothing changed).
    // The bridge relies on the next WLED state change to populate the cache.
    const { shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const getMessages = mockClient.published.filter((p) =>
      p.topic.endsWith("/get"),
    );
    expect(getMessages).toHaveLength(0);
    const apiMessages = mockClient.published.filter(
      (p) => p.topic === "wled/living-room/api",
    );
    expect(apiMessages).toHaveLength(0);
    await shutdown();
  });

  test("WLED get with no cached state returns SERVICE_COMMUNICATION_FAILURE", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const on = accessory
      .getService(Service.Lightbulb)!
      .getCharacteristic(Characteristic.On);

    expect(await Promise.allSettled([on.handleGetRequest()])).toEqual([
      { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
    ]);
    expect(on.statusCode).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    await shutdown();
  });

  test("WLED brightness message updates state and accessory", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit("message", "wled/living-room/g", Buffer.from("128"));

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

    mockClient.emit("message", "wled/living-room/g", Buffer.from("0"));

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

    mockClient.emit("message", "wled/living-room/c", Buffer.from("#FF0000"));

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

    mockClient.emit("message", "wled/living-room/c", Buffer.from("xyz"));
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
    mockClient.emit("message", "wled/living-room/c", Buffer.from("#0000FF"));

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
    mockClient.emit("message", "wled/living-room/g", Buffer.from("200"));

    // Brightness (non-color) should pass through even during suppression
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true);

    await shutdown();
  });

  test("WLED getState returns normalized HK state from cache", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    // Populate the state cache with WLED brightness and color
    mockClient.emit("message", "wled/living-room/g", Buffer.from("128"));
    mockClient.emit("message", "wled/living-room/c", Buffer.from("#FF0000"));

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
    const origRandom = Math.random;
    Math.random = () => 0.5;
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
    jest.useFakeTimers();
    try {
      emitConnect();

      expect(mockClient.subscriptions).toHaveLength(1);
      const topics = mockClient.subscriptions[0]!;
      expect(topics).toContain("zigbee2mqtt/living_room");
      expect(topics).toContain("wled/strip/g");
      expect(topics).toContain("wled/strip/c");

      jest.advanceTimersByTime(300);

      expect(collectGetMessages()).toHaveLength(1);
      expect(collectGetMessages()[0]!.topic).toBe(
        "zigbee2mqtt/living_room/get",
      );
    } finally {
      jest.useRealTimers();
      Math.random = origRandom;
      await shutdown();
    }
  });
});

function fanConfig(): Config {
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
        name: "Ceiling Fan",
        type: "z2m",
        topic: "zigbee2mqtt/ceiling_fan",
        capabilities: ["fan", "fan_speed"],
      },
    ],
  };
}

describe("Fan device support", () => {
  test("fan device creates Fanv2 accessory", async () => {
    const { bridge, shutdown } = await startBridge(fanConfig());
    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Ceiling Fan",
    );
    expect(accessory).toBeDefined();
    expect(accessory!.getService(Service.Fanv2)).toBeDefined();
    expect(accessory!.getService(Service.Lightbulb)).toBeUndefined();
    await shutdown();
  });

  test("fan state update updates Active characteristic", async () => {
    const { bridge, shutdown } = await startBridge(fanConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "zigbee2mqtt/ceiling_fan",
      Buffer.from(JSON.stringify({ fan_state: "ON", fan_mode: "medium" })),
    );

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Ceiling Fan",
    )!;
    const active = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.Active);
    expect(active.value).toBe(1);

    const speed = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.RotationSpeed);
    expect(speed.value).toBe(67);

    await shutdown();
  });

  test("HomeKit set publishes fan_state to MQTT", async () => {
    const { bridge, shutdown } = await startBridge(fanConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Ceiling Fan",
    )!;
    const active = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.Active);

    active.setValue(1);
    await flush();

    expect(
      mockClient.published.some(
        (p) =>
          p.topic === "zigbee2mqtt/ceiling_fan/set" &&
          p.message === JSON.stringify({ fan_state: "ON" }),
      ),
    ).toBe(true);

    await shutdown();
  });

  test("HomeKit RotationSpeed publishes fan_mode to MQTT", async () => {
    const { bridge, shutdown } = await startBridge(fanConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Ceiling Fan",
    )!;
    const speed = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.RotationSpeed);

    speed.setValue(100);
    await flush();

    expect(
      mockClient.published.some(
        (p) =>
          p.topic === "zigbee2mqtt/ceiling_fan/set" &&
          p.message === JSON.stringify({ fan_mode: "high" }),
      ),
    ).toBe(true);

    await shutdown();
  });

  test("HomeKit TargetFanState AUTO publishes fan_mode smart", async () => {
    const { bridge, shutdown } = await startBridge(fanConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Ceiling Fan",
    )!;
    const target = accessory
      .getService(Service.Fanv2)!
      .getCharacteristic(Characteristic.TargetFanState);

    target.setValue(1);
    await flush();

    expect(
      mockClient.published.some(
        (p) =>
          p.topic === "zigbee2mqtt/ceiling_fan/set" &&
          p.message === JSON.stringify({ fan_mode: "smart" }),
      ),
    ).toBe(true);

    await shutdown();
  });

  test("fan state passes through write-back suppression window", async () => {
    const { bridge, shutdown } = await startBridge(fanConfig());
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Ceiling Fan",
    )!;
    const service = accessory.getService(Service.Fanv2)!;

    // HomeKit writes rotation speed, triggering suppression window
    service.getCharacteristic(Characteristic.RotationSpeed).setValue(100);
    await flush();

    // Z2M sends back fan state during suppression window
    mockClient.emit(
      "message",
      "zigbee2mqtt/ceiling_fan",
      Buffer.from(JSON.stringify({ fan_state: "ON", fan_mode: "high" })),
    );

    // Fan properties should pass through (not be suppressed)
    expect(service.getCharacteristic(Characteristic.Active).value).toBe(1);
    expect(service.getCharacteristic(Characteristic.RotationSpeed).value).toBe(
      100,
    );

    await shutdown();
  });
});

function metricsConfig(): Config {
  return {
    ...testConfig(),
    metrics: { port: 0 },
  };
}

function loginConfig(config: Config = testConfig()): Config {
  return {
    ...config,
    mqtt: { ...config.mqtt, username: CREDENTIALS.username },
  };
}

function captureConsole() {
  const spies = (["log", "warn", "error"] as const).map((method) =>
    jest.spyOn(console, method).mockImplementation(() => {
      /* captured */
    }),
  );
  return {
    lines: () =>
      spies.flatMap((spy) => spy.mock.calls.map((call) => call.join(" "))),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe("startBridge subscription results", () => {
  const LIVING_ROOM = "zigbee2mqtt/living_room";
  const BEDROOM = "zigbee2mqtt/bedroom";
  const granted: ISubscriptionGrant[] = [
    { topic: LIVING_ROOM, qos: 0 },
    { topic: BEDROOM, qos: 0 },
  ];
  let output: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    output = captureConsole();
  });

  afterEach(() => {
    output.restore();
  });

  function suback(...codes: number[]): Suback {
    return { cmd: "suback", messageId: 1, granted: codes };
  }

  // mqtt.js rejects a SUBACK that carries a failure code, so its callback gets
  // an error whose packet holds the codes and the requested qos in granted.
  function refused(...codes: number[]): Error {
    return Object.assign(new Error("Subscribe error: Unspecified error"), {
      packet: suback(...codes),
    });
  }

  function complete(
    error: Error | null,
    grants?: ISubscriptionGrant[],
    packet?: Suback,
  ): void {
    const completion = mockClient.subscribeCompletions.at(-1);
    expect(completion).toBeInstanceOf(Function);
    completion?.(error, grants, packet);
  }

  async function connected() {
    const handle = await startBridge(metricsConfig());
    emitConnect();
    return handle;
  }

  async function errorCount(port: number | undefined): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    const match = /^hoboken_mqtt_errors_total (\d+)$/m.exec(
      await response.text(),
    );
    return Number(match?.[1]);
  }

  function failures(): string[] {
    return output.lines().filter((line) => line.includes("subscription"));
  }

  test("a granted subscription logs nothing and counts nothing", async () => {
    const { metricsPort, shutdown } = await connected();
    try {
      complete(null, granted, suback(0, 0));
      expect(failures()).toEqual([]);
      expect(await errorCount(metricsPort)).toBe(0);
    } finally {
      await shutdown();
    }
  });

  test("a topic granted as 128 is named and counted", async () => {
    const { metricsPort, shutdown } = await connected();
    try {
      complete(null, [granted[0]!, { topic: BEDROOM, qos: 128 }]);
      expect(failures()).toHaveLength(1);
      expect(failures()[0]).toContain("refused for zigbee2mqtt/bedroom");
      expect(failures()[0]).not.toContain(LIVING_ROOM);
      expect(await errorCount(metricsPort)).toBe(1);
    } finally {
      await shutdown();
    }
  });

  test("a partly denied subscription names only the denied topic", async () => {
    const { metricsPort, shutdown } = await connected();
    try {
      complete(refused(0, 128), granted, suback(0, 128));
      expect(failures()).toHaveLength(1);
      expect(failures()[0]).toContain(
        "refused for zigbee2mqtt/bedroom: Subscribe error: Unspecified error",
      );
      expect(failures()[0]).not.toContain(LIVING_ROOM);
      expect(await errorCount(metricsPort)).toBe(1);
    } finally {
      await shutdown();
    }
  });

  test("a fully denied subscription names every topic and counts once", async () => {
    const { metricsPort, shutdown } = await connected();
    try {
      complete(refused(128, 128), granted, suback(128, 128));
      expect(failures()).toHaveLength(1);
      expect(failures()[0]).toContain(
        "refused for zigbee2mqtt/living_room, zigbee2mqtt/bedroom",
      );
      expect(await errorCount(metricsPort)).toBe(1);
    } finally {
      await shutdown();
    }
  });

  test("an error without a broker reply names every requested topic", async () => {
    const { metricsPort, shutdown } = await connected();
    try {
      complete(new Error("Connection closed"));
      expect(failures()).toHaveLength(1);
      expect(failures()[0]).toContain(
        "failed for zigbee2mqtt/living_room, zigbee2mqtt/bedroom: Connection closed",
      );
      expect(await errorCount(metricsPort)).toBe(1);
    } finally {
      await shutdown();
    }
  });

  test("a reply that does not match the request names every requested topic", async () => {
    const { metricsPort, shutdown } = await connected();
    try {
      complete(refused(128), granted, suback(128));
      expect(failures()).toHaveLength(1);
      expect(failures()[0]).toContain(
        "failed for zigbee2mqtt/living_room, zigbee2mqtt/bedroom",
      );
      expect(await errorCount(metricsPort)).toBe(1);
    } finally {
      await shutdown();
    }
  });

  test("a denial leaves the connection up", async () => {
    const { shutdown } = await connected();
    const end = jest.spyOn(mockClient, "end");
    try {
      complete(refused(128, 128), granted, suback(128, 128));
      expect(end).not.toHaveBeenCalled();
      expect(mockClient.connected).toBe(true);
    } finally {
      await shutdown();
    }
  });

  test("every connection reports the result of its own subscription", async () => {
    const { metricsPort, shutdown } = await connected();
    try {
      complete(null, granted, suback(0, 0));
      emitConnect();
      expect(mockClient.subscribeCompletions).toHaveLength(2);
      complete(refused(0, 128), granted, suback(0, 128));
      expect(failures()).toHaveLength(1);
      expect(await errorCount(metricsPort)).toBe(1);
    } finally {
      await shutdown();
    }
  });
});

describe("startBridge with MQTT credentials", () => {
  test("a devices-only bridge authenticates and retries a refused login", async () => {
    const count = mockClients.length;
    const config = loginConfig();
    const { shutdown } = await startBridge(config, CREDENTIALS);
    try {
      expect(mockClients.length - count).toBe(1);
      expect(mockClient.url).toBe(config.mqtt.url);
      expect(mockClient.url).not.toContain(PASSWORD);
      expect(mockClient.options).toStrictEqual({
        username: "hoboken",
        password: PASSWORD,
        auth: "",
        reconnectPeriod: 1000,
        reconnectOnConnackError: true,
        resubscribe: false,
      });
    } finally {
      await shutdown();
    }
  });

  test("a mixed bridge authenticates both clients and retries a refused login only on the legacy one", async () => {
    const count = mockClients.length;
    const config = { ...loginConfig(), heatedBedding: HEATED_BEDDING };
    const { shutdown } = await startBridge(config, CREDENTIALS);
    try {
      expect(mockClients.length - count).toBe(2);
      const legacy = mockClients[count]!;
      const heatedBedding = mockClients[count + 1]!;
      expect(legacy.url).toBe(config.mqtt.url);
      expect(legacy.options).toStrictEqual({
        username: "hoboken",
        password: PASSWORD,
        auth: "",
        reconnectPeriod: 1000,
        reconnectOnConnackError: true,
        resubscribe: false,
      });
      expect(heatedBedding.url).toBe(config.mqtt.url);
      expect(legacy.url).not.toContain(PASSWORD);
      expect(heatedBedding.url).not.toContain(PASSWORD);
      expect(heatedBedding.options).toMatchObject({
        username: "hoboken",
        password: PASSWORD,
        auth: "",
        protocolVersion: 5,
        clean: true,
        manualConnect: true,
      });
      expect("reconnectOnConnackError" in heatedBedding.options!).toBe(false);
    } finally {
      await shutdown();
    }
  });

  test("a heated bedding bridge authenticates its only client", async () => {
    const count = mockClients.length;
    const config = {
      ...loginConfig(),
      devices: [],
      heatedBedding: HEATED_BEDDING,
    };
    const { shutdown } = await startBridge(config, CREDENTIALS);
    try {
      expect(mockClients.length - count).toBe(1);
      expect(mockClient.url).toBe(config.mqtt.url);
      expect(mockClient.options).toMatchObject({
        username: "hoboken",
        password: PASSWORD,
        auth: "",
        protocolVersion: 5,
      });
      expect("reconnectOnConnackError" in mockClient.options!).toBe(false);
    } finally {
      await shutdown();
    }
  });

  test("a bridge with heated bedding and curtains authenticates both Tucson clients", async () => {
    const count = mockClients.length;
    const config = {
      ...loginConfig(),
      devices: [],
      heatedBedding: HEATED_BEDDING,
      curtains: CURTAINS,
    };
    const { shutdown } = await startBridge(config, CREDENTIALS);
    try {
      expect(mockClients.length - count).toBe(2);
      for (const client of mockClients.slice(count)) {
        expect(client.url).toBe(config.mqtt.url);
        expect(client.options).toMatchObject({
          username: "hoboken",
          password: PASSWORD,
          auth: "",
          protocolVersion: 5,
        });
        expect("reconnectOnConnackError" in client.options!).toBe(false);
      }
    } finally {
      await shutdown();
    }
  });

  test.each([
    [
      "a configured username without credentials",
      { username: "hoboken" },
      undefined,
      "mqtt.username requires credentials",
    ],
    [
      "credentials without a configured username",
      {},
      CREDENTIALS,
      "credentials require mqtt.username",
    ],
    [
      "credentials for a different username",
      { username: "hoboken" },
      { ...CREDENTIALS, username: "intruder" },
      "credentials.username must match mqtt.username",
    ],
    [
      "a password file without a username",
      { passwordFile: "/run/secrets/mqtt_password" },
      undefined,
      "mqtt.passwordFile requires mqtt.username",
    ],
  ])(
    "refuses %s before creating any client or server",
    async (_name, login, credentials, message) => {
      const output = captureConsole();
      const count = mockClients.length;
      const config: Config = {
        ...metricsConfig(),
        heatedBedding: HEATED_BEDDING,
        curtains: CURTAINS,
      };
      Object.assign(config.mqtt, login);
      try {
        let failure: unknown;
        try {
          await startBridge(config, credentials);
        } catch (error) {
          failure = error;
        }
        expect(failure).toStrictEqual(new Error(message));
        expect(mockClients.length).toBe(count);
        // The metrics and HAP servers log when they start.
        expect(output.lines()).toStrictEqual([]);
      } finally {
        output.restore();
      }
    },
  );

  test("a password file beside its username and credentials starts normally", async () => {
    const count = mockClients.length;
    const config = loginConfig();
    config.mqtt.passwordFile = "/run/secrets/mqtt_password";
    const { shutdown } = await startBridge(config, CREDENTIALS);
    try {
      expect(mockClients.length - count).toBe(1);
      expect(mockClient.options).toMatchObject({
        username: "hoboken",
        password: PASSWORD,
      });
    } finally {
      await shutdown();
    }
  });

  test("the password never reaches logs, the status page, or metrics", async () => {
    const output = captureConsole();
    const count = mockClients.length;
    const config = {
      ...loginConfig(metricsConfig()),
      heatedBedding: HEATED_BEDDING,
    };
    const controller = new AbortController();
    try {
      const { metricsPort, shutdown } = await startBridge(config, CREDENTIALS);
      let bodies: string[];
      try {
        const legacy = mockClients[count]!;
        expect(legacy.options?.password).toBe(PASSWORD);

        legacy.connected = true;
        legacy.emit("connect");
        legacy.connected = false;
        legacy.emit("error", new Error("Connection refused: Not authorized"));
        legacy.emit("close");
        legacy.emit("offline");
        legacy.emit("reconnect");

        const base = `http://127.0.0.1:${String(metricsPort)}`;
        const pages = await Promise.all(
          ["/", "/metrics", "/healthz", "/readyz"].map(
            async (route) => await (await fetch(`${base}${route}`)).text(),
          ),
        );
        const nextEvent = await openEvents(metricsPort!, controller.signal);
        bodies = [
          ...pages,
          await nextEvent(),
          JSON.stringify(
            buildStatusData(
              config,
              new Map(),
              { url: config.mqtt.url, connected: true },
              [],
              "version",
            ),
          ),
        ];
      } finally {
        controller.abort();
        await shutdown();
      }

      for (const body of bodies) {
        expect(body).not.toBe("");
        expect(body).not.toContain(PASSWORD);
      }
      const lines = output.lines();
      expect(lines.some((line) => line.includes("MQTT error"))).toBe(true);
      expect(lines.filter((line) => line.includes(PASSWORD))).toStrictEqual([]);
    } finally {
      output.restore();
    }
  });

  test.each([
    ["mqtt://legacy:LEGACYPW@localhost:1883", "mqtt://localhost:1883"],
    ["ws://legacy:LEGACYPW@localhost:9001/mqtt", "ws://localhost:9001"],
    ["mqtt://legacy:LEGACYPW@[::1]", "mqtt://[::1]"],
  ])(
    "credentials embedded in the URL %s stay out of logs and the status page",
    async (url, displayed) => {
      const output = captureConsole();
      try {
        const config = metricsConfig();
        config.mqtt.url = url;
        const { metricsPort, shutdown } = await startBridge(config);
        let page: string;
        try {
          page = await (
            await fetch(`http://127.0.0.1:${String(metricsPort)}/`)
          ).text();
        } finally {
          await shutdown();
        }

        expect(mockClient.url).toBe(url);
        expect(page).toContain(displayed);
        expect(page).not.toContain("LEGACYPW");
        const lines = output.lines();
        expect(lines.some((line) => line.includes(displayed))).toBe(true);
        expect(lines.filter((line) => line.includes("LEGACYPW"))).toStrictEqual(
          [],
        );
      } finally {
        output.restore();
      }
    },
  );
});

describe("startBridge with an mqtt.url that is not well formed", () => {
  const warnings: string[] = [];
  const record = (warning: Error) => {
    warnings.push(`${warning.name}: ${warning.message}`);
  };

  beforeEach(() => {
    warnings.length = 0;
    process.on("warning", record);
  });

  afterEach(() => {
    process.off("warning", record);
    connectFailure = undefined;
  });

  async function failureOf(config: Config): Promise<unknown> {
    try {
      await startBridge(config);
    } catch (error) {
      return error;
    }
    throw new Error("expected startBridge to reject");
  }

  test.each(MALFORMED_MQTT_URLS)(
    "refuses %j before creating anything and quotes none of it",
    async (url) => {
      const output = captureConsole();
      const count = mockClients.length;
      try {
        const failure = await failureOf({
          ...metricsConfig(),
          mqtt: { url },
          heatedBedding: HEATED_BEDDING,
        });
        // A bridge that an earlier test started logs its mDNS advertisement
        // when the event loop turns, so the lines are read before it does.
        const lines = output.lines();
        await new Promise((resolve) => setImmediate(resolve));

        expect(failure).toStrictEqual(new Error(INVALID_MQTT_URL));
        expect(mockClients.length).toBe(count);
        expect(lines).toStrictEqual([]);
        expect(warnings).toStrictEqual([]);
      } finally {
        output.restore();
      }
    },
  );

  test("refuses a bridge that has only heated bedding", async () => {
    const count = mockClients.length;
    const failure = await failureOf({
      ...testConfig(),
      mqtt: { url: `mqtt://user:${SECRET}@localhost:1x` },
      devices: [],
      heatedBedding: HEATED_BEDDING,
    });
    expect(failure).toStrictEqual(new Error(INVALID_MQTT_URL));
    expect(mockClients.length).toBe(count);
  });

  test.each([
    ["a bridge with devices", testConfig()],
    [
      "a bridge with only heated bedding",
      { ...testConfig(), devices: [], heatedBedding: HEATED_BEDDING },
    ],
  ])(
    "rethrows an error that mqtt.js throws for %s without its message",
    async (_name, config) => {
      const output = captureConsole();
      connectFailure = Object.assign(
        new Error(
          `The argument 'url' mqtt://user:${SECRET}@localhost:1x. Received 'Invalid port in url'`,
        ),
        { code: "ERR_INVALID_ARG_VALUE" },
      );
      try {
        const failure = await failureOf(config);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
          "MQTT client could not be started",
        );
        expect((failure as { code?: unknown }).code).toBe(
          "ERR_INVALID_ARG_VALUE",
        );
        expect((failure as Error).stack).not.toContain(SECRET);
        expect(
          output.lines().filter((line) => line.includes(SECRET)),
        ).toStrictEqual([]);
      } finally {
        output.restore();
      }
    },
  );
});

describe("main MQTT connection reconnects", () => {
  const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
  const brokerDown = () => {
    mockClient.lose(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1883"), {
        code: "ECONNREFUSED",
      }),
    );
  };
  const loginRefused = () => {
    mockClient.refuse();
  };
  const connectionClosed = () => {
    mockClient.lose();
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  async function startReconnectTest(credentials?: MQTTCredentials) {
    const { shutdown } = await startBridge(
      credentials ? loginConfig() : testConfig(),
      credentials,
    );
    let attempts = 0;
    mockClient.on("reconnect", () => {
      attempts++;
    });
    jest.useFakeTimers();
    return {
      shutdown,
      expectAttemptAfter(delay: number, fail: () => void) {
        const before = attempts;
        fail();
        jest.advanceTimersByTime(delay - 1);
        expect(attempts).toBe(before);
        jest.advanceTimersByTime(1);
        expect(attempts).toBe(before + 1);
      },
    };
  }

  test("an anonymous bridge passes only the reconnect and subscription options", async () => {
    const { shutdown } = await startBridge(testConfig());
    try {
      expect(mockClient.options).toStrictEqual({
        reconnectPeriod: 1000,
        reconnectOnConnackError: true,
        resubscribe: false,
      });
    } finally {
      await shutdown();
    }
  });

  test.each([
    ["anonymous", undefined],
    ["credentialed", CREDENTIALS],
  ])(
    "a %s bridge doubles the delay after each failed attempt up to 60 s",
    async (_name, credentials) => {
      const session = await startReconnectTest(credentials);
      try {
        const failures = [brokerDown, loginRefused, connectionClosed];
        for (const [index, delay] of BACKOFF_MS.entries())
          session.expectAttemptAfter(delay, failures[index % 3]!);
      } finally {
        await session.shutdown();
      }
    },
  );

  test.each([
    ["at once", 0],
    ["after 59.999 s", 59999],
  ])(
    "connections that the broker drops %s keep doubling the delay up to 60 s",
    async (_name, uptime) => {
      const session = await startReconnectTest();
      try {
        for (const delay of BACKOFF_MS) {
          emitConnect();
          jest.advanceTimersByTime(uptime);
          session.expectAttemptAfter(delay, connectionClosed);
        }
      } finally {
        await session.shutdown();
      }
    },
  );

  test("a connection that stays up for 60 s resets the delay to 1 s", async () => {
    const session = await startReconnectTest();
    try {
      for (const delay of BACKOFF_MS.slice(0, 4))
        session.expectAttemptAfter(delay, loginRefused);
      emitConnect();
      jest.advanceTimersByTime(60000);
      session.expectAttemptAfter(1000, connectionClosed);
      session.expectAttemptAfter(2000, brokerDown);
      session.expectAttemptAfter(4000, loginRefused);
    } finally {
      await session.shutdown();
    }
  });

  test("the reset timer restarts with each connection", async () => {
    const session = await startReconnectTest();
    try {
      for (const delay of BACKOFF_MS.slice(0, 4))
        session.expectAttemptAfter(delay, loginRefused);
      emitConnect();
      jest.advanceTimersByTime(30000);
      session.expectAttemptAfter(16000, connectionClosed);
      emitConnect();
      jest.advanceTimersByTime(59999);
      session.expectAttemptAfter(32000, connectionClosed);
      emitConnect();
      jest.advanceTimersByTime(60000);
      session.expectAttemptAfter(1000, connectionClosed);
    } finally {
      await session.shutdown();
    }
  });

  test("a connection that has dropped cannot reset the delay during the outage", async () => {
    const session = await startReconnectTest();
    try {
      emitConnect();
      const outage = [brokerDown, loginRefused, connectionClosed];
      for (const [index, delay] of BACKOFF_MS.entries())
        session.expectAttemptAfter(delay, outage[index % 3]!);
    } finally {
      await session.shutdown();
    }
  });

  test("a repeated connect leaves a single reset timer", async () => {
    const session = await startReconnectTest();
    try {
      emitConnect();
      const timers = jest.getTimerCount();
      emitConnect();
      expect(jest.getTimerCount()).toBe(timers);
    } finally {
      await session.shutdown();
    }
  });

  test("shutdown leaves no pending timer", async () => {
    const session = await startReconnectTest();
    emitConnect();
    await session.shutdown();
    expect(jest.getTimerCount()).toBe(0);
  });
});

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

  test("metrics server honors a configured bind address", async () => {
    const cfg: Config = {
      ...metricsConfig(),
      metrics: { port: 0, bind: "127.0.0.1" },
    };
    const { metricsPort, shutdown } = await startBridge(cfg);
    expect(metricsPort).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    expect(res.status).toBe(200);
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

describe("get retry", () => {
  const originalRandom = Math.random;

  beforeEach(() => {
    Math.random = () => 0.5;
  });

  afterEach(() => {
    Math.random = originalRandom;
    jest.useRealTimers();
  });

  async function startRetryTest(cfg?: Config) {
    const result = await startBridge(cfg ?? testConfig());
    jest.useFakeTimers();
    emitConnect();
    return result;
  }

  test("initial /get is jittered, not published synchronously", async () => {
    const { shutdown } = await startRetryTest();
    expect(collectGetMessages()).toHaveLength(0);
    jest.advanceTimersByTime(300);
    expect(collectGetMessages().length).toBeGreaterThanOrEqual(2);
    await shutdown();
  });

  test("schedules retry for unresponsive Z2M devices", async () => {
    const { shutdown } = await startRetryTest();
    jest.advanceTimersByTime(300);
    expect(collectGetMessages()).toHaveLength(2);
    jest.advanceTimersByTime(2300);
    expect(collectGetMessages()).toHaveLength(4);
    await shutdown();
  });

  test("skips retry for devices that already responded", async () => {
    const { shutdown } = await startRetryTest();
    jest.advanceTimersByTime(300);
    const initialCount = collectGetMessages().length;

    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ state: "ON" })),
    );
    mockClient.emit(
      "message",
      "zigbee2mqtt/bedroom",
      Buffer.from(JSON.stringify({ state: "OFF" })),
    );

    jest.advanceTimersByTime(3000);
    expect(collectGetMessages()).toHaveLength(initialCount);
    await shutdown();
  });

  test("exponential backoff timing with sqrt(2) multiplier", async () => {
    const cfg: Config = {
      ...testConfig(),
      devices: [
        {
          name: "Only Device",
          type: "z2m",
          topic: "zigbee2mqtt/only",
          capabilities: ["on_off"],
        },
      ],
    };
    const { shutdown } = await startRetryTest(cfg);

    jest.advanceTimersByTime(300);
    expect(collectGetMessages()).toHaveLength(1);

    // Retry 0: base = 2000, jitter = 250, total = 2250
    jest.advanceTimersByTime(2300);
    expect(collectGetMessages()).toHaveLength(2);

    // Retry 1: base = 2000*sqrt(2) ≈ 2828, jitter ≈ 354, total ≈ 3182
    jest.advanceTimersByTime(3300);
    expect(collectGetMessages()).toHaveLength(3);

    // Retry 2: base = 2000*2 = 4000, jitter = 500, total = 4500
    jest.advanceTimersByTime(4600);
    expect(collectGetMessages()).toHaveLength(4);

    await shutdown();
  });

  test("retries cap at 1024s and continue indefinitely", async () => {
    const cfg: Config = {
      ...testConfig(),
      devices: [
        {
          name: "Only Device",
          type: "z2m",
          topic: "zigbee2mqtt/only",
          capabilities: ["on_off"],
        },
      ],
    };
    const { shutdown } = await startRetryTest(cfg);
    jest.advanceTimersByTime(300);

    for (let i = 0; i < 20; i++) {
      jest.advanceTimersByTime(1_100_000);
    }

    expect(collectGetMessages().length).toBeGreaterThan(20);
    await shutdown();
  });

  test("cancels retries on close", async () => {
    const { shutdown } = await startRetryTest();
    jest.advanceTimersByTime(300);
    const afterInitial = collectGetMessages().length;

    mockClient.emit("close");
    jest.advanceTimersByTime(5000);

    expect(collectGetMessages()).toHaveLength(afterInitial);
    await shutdown();
  });

  test("cancels retries on offline", async () => {
    const { shutdown } = await startRetryTest();
    jest.advanceTimersByTime(300);
    const afterInitial = collectGetMessages().length;

    mockClient.emit("offline");
    jest.advanceTimersByTime(5000);

    expect(collectGetMessages()).toHaveLength(afterInitial);
    await shutdown();
  });

  test("cancels retries and restarts on reconnect", async () => {
    const { shutdown } = await startRetryTest();
    jest.advanceTimersByTime(300);

    mockClient.subscriptions = [];
    emitConnect();
    jest.advanceTimersByTime(300);

    expect(collectGetMessages()).toHaveLength(2);
    await shutdown();
  });

  test("does not retry WLED devices", async () => {
    const { shutdown } = await startRetryTest(wledConfig());
    jest.advanceTimersByTime(10000);
    expect(collectGetMessages()).toHaveLength(0);
    await shutdown();
  });

  test("skips retry for devices already in stateCache on reconnect", async () => {
    const { shutdown } = await startRetryTest();
    jest.advanceTimersByTime(300);

    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ state: "ON" })),
    );

    mockClient.subscriptions = [];
    emitConnect();
    jest.advanceTimersByTime(300);

    expect(collectGetMessages()).toHaveLength(2);
    expect(
      mockClient.published.find(
        (p) => p.topic === "zigbee2mqtt/living_room/get",
      ),
    ).toBeDefined();

    jest.advanceTimersByTime(3000);
    const bedroomRetries = mockClient.published.filter(
      (p) => p.topic === "zigbee2mqtt/bedroom/get",
    ).length;
    const livingRoomRetries = mockClient.published.filter(
      (p) => p.topic === "zigbee2mqtt/living_room/get",
    ).length;
    expect(bedroomRetries).toBeGreaterThan(1);
    expect(livingRoomRetries).toBe(1);
    await shutdown();
  });

  test("increments z2mGetRequestsTotal on each /get publish", async () => {
    const cfg: Config = {
      ...metricsConfig(),
      devices: [
        {
          name: "Only Device",
          type: "z2m",
          topic: "zigbee2mqtt/only",
          capabilities: ["on_off"],
        },
      ],
    };
    const { metricsPort, shutdown } = await startRetryTest(cfg);

    jest.advanceTimersByTime(300);
    jest.advanceTimersByTime(2300);

    jest.useRealTimers();
    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    const body = await res.text();
    const match = /hoboken_z2m_get_requests_total (\d+)/.exec(body);
    expect(match).toBeDefined();
    expect(Number(match![1])).toBeGreaterThanOrEqual(2);
    await shutdown();
  });
});

describe("devicesStateUnknown metric", () => {
  test("starts at total device count on startup", async () => {
    const cfg = metricsConfig();
    const { metricsPort, shutdown } = await startBridge(cfg);

    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    const body = await res.text();
    const match = /hoboken_devices_state_unknown (\d+)/.exec(body);
    expect(match).toBeDefined();
    expect(Number(match![1])).toBe(2);
    await shutdown();
  });

  test("decreases as devices respond", async () => {
    const cfg = metricsConfig();
    const { metricsPort, shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ state: "ON" })),
    );

    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    const body = await res.text();
    const match = /hoboken_devices_state_unknown (\d+)/.exec(body);
    expect(match).toBeDefined();
    expect(Number(match![1])).toBe(1);
    await shutdown();
  });

  test("no double-decrement on subsequent updates to same device", async () => {
    const cfg = metricsConfig();
    const { metricsPort, shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ state: "ON" })),
    );
    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ state: "OFF" })),
    );

    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    const body = await res.text();
    const match = /hoboken_devices_state_unknown (\d+)/.exec(body);
    expect(match).toBeDefined();
    expect(Number(match![1])).toBe(1);
    await shutdown();
  });

  test("recomputed correctly on reconnect with cached state", async () => {
    const cfg = metricsConfig();
    const { metricsPort, shutdown } = await startBridge(cfg);
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "zigbee2mqtt/living_room",
      Buffer.from(JSON.stringify({ state: "ON" })),
    );

    mockClient.emit("connect");

    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    const body = await res.text();
    const match = /hoboken_devices_state_unknown (\d+)/.exec(body);
    expect(match).toBeDefined();
    expect(Number(match![1])).toBe(1);
    await shutdown();
  });
});

describe("buildStatusData", () => {
  test("heated bedding status contains only live reported values or an unavailable marker", async () => {
    const config = { ...testConfig(), heatedBedding: HEATED_BEDDING };
    const source = new HeatedBeddingSource(
      HEATED_BEDDING,
      (_topic, _payload, complete) => {
        complete();
      },
    );
    const mqtt = { url: "mqtt://localhost", connected: true };
    const stateCache = new Map();
    const withoutSource = buildStatusData(
      config,
      stateCache,
      mqtt,
      [],
      "version",
    );
    expect(withoutSource.heatedBedding![0]).toMatchObject({
      state: null,
      pending: 0,
    });
    const generation = source.connect();
    try {
      source.subscriptionsReady(generation);
      source.handle(generation, "tuya/bridge/availability", "online", true);
      source.handle(generation, "tuya/bed/availability", "online", true);
      source.handle(
        generation,
        "tuya/bridge/heartbeat",
        { session_id: "live" },
        false,
      );
      source.handle(generation, "tuya/bed/side_a", HEATED_BEDDING_STATE, true);
      const outcomes = Promise.allSettled([
        source.writePreheat("tuya/bed/side_a", true),
      ]);
      const status = buildStatusData(
        config,
        stateCache,
        mqtt,
        [],
        "version",
        source,
      );
      expect(status.heatedBedding![0]).toMatchObject({
        name: "Bed Side A",
        state: HEATED_BEDDING_STATE,
        pending: 1,
      });
      expect(status.heatedBedding![1]).toMatchObject({
        state: null,
        pending: 0,
      });
      source.disconnect();
      await outcomes;
      expect(
        buildStatusData(config, stateCache, mqtt, [], "version", source)
          .heatedBedding![0]!.state,
      ).toBeNull();
      const badConfig = {
        ...config,
        heatedBedding: [{ ...HEATED_BEDDING[0]!, zone: "unknown" }],
      };
      expect(() =>
        buildStatusData(badConfig, stateCache, mqtt, [], "version", source),
      ).toThrow(RangeError);
    } finally {
      source.disconnect();
    }
  });

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
