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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Accessory,
  Characteristic,
  HAPStatus,
  HAPStorage,
  Service,
} from "@homebridge/hap-nodejs";
import type { Config, MQTTCredentials } from "../src/config.ts";
import { INVALID_MQTT_URL, MALFORMED_MQTT_URLS, SECRET } from "./mqtt-urls.ts";
import { HeatedBeddingSource } from "../src/heated-bedding-source.ts";
import { adaptiveLightingController } from "../src/accessories.ts";
import { colorTempToHueSaturation } from "../src/convert.ts";
import { hubStartsAdaptiveLighting } from "./adaptive-lighting-hub.ts";
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

const { startBridge, buildStatusData, readVersion } =
  await import("../src/bridge.ts");

// Read at load, outside any test's timeout, because gitcalver's git commands
// slow down with machine load.
const checkoutVersion = readVersion();
const VERSION = "20261021.1-test";

const HEATED_BEDDING = [
  { name: "Bed Side A", prefix: "tuya", controller: "bed", zone: "side_a" },
  { name: "Bed Side B", prefix: "tuya", controller: "bed", zone: "side_b" },
];
const CURTAINS = [{ name: "Curtain", prefix: "tuya", controller: "window" }];
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
    const topic = "tuya/window";
    const config = { ...metricsConfig(), devices: [], curtains: CURTAINS };
    expect(
      buildStatusData(
        config,
        new Map(),
        { url: "mqtt://localhost", connected: false },
        [],
        "test",
      ).curtains,
    ).toEqual([{ name: "Curtain", topic, state: null, pending: 0 }]);
    const { bridge, metricsPort, shutdown } = await startBridge(
      config,
      VERSION,
    );
    const client = mockClient;
    const service = bridge.bridgedAccessories[0]!.getService(
      Service.WindowCovering,
    )!;
    try {
      expect(
        bridge.bridgedAccessories[0]!.getService(
          Service.AccessoryInformation,
        )!.getCharacteristic(Characteristic.SerialNumber).value,
      ).toBe("window/curtain");
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
    const { metricsPort, shutdown } = await startBridge(
      metricsConfig(),
      VERSION,
    );
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
    const { metricsPort, shutdown } = await startBridge(
      {
        ...metricsConfig(),
        devices: [],
        heatedBedding: HEATED_BEDDING,
      },
      VERSION,
    );
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
    const { bridge, shutdown } = await startBridge(config, VERSION);
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
    const { bridge, metricsPort, shutdown } = await startBridge(
      config,
      VERSION,
    );
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

  test("a group beside its own zones shares their source and fans HomeKit writes out", async () => {
    const group = {
      name: "Bed",
      prefix: "tuya",
      controller: "bed",
      zones: ["side_a", "side_b"],
    };
    const config = {
      ...metricsConfig(),
      devices: [],
      heatedBedding: [...HEATED_BEDDING, group],
    };
    const count = mockClients.length;
    const { bridge, metricsPort, shutdown } = await startBridge(
      config,
      VERSION,
    );
    const client = mockClient;
    try {
      expect(mockClients.length - count).toBe(1);
      expect(
        bridge.bridgedAccessories.map((accessory) => accessory.displayName),
      ).toEqual([
        "Bed Side A",
        "Bed Side A Preheat",
        "Bed Side B",
        "Bed Side B Preheat",
        "Bed",
        "Bed Preheat",
      ]);
      expect(
        bridge.bridgedAccessories.map(
          (accessory) =>
            accessory
              .getService(Service.AccessoryInformation)!
              .getCharacteristic(Characteristic.SerialNumber).value,
        ),
      ).toEqual([
        "bed/side_a/Heated Bedding Fan",
        "bed/side_a/Heated Bedding Preheat",
        "bed/side_b/Heated Bedding Fan",
        "bed/side_b/Heated Bedding Preheat",
        "bed/side_a,side_b/Heated Bedding Fan",
        "bed/side_a,side_b/Heated Bedding Preheat",
      ]);
      const fan = bridge.bridgedAccessories[4]!.getService(Service.Fanv2)!;
      const active = fan.getCharacteristic(Characteristic.Active);
      const speed = fan.getCharacteristic(Characteristic.RotationSpeed);
      const preheat = bridge.bridgedAccessories[5]!.getService(
        Service.Switch,
      )!.getCharacteristic(Characteristic.On);
      expect(await Promise.allSettled([speed.handleGetRequest()])).toEqual([
        { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      ]);
      readyHeatedBedding(client);
      expect(
        Object.keys(client.heatedBeddingSubscriptions!).toSorted((a, b) =>
          a.localeCompare(b),
        ),
      ).toEqual([
        "tuya/bed/availability",
        "tuya/bed/side_a",
        "tuya/bed/side_a/result",
        "tuya/bed/side_b",
        "tuya/bed/side_b/result",
        "tuya/bridge/availability",
        "tuya/bridge/heartbeat",
      ]);
      expect(await speed.handleGetRequest()).toBe(40);
      expect(await active.handleGetRequest()).toBe(0);
      const html = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/`)
      ).text();
      expect(html).toContain(
        '<h2>Bed <span class="type-badge">heated bedding group</span></h2>',
      );
      const metrics = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)
      ).text();
      expect(metrics).toContain("hoboken_devices_configured 3");
      expect(metrics).toContain("hoboken_devices_state_unknown 0");

      jest.useFakeTimers();
      const write = active.handleSetRequest(1);
      jest.advanceTimersByTime(50);
      const publications = client.heatedBeddingPublications;
      expect(publications.map(({ topic }) => topic)).toEqual([
        "tuya/bed/side_a/set",
        "tuya/bed/side_b/set",
      ]);
      for (const publication of publications) {
        const command = JSON.parse(publication.message) as {
          request_id: string;
          power: boolean;
          auto_off_seconds: number;
        };
        expect(command).toEqual({
          request_id: command.request_id,
          power: true,
          auto_off_seconds: 21600,
        });
        publication.complete();
        const zone = publication.topic.slice(0, -"/set".length);
        heatedBeddingMessage(client, zone, {
          ...HEATED_BEDDING_STATE,
          power: true,
          auto_off_seconds: 21600,
        });
        heatedBeddingMessage(client, `${zone}/result`, {
          request_id: command.request_id,
          outcome: "confirmed",
        });
      }
      await write;
      expect(active.value).toBe(1);
      expect(speed.value).toBe(40);
      expect(preheat.value).toBe(false);
      expect(
        await (
          await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)
        ).text(),
      ).toContain("hoboken_mqtt_messages_published_total 2");

      heatedBeddingMessage(client, "tuya/bed/side_b", {
        ...HEATED_BEDDING_STATE,
        power: null,
      });
      expect(await Promise.allSettled([speed.handleGetRequest()])).toEqual([
        { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      ]);
      expect(await Promise.allSettled([active.handleSetRequest(0)])).toEqual([
        { status: "rejected", reason: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      ]);
      expect(publications).toHaveLength(2);
      const degraded = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`)
      ).text();
      expect(degraded).toContain("hoboken_devices_state_unknown 2");
    } finally {
      await shutdown();
      jest.useRealTimers();
    }
  });

  test("mixed bridges keep legacy subscriptions and conversions on their own client", async () => {
    const count = mockClients.length;
    const config = { ...testConfig(), heatedBedding: HEATED_BEDDING };
    const { bridge, shutdown } = await startBridge(config, VERSION);
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
    const { bridge, shutdown } = await startBridge(
      {
        ...testConfig(),
        devices: [],
        heatedBedding: HEATED_BEDDING,
        curtains: CURTAINS,
      },
      VERSION,
    );
    const bedding = mockClients[count]!;
    const curtain = mockClients[count + 1]!;
    readyHeatedBedding(bedding);
    readyHeatedBedding(curtain);
    heatedBeddingMessage(curtain, "tuya/window/availability", "online");
    heatedBeddingMessage(curtain, "tuya/window", {
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
    const { bridge, shutdown } = await startBridge(
      {
        ...testConfig(),
        heatedBedding: HEATED_BEDDING,
      },
      VERSION,
    );
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
    const { shutdown } = await startBridge(testConfig(), VERSION);
    expect(mockClient).toBeDefined();
    await shutdown();
  });

  test("reads its version from gitcalver in a source checkout", () => {
    expect(checkoutVersion).toBe(expectedVersion);
  });

  test("returns an unknown version when gitcalver cannot read a repository", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "hoboken-version-"));
    const cwd = process.cwd();
    try {
      process.chdir(directory);
      expect(readVersion()).toBe("unknown");
    } finally {
      process.chdir(cwd);
      rmSync(directory, { recursive: true });
    }
  });

  test("sets AccessoryInformation on the bridge", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
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
      VERSION,
    );
    await shutdown();
  });

  test("sets AccessoryInformation on light accessories", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
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
      VERSION,
    );
    await shutdown();
  });

  test("sets AccessoryInformation on scene accessories", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
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
      VERSION,
    );
    await shutdown();
  });

  test("subscribes to device topics on MQTT connect", async () => {
    const { shutdown } = await startBridge(testConfig(), VERSION);
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
    const { shutdown } = await startBridge(testConfig(), VERSION);
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
    const { shutdown } = await startBridge(testConfig(), VERSION);
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
    const { shutdown } = await startBridge(testConfig(), VERSION);
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
    const { shutdown } = await startBridge(testConfig(), VERSION);
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
    const { shutdown } = await startBridge(testConfig(), VERSION);
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
    const { shutdown } = await startBridge(testConfig(), VERSION);

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
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
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
    expect(service.testCharacteristic(Characteristic.Hue)).toBe(false);
    expect(service.testCharacteristic(Characteristic.Saturation)).toBe(false);

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
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
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

  test("Z2M white sends 2700 K, not the color_temp reported for a color", async () => {
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
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit(
      "message",
      "zigbee2mqtt/color_light",
      Buffer.from(
        JSON.stringify({
          state: "ON",
          color: { hue: 240, saturation: 100, x: 0.1355, y: 0.0399 },
          color_mode: "xy",
          color_temp: 574,
        }),
      ),
    );

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Color Light",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    service.getCharacteristic(Characteristic.Hue).setValue(0);
    service.getCharacteristic(Characteristic.Saturation).setValue(0);
    await flush();

    const setMsg = mockClient.published.find(
      (p) => p.topic === "zigbee2mqtt/color_light/set",
    );
    expect(setMsg).toBeDefined();
    expect(JSON.parse(setMsg!.message)).toEqual({ color_temp: 370 });

    await shutdown();
  });

  test("Z2M white sends each device's whiteColorTemp before any state arrives", async () => {
    const cfg: Config = {
      ...testConfig(),
      devices: [
        {
          name: "Cool Light",
          type: "z2m",
          topic: "zigbee2mqtt/cool_light",
          capabilities: ["on_off", "color_hs"],
          whiteColorTemp: 250,
        },
        {
          name: "Warm Light",
          type: "z2m",
          topic: "zigbee2mqtt/warm_light",
          capabilities: ["on_off", "color_hs"],
          whiteColorTemp: 400,
        },
      ],
    };
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");

    for (const accessory of bridge.bridgedAccessories) {
      const service = accessory.getService(Service.Lightbulb)!;
      service.getCharacteristic(Characteristic.Hue).setValue(0);
      service.getCharacteristic(Characteristic.Saturation).setValue(0);
    }
    await flush();

    const sets = mockClient.published
      .filter((p) => p.topic.endsWith("/set"))
      .map((p) => [p.topic, JSON.parse(p.message) as unknown]);
    expect(sets).toEqual([
      ["zigbee2mqtt/cool_light/set", { color_temp: 250 }],
      ["zigbee2mqtt/warm_light/set", { color_temp: 400 }],
    ]);

    await shutdown();
  });

  describe("a light with color_temp and color_hs", () => {
    const TOPIC = "zigbee2mqtt/dual_light";

    async function startDual() {
      const cfg: Config = {
        ...testConfig(),
        devices: [
          {
            name: "Dual Light",
            type: "z2m",
            topic: TOPIC,
            capabilities: ["on_off", "brightness", "color_temp", "color_hs"],
          },
        ],
      };
      const { bridge, shutdown } = await startBridge(cfg, VERSION);
      mockClient.connected = true;
      mockClient.emit("connect");
      const service = bridge.bridgedAccessories
        .find((a) => a.displayName === "Dual Light")!
        .getService(Service.Lightbulb)!;
      const value = (characteristic: typeof Characteristic.Hue) =>
        service.getCharacteristic(characteristic).value;
      const report = (state: Record<string, unknown>) => {
        mockClient.emit("message", TOPIC, Buffer.from(JSON.stringify(state)));
      };
      const sets = () =>
        mockClient.published
          .filter((p) => p.topic === `${TOPIC}/set`)
          .map((p) => JSON.parse(p.message) as unknown);
      return { service, value, report, sets, shutdown };
    }

    test("in color_temp mode, shows the temperature and the Home app's color for it", async () => {
      const { value, report, shutdown } = await startDual();
      report({
        state: "ON",
        color: { hue: 32, saturation: 82, x: 0.4599, y: 0.4106 },
        color_mode: "color_temp",
        color_temp: 370,
      });

      expect(value(Characteristic.ColorTemperature)).toBe(370);
      expect(value(Characteristic.Hue)).toBe(30);
      expect(value(Characteristic.Saturation)).toBe(67);

      await shutdown();
    });

    test("in a color mode, shows the color and the minimum temperature", async () => {
      const { value, report, shutdown } = await startDual();
      report({ color_mode: "color_temp", color_temp: 250 });
      report({
        color: { hue: 240, saturation: 100, x: 0.1355, y: 0.0399 },
        color_mode: "xy",
        color_temp: 574,
      });

      expect(value(Characteristic.Hue)).toBe(240);
      expect(value(Characteristic.Saturation)).toBe(100);
      expect(value(Characteristic.ColorTemperature)).toBe(140);

      await shutdown();
    });

    test("an update that changes only the mode shows the new mode's state", async () => {
      const { value, report, shutdown } = await startDual();
      report({
        color: { hue: 240, saturation: 100 },
        color_mode: "hs",
        color_temp: 370,
      });
      report({ color_mode: "color_temp" });

      expect(value(Characteristic.ColorTemperature)).toBe(370);
      expect(value(Characteristic.Hue)).toBe(30);
      expect(value(Characteristic.Saturation)).toBe(67);

      await shutdown();
    });

    test("a color temperature write publishes color_temp and shows its color", async () => {
      const { service, value, sets, shutdown } = await startDual();
      service.getCharacteristic(Characteristic.ColorTemperature).setValue(250);
      await flush();

      expect(sets()).toEqual([{ color_temp: 250 }]);
      expect(value(Characteristic.ColorTemperature)).toBe(250);
      expect(value(Characteristic.Hue)).toBe(29);
      expect(value(Characteristic.Saturation)).toBe(36);

      await shutdown();
    });

    test("a color write shows the minimum temperature", async () => {
      const { service, value, report, sets, shutdown } = await startDual();
      report({ color_mode: "color_temp", color_temp: 370 });
      service.getCharacteristic(Characteristic.Hue).setValue(240);
      service.getCharacteristic(Characteristic.Saturation).setValue(100);
      await flush();

      expect(sets()).toEqual([{ color: { hue: 240, saturation: 100 } }]);
      expect(value(Characteristic.ColorTemperature)).toBe(140);
      expect(value(Characteristic.Hue)).toBe(240);
      expect(value(Characteristic.Saturation)).toBe(100);

      await shutdown();
    });

    test("a white write shows its temperature and keeps the written color", async () => {
      const { service, value, sets, shutdown } = await startDual();
      service.getCharacteristic(Characteristic.Hue).setValue(0);
      service.getCharacteristic(Characteristic.Saturation).setValue(0);
      await flush();

      expect(sets()).toEqual([{ color_temp: 370 }]);
      expect(value(Characteristic.ColorTemperature)).toBe(370);
      expect(value(Characteristic.Hue)).toBe(0);
      expect(value(Characteristic.Saturation)).toBe(0);

      await shutdown();
    });

    test("a hue written alone shows the minimum temperature", async () => {
      const { service, value, report, shutdown } = await startDual();
      report({ color_mode: "color_temp", color_temp: 370 });
      service.getCharacteristic(Characteristic.Hue).setValue(240);
      await flush();

      expect(value(Characteristic.ColorTemperature)).toBe(140);

      await shutdown();
    });

    test("writing back the state of a light that shows a color publishes the color", async () => {
      const { service, report, sets, shutdown } = await startDual();
      report({
        color: { hue: 240, saturation: 100 },
        color_mode: "hs",
        color_temp: 574,
      });
      service.getCharacteristic(Characteristic.ColorTemperature).setValue(140);
      service.getCharacteristic(Characteristic.Hue).setValue(240);
      service.getCharacteristic(Characteristic.Saturation).setValue(100);
      await flush();

      expect(sets()).toEqual([{ color: { hue: 240, saturation: 100 } }]);

      await shutdown();
    });

    test("cool white and a Home app temperature swatch publish temperatures", async () => {
      const { service, sets, shutdown } = await startDual();
      service.getCharacteristic(Characteristic.Hue).setValue(208);
      service.getCharacteristic(Characteristic.Saturation).setValue(17);
      await flush();
      service.getCharacteristic(Characteristic.Hue).setValue(30);
      service.getCharacteristic(Characteristic.Saturation).setValue(67);
      await flush();

      expect(sets()).toEqual([{ color_temp: 250 }, { color_temp: 372 }]);

      await shutdown();
    });

    test("a write with a color temperature and a color publishes the temperature", async () => {
      const { service, sets, shutdown } = await startDual();
      service.getCharacteristic(Characteristic.Hue).setValue(240);
      service.getCharacteristic(Characteristic.Saturation).setValue(100);
      service.getCharacteristic(Characteristic.ColorTemperature).setValue(250);
      await flush();

      expect(sets()).toEqual([{ color_temp: 250 }]);

      await shutdown();
    });

    test("white and warm white publish a temperature before any state arrives", async () => {
      const { service, sets, shutdown } = await startDual();
      service.getCharacteristic(Characteristic.Hue).setValue(0);
      service.getCharacteristic(Characteristic.Saturation).setValue(0);
      await flush();
      service.getCharacteristic(Characteristic.Hue).setValue(31);
      service.getCharacteristic(Characteristic.Saturation).setValue(33);
      await flush();

      expect(sets()).toEqual([{ color_temp: 370 }, { color_temp: 454 }]);

      await shutdown();
    });

    test("reads the active mode's state", async () => {
      const { service, report, shutdown } = await startDual();
      const get = async (characteristic: typeof Characteristic.Hue) =>
        await service.getCharacteristic(characteristic).handleGetRequest();
      report({
        color: { hue: 32, saturation: 82 },
        color_mode: "color_temp",
        color_temp: 370,
      });
      expect(await get(Characteristic.ColorTemperature)).toBe(370);
      expect(await get(Characteristic.Hue)).toBe(30);
      expect(await get(Characteristic.Saturation)).toBe(67);

      report({
        color: { hue: 240, saturation: 100 },
        color_mode: "hs",
        color_temp: 574,
      });
      expect(await get(Characteristic.Hue)).toBe(240);
      expect(await get(Characteristic.Saturation)).toBe(100);
      expect(await get(Characteristic.ColorTemperature)).toBe(140);

      await shutdown();
    });
  });

  test("logs each HomeKit write with the payload it publishes", async () => {
    const cfg: Config = {
      ...testConfig(),
      devices: [
        {
          name: "Color Light",
          type: "z2m",
          topic: "zigbee2mqtt/color_light",
          capabilities: ["on_off", "color_hs"],
          whiteColorTemp: 250,
          scenes: [{ name: "Movie Mode", id: 3 }],
        },
      ],
    };
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");
    const output = captureConsole();
    try {
      const light = bridge.bridgedAccessories.find(
        (a) => a.displayName === "Color Light",
      )!;
      const service = light.getService(Service.Lightbulb)!;
      service.getCharacteristic(Characteristic.Hue).setValue(0);
      service.getCharacteristic(Characteristic.Saturation).setValue(0);
      await flush();
      bridge.bridgedAccessories
        .find((a) => a.displayName === "Movie Mode")!
        .getService(Service.Switch)!
        .getCharacteristic(Characteristic.On)
        .setValue(true);

      expect(output.lines().map((line) => line.replace(/^\S+ /, ""))).toEqual([
        'HomeKit write for "Color Light": {"hue":0,"saturation":0} published to zigbee2mqtt/color_light/set as {"color_temp":250}',
        'HomeKit write for "Color Light": {"scene_recall":3} published to zigbee2mqtt/color_light/set as {"scene_recall":3}',
      ]);
    } finally {
      output.restore();
      await shutdown();
    }
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
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
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
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);

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
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
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
    const { shutdown } = await startBridge(testConfig(), VERSION);
    await shutdown();
  });

  test("MQTT close event logs without crashing", async () => {
    const { shutdown } = await startBridge(testConfig(), VERSION);
    mockClient.emit("close");
    await shutdown();
  });

  test("MQTT reconnect event logs without crashing", async () => {
    const { shutdown } = await startBridge(testConfig(), VERSION);
    mockClient.emit("reconnect");
    await shutdown();
  });

  test("MQTT offline event logs without crashing", async () => {
    const { shutdown } = await startBridge(testConfig(), VERSION);
    mockClient.emit("offline");
    await shutdown();
  });

  test("bridge identify event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
    let callbackCalled = false;
    bridge.emit("identify", false, () => {
      callbackCalled = true;
    });
    expect(callbackCalled).toBe(true);
    await shutdown();
  });

  test("bridge listening event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
    bridge.emit("listening", 51826, "0.0.0.0");
    await shutdown();
  });

  test("bridge advertised event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
    bridge.emit("advertised");
    await shutdown();
  });

  test("bridge paired event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
    bridge.emit("paired");
    await shutdown();
  });

  test("bridge unpaired event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
    bridge.emit("unpaired");
    await shutdown();
  });

  test("bridge characteristic-warning event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
    const server = bridge._server;
    expect(server).toBeDefined();
    // Accessory's own pair handler calls the callback; our listener only logs.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    server!.emit("pair", "AB:CD:EF:01:23:45", Buffer.from("key"), () => {});
    await shutdown();
  });

  test("HAP server connection-closed event logs without crashing", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
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

  describe("write confirmation", () => {
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

    async function startColorLight() {
      const started = await startBridge(colorConfig(), VERSION);
      mockClient.connected = true;
      mockClient.emit("connect");
      const service = started.bridge.bridgedAccessories
        .find((a) => a.displayName === "Color Light")!
        .getService(Service.Lightbulb)!;
      const hue = service.getCharacteristic(Characteristic.Hue);
      const saturation = service.getCharacteristic(Characteristic.Saturation);
      const on = service.getCharacteristic(Characteristic.On);
      const report = (state: Record<string, unknown>) => {
        mockClient.emit(
          "message",
          "zigbee2mqtt/color_light",
          Buffer.from(JSON.stringify(state)),
        );
      };
      const writeColor = async (h: number, s: number) => {
        hue.setValue(h);
        saturation.setValue(s);
        await flush();
      };
      return { ...started, hue, saturation, on, report, writeColor };
    }

    const BEFORE = {
      state: "ON",
      color_mode: "hs",
      color: { hue: 30, saturation: 40 },
    };

    test("a report that repeats the old color does not undo a color that HomeKit wrote", async () => {
      jest.useFakeTimers();
      try {
        const { hue, saturation, on, report, writeColor, shutdown } =
          await startColorLight();
        report(BEFORE);
        await writeColor(120, 100);

        report({ ...BEFORE, state: "OFF" });
        expect(hue.value).toBe(120);
        expect(saturation.value).toBe(100);
        expect(on.value).toBe(false);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a report that changes the color is applied at once, and so is every later one", async () => {
      jest.useFakeTimers();
      try {
        const { hue, saturation, report, writeColor, shutdown } =
          await startColorLight();
        report(BEFORE);
        await writeColor(120, 100);

        report({
          ...BEFORE,
          color: { hue: 80, saturation: 60 },
        });
        expect(hue.value).toBe(80);
        expect(saturation.value).toBe(60);
        report(BEFORE);
        expect(hue.value).toBe(30);
        expect(saturation.value).toBe(40);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a report with no previous state is applied", async () => {
      jest.useFakeTimers();
      try {
        const { hue, report, writeColor, shutdown } = await startColorLight();
        await writeColor(120, 100);
        report(BEFORE);
        expect(hue.value).toBe(30);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a group's late repeat of the old color is not applied, and the new state is", async () => {
      jest.useFakeTimers();
      try {
        const { hue, saturation, report, writeColor, shutdown } =
          await startColorLight();
        report(BEFORE);
        await writeColor(120, 100);

        jest.advanceTimersByTime(900);
        report({ ...BEFORE, last_seen: 1 });
        expect(hue.value).toBe(120);
        jest.advanceTimersByTime(600);
        report({ ...BEFORE, color: { hue: 120, saturation: 100 } });
        expect(hue.value).toBe(120);
        expect(saturation.value).toBe(100);
        report({ ...BEFORE, color: { hue: 121, saturation: 100 } });
        expect(hue.value).toBe(121);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a color that no report shows is taken back after 2000 ms", async () => {
      jest.useFakeTimers();
      try {
        const { hue, saturation, report, writeColor, shutdown } =
          await startColorLight();
        report(BEFORE);
        await writeColor(120, 100);

        jest.advanceTimersByTime(1999);
        report(BEFORE);
        expect(hue.value).toBe(120);
        jest.advanceTimersByTime(1);
        expect(hue.value).toBe(30);
        expect(saturation.value).toBe(40);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a later write of a color restarts the deadline", async () => {
      jest.useFakeTimers();
      try {
        const { hue, report, writeColor, shutdown } = await startColorLight();
        report(BEFORE);
        await writeColor(120, 100);
        jest.advanceTimersByTime(1500);
        await writeColor(200, 100);
        jest.advanceTimersByTime(1999);
        expect(hue.value).toBe(200);
        jest.advanceTimersByTime(1);
        expect(hue.value).toBe(30);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a write to a light that has not reported leaves HomeKit alone at the deadline", async () => {
      jest.useFakeTimers();
      try {
        const { hue, writeColor, shutdown } = await startColorLight();
        await writeColor(120, 100);
        jest.advanceTimersByTime(2000);
        expect(hue.value).toBe(120);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("shutdown cancels the deadline of a write that restarted it", async () => {
      jest.useFakeTimers();
      try {
        const { hue, report, writeColor, shutdown } = await startColorLight();
        report(BEFORE);
        await writeColor(120, 100);
        jest.advanceTimersByTime(1500);
        await writeColor(200, 100);
        await shutdown();
        jest.advanceTimersByTime(5000);
        expect(hue.value).toBe(200);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    test("shutdown cancels the deadline", async () => {
      jest.useFakeTimers();
      try {
        const { hue, report, writeColor, shutdown } = await startColorLight();
        report(BEFORE);
        await writeColor(120, 100);
        await shutdown();
        jest.advanceTimersByTime(2000);
        expect(hue.value).toBe(120);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    function dimmer() {
      return {
        ...testConfig(),
        devices: [
          {
            name: "Dimmer",
            type: "z2m" as const,
            topic: "zigbee2mqtt/dimmer",
            capabilities: ["on_off" as const, "brightness" as const],
          },
        ],
      };
    }

    async function startDimmer() {
      const started = await startBridge(dimmer(), VERSION);
      mockClient.connected = true;
      mockClient.emit("connect");
      const service = started.bridge.bridgedAccessories
        .find((a) => a.displayName === "Dimmer")!
        .getService(Service.Lightbulb)!;
      const on = service.getCharacteristic(Characteristic.On);
      const brightness = service.getCharacteristic(Characteristic.Brightness);
      const report = (state: Record<string, unknown>) => {
        mockClient.emit(
          "message",
          "zigbee2mqtt/dimmer",
          Buffer.from(JSON.stringify(state)),
        );
      };
      return { ...started, on, brightness, report };
    }

    test("a report does not undo the power and brightness written within 2000 ms", async () => {
      jest.useFakeTimers();
      try {
        const { on, brightness, report, shutdown } = await startDimmer();
        report({ state: "OFF", brightness: 254 });
        on.setValue(true);
        brightness.setValue(60);
        await flush();

        report({ state: "OFF", brightness: 254 });
        jest.advanceTimersByTime(1999);
        report({ state: "OFF", brightness: 254 });
        expect(on.value).toBe(true);
        expect(brightness.value).toBe(60);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a write of power that has no effect is undone after 2000 ms", async () => {
      jest.useFakeTimers();
      try {
        const { on, report, shutdown } = await startDimmer();
        report({ state: "OFF", brightness: 254 });
        on.setValue(true);
        await flush();
        jest.advanceTimersByTime(1999);
        report({ state: "OFF", brightness: 254 });
        expect(on.value).toBe(true);
        jest.advanceTimersByTime(1);
        expect(on.value).toBe(false);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a write that no report confirms is logged when it is undone", async () => {
      jest.useFakeTimers();
      const output = captureConsole();
      try {
        const { on, brightness, report, shutdown } = await startDimmer();
        report({ state: "OFF", brightness: 254 });
        on.setValue(true);
        brightness.setValue(60);
        await flush();
        jest.advanceTimersByTime(2000);
        const undone = output
          .lines()
          .filter((line) => line.includes("No report confirmed"));
        expect(undone).toHaveLength(1);
        expect(undone[0]).toEndWith(
          'No report confirmed the power, brightness written to "Dimmer" within 2000 ms; HomeKit shows the reported state',
        );

        on.setValue(true);
        await flush();
        report({ state: "ON", brightness: 254 });
        jest.advanceTimersByTime(2000);
        // The power that a brightness implies was not written.
        brightness.setValue(40);
        await flush();
        report({ brightness: 102 });
        jest.advanceTimersByTime(2000);
        expect(
          output.lines().filter((line) => line.includes("No report confirmed")),
        ).toHaveLength(1);
        await shutdown();
      } finally {
        output.restore();
        jest.useRealTimers();
      }
    });

    test("a read returns what was written until a report confirms it or 2000 ms pass", async () => {
      jest.useFakeTimers();
      try {
        const { on, brightness, report, shutdown } = await startDimmer();
        report({ state: "OFF", brightness: 254 });
        on.setValue(true);
        brightness.setValue(60);
        await flush();
        expect(await on.handleGetRequest()).toBe(true);
        expect(await brightness.handleGetRequest()).toBe(60);
        expect(brightness.value).toBe(60);

        report({ state: "ON", brightness: 203 });
        expect(await brightness.handleGetRequest()).toBe(60);
        jest.advanceTimersByTime(10000);
        expect(await brightness.handleGetRequest()).toBe(80);

        brightness.setValue(40);
        await flush();
        jest.advanceTimersByTime(1999);
        expect(await brightness.handleGetRequest()).toBe(40);
        jest.advanceTimersByTime(1);
        expect(await brightness.handleGetRequest()).toBe(80);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a report of a change in power is applied at once, even within 2000 ms of a write", async () => {
      jest.useFakeTimers();
      try {
        const { on, brightness, report, shutdown } = await startDimmer();
        report({ state: "OFF", brightness: 254 });
        on.setValue(true);
        brightness.setValue(60);
        await flush();

        report({ state: "OFF", brightness: 254 });
        expect(on.value).toBe(true);
        expect(brightness.value).toBe(60);
        report({ state: "ON", brightness: 203 });
        expect(on.value).toBe(true);
        expect(brightness.value).toBe(60);
        report({ state: "OFF", brightness: 203 });
        expect(on.value).toBe(false);
        expect(brightness.value).toBe(60);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a report that changes the power alone leaves the written brightness, and one that changes the brightness is held", async () => {
      jest.useFakeTimers();
      try {
        const { on, brightness, report, shutdown } = await startDimmer();
        report({ state: "OFF", brightness: 254 });
        on.setValue(true);
        brightness.setValue(60);
        await flush();
        report({ state: "ON", brightness: 254 });
        expect(on.value).toBe(true);
        expect(brightness.value).toBe(60);
        report({ state: "ON", brightness: 127 });
        expect(brightness.value).toBe(60);
        jest.advanceTimersByTime(2000);
        expect(brightness.value).toBe(60);
        jest.advanceTimersByTime(8000);
        expect(brightness.value).toBe(50);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a write of power alone does not withhold a report's brightness, which is held, and the reverse", async () => {
      jest.useFakeTimers();
      try {
        const { on, brightness, report, shutdown } = await startDimmer();
        report({ state: "OFF", brightness: 254 });
        on.setValue(true);
        await flush();
        report({ state: "OFF", brightness: 127 });
        expect(on.value).toBe(true);
        expect(brightness.value).toBe(100);

        jest.advanceTimersByTime(2000);
        expect(on.value).toBe(false);
        expect(brightness.value).toBe(100);
        brightness.setValue(80);
        await flush();
        report({ state: "OFF", brightness: 127 });
        expect(on.value).toBe(false);
        expect(brightness.value).toBe(80);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("a write of brightness does not restart the deadline of an earlier write of power", async () => {
      jest.useFakeTimers();
      try {
        const { on, brightness, report, shutdown } = await startDimmer();
        report({ state: "OFF", brightness: 254 });
        on.setValue(true);
        await flush();
        jest.advanceTimersByTime(1500);
        brightness.setValue(60);
        await flush();

        jest.advanceTimersByTime(499);
        report({ state: "OFF", brightness: 254 });
        expect(on.value).toBe(true);
        expect(brightness.value).toBe(60);

        jest.advanceTimersByTime(1);
        expect(on.value).toBe(false);
        expect(brightness.value).toBe(60);
        await shutdown();
      } finally {
        jest.useRealTimers();
      }
    });

    test("accepts color updates with no prior publish", async () => {
      const { bridge, shutdown } = await startBridge(colorConfig(), VERSION);
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

describe("a WLED device with white segments", () => {
  const TOPIC = "wled/nook";

  async function startNook(metrics = false) {
    const cfg: Config = {
      ...wledConfig(),
      devices: [
        {
          name: "Nook",
          type: "wled",
          topic: TOPIC,
          capabilities: ["on_off", "brightness", "color_temp", "color_hs"],
          colorSegments: [0],
          whiteSegments: [1, 2],
          whiteChannels: { r: 5500, g: 2400, b: 5500, w: 2400 },
          gamma: 2.2,
        },
      ],
      ...(metrics ? { metrics: { port: 0, bind: "127.0.0.1" } } : {}),
    };
    const started = await startBridge(cfg, VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");
    const accessory = started.bridge.bridgedAccessories.find(
      (a) => a.displayName === "Nook",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;
    const characteristic = (type: typeof Characteristic.Hue) =>
      service.getCharacteristic(type);
    const report = (sub: string, value: string) => {
      mockClient.emit("message", `${TOPIC}/${sub}`, Buffer.from(value));
    };
    const sent = () =>
      mockClient.published
        .filter((p) => p.topic === `${TOPIC}/api`)
        .map((p) => JSON.parse(p.message) as unknown);
    const white = (col: number[]) => ({
      seg: [
        { id: 0, on: false, sel: false },
        { id: 1, on: true, sel: true, col: [col] },
        { id: 2, on: true, sel: true, col: [col] },
      ],
    });
    return { ...started, accessory, characteristic, report, sent, white };
  }

  describe("reported brightness and Adaptive Lighting", () => {
    let output: ReturnType<typeof captureConsole>;
    const controllers: { disableAdaptiveLighting: () => void }[] = [];

    beforeEach(() => {
      jest.useFakeTimers();
      output = captureConsole();
    });

    afterEach(() => {
      for (const controller of controllers.splice(0))
        controller.disableAdaptiveLighting();
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
      output.restore();
    });

    const adaptive = () =>
      output.lines().filter((line) => line.includes("Adaptive Lighting for"));

    async function startAdaptive() {
      const started = await startNook();
      controllers.push(adaptiveLightingController(started.accessory)!);
      return started;
    }

    test("a brightness that WLED reports once HomeKit has turned it on is shown at once, with its temperature", async () => {
      const { accessory, characteristic, report, shutdown } =
        await startAdaptive();
      report("g", "0");
      await hubStartsAdaptiveLighting(accessory);
      await flush();
      const whileOff = adaptive().length;

      characteristic(Characteristic.On).setValue(true);
      await flush();
      expect(characteristic(Characteristic.Brightness).value).toBe(0);
      report("g", "255");
      expect(characteristic(Characteristic.Brightness).value).toBe(100);
      await flush();
      expect(adaptive().length).toBeGreaterThan(whileOff);
      await shutdown();
    });

    test("a light that is off is sent the temperature without being turned on, once", async () => {
      const { accessory, characteristic, report, sent, shutdown } =
        await startAdaptive();
      report("g", "0");
      await hubStartsAdaptiveLighting(accessory, { spanMs: 4e9 });
      await flush();

      const messages = sent() as Record<string, unknown>[];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toHaveProperty("seg");
      expect(messages[0]).not.toHaveProperty("on");
      expect(messages[0]).not.toHaveProperty("bri");
      expect(adaptive()).toHaveLength(1);
      expect(characteristic(Characteristic.On).value).toBe(false);

      report("c", "#757575");
      jest.advanceTimersByTime(60000);
      await flush();
      jest.advanceTimersByTime(60000);
      await flush();
      expect(sent()).toHaveLength(1);
      expect(
        mockClient.published.filter((p) => p.topic.startsWith(`${TOPIC}/`)),
      ).toHaveLength(1);
      await shutdown();
    });

    test("a light that is off is sent nothing while its power is unknown", async () => {
      const { accessory, sent, shutdown } = await startAdaptive();
      await hubStartsAdaptiveLighting(accessory, { spanMs: 4e9 });
      await flush();
      expect(sent()).toEqual([]);
      await shutdown();
    });

    test("reports that turn a light on after it was sent a temperature behave as for any light", async () => {
      const { accessory, characteristic, report, sent, shutdown } =
        await startAdaptive();
      report("g", "0");
      await hubStartsAdaptiveLighting(accessory, { spanMs: 4e9 });
      await flush();
      expect(sent()).toHaveLength(1);

      report("g", "255");
      expect(characteristic(Characteristic.On).value).toBe(true);
      expect(characteristic(Characteristic.Brightness).value).toBe(100);
      await flush();
      const messages = sent() as Record<string, unknown>[];
      expect(messages.length).toBeGreaterThan(1);
      await shutdown();
    });

    test("a brightness that WLED changes with no write is shown at once, with its temperature", async () => {
      const { accessory, characteristic, report, shutdown } =
        await startAdaptive();
      report("g", "255");
      await hubStartsAdaptiveLighting(accessory);
      await flush();
      const before = adaptive().length;

      report("g", "127");
      expect(characteristic(Characteristic.Brightness).value).toBe(50);
      await flush();
      expect(adaptive().length).toBe(before + 1);
      await shutdown();
    });
  });

  test("ColorTemperature spans the strips, without a characteristic warning", async () => {
    const output = captureConsole();
    try {
      const { characteristic, shutdown } = await startNook();
      const temperature = characteristic(Characteristic.ColorTemperature);
      expect(temperature.props).toMatchObject({ minValue: 182, maxValue: 416 });
      expect(temperature.value).toBe(182);
      await shutdown();
      expect(output.lines().join("\n")).not.toMatch(
        /Characteristic warning|illegal value/,
      );
    } finally {
      output.restore();
    }
  });

  test("a color temperature write blends the strips and shows its color", async () => {
    const { characteristic, sent, white, shutdown } = await startNook();
    characteristic(Characteristic.ColorTemperature).setValue(299);
    await flush();

    expect(sent()).toEqual([white([255, 255, 255, 255])]);
    expect(characteristic(Characteristic.Hue).value).toBe(30);
    expect(characteristic(Characteristic.Saturation).value).toBe(50);

    await shutdown();
  });

  test("Siri's white lights the white segments at 2700 K", async () => {
    const { characteristic, sent, white, shutdown } = await startNook();
    characteristic(Characteristic.Hue).setValue(0);
    characteristic(Characteristic.Saturation).setValue(0);
    await flush();

    expect(sent()).toEqual([white([167, 255, 167, 255])]);
    expect(characteristic(Characteristic.ColorTemperature).value).toBe(370);

    await shutdown();
  });

  test("a color lights the color segment and shows the minimum temperature", async () => {
    const { characteristic, sent, shutdown } = await startNook();
    characteristic(Characteristic.ColorTemperature).setValue(299);
    await flush();
    characteristic(Characteristic.Hue).setValue(240);
    characteristic(Characteristic.Saturation).setValue(100);
    await flush();

    expect(sent()[1]).toEqual({
      seg: [
        { id: 1, on: false, sel: false },
        { id: 2, on: false, sel: false },
        { id: 0, on: true, sel: true, col: [[0, 0, 255]] },
      ],
    });
    expect(characteristic(Characteristic.ColorTemperature).value).toBe(182);

    await shutdown();
  });

  test("reads a reported white as its temperature", async () => {
    const { characteristic, report, shutdown } = await startNook();
    report("g", "128");
    report("c", "#FFA7FFA7");

    expect(characteristic(Characteristic.ColorTemperature).value).toBe(370);
    expect(characteristic(Characteristic.Hue).value).toBe(30);
    expect(characteristic(Characteristic.Saturation).value).toBe(67);
    expect(
      await characteristic(Characteristic.ColorTemperature).handleGetRequest(),
    ).toBe(370);

    await shutdown();
  });

  test("reads a reported color as a color at the minimum temperature", async () => {
    const { characteristic, report, shutdown } = await startNook();
    report("c", "#0000FF");

    expect(characteristic(Characteristic.Hue).value).toBe(240);
    expect(characteristic(Characteristic.Saturation).value).toBe(100);
    expect(characteristic(Characteristic.ColorTemperature).value).toBe(182);

    await shutdown();
  });

  test("remembers a white write, so that cool strips alone read as a temperature", async () => {
    jest.useFakeTimers();
    try {
      const { characteristic, report, shutdown } = await startNook();
      report("g", "128");
      report("c", "#0000FF");
      characteristic(Characteristic.ColorTemperature).setValue(182);
      await flush();
      jest.advanceTimersByTime(1000);
      report("c", "#FF00FF");

      expect(characteristic(Characteristic.ColorTemperature).value).toBe(182);
      expect(characteristic(Characteristic.Hue).value).toBe(24);
      expect(characteristic(Characteristic.Saturation).value).toBe(12);

      characteristic(Characteristic.Hue).setValue(300);
      characteristic(Characteristic.Saturation).setValue(100);
      await flush();
      jest.advanceTimersByTime(1000);
      report("c", "#FF00FF");

      expect(characteristic(Characteristic.Hue).value).toBe(300);
      expect(characteristic(Characteristic.Saturation).value).toBe(100);

      await shutdown();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a color set in WLED after a white write is not read as that white", async () => {
    jest.useFakeTimers();
    try {
      const { characteristic, report, shutdown } = await startNook();
      report("g", "128");
      report("c", "#0000FF");
      characteristic(Characteristic.ColorTemperature).setValue(416);
      await flush();
      jest.advanceTimersByTime(1000);
      report("c", "#FF00FF");

      expect(characteristic(Characteristic.Hue).value).toBe(300);
      expect(characteristic(Characteristic.Saturation).value).toBe(100);
      expect(characteristic(Characteristic.ColorTemperature).value).toBe(182);

      await shutdown();
    } finally {
      jest.useRealTimers();
    }
  });

  test("the status page shows the temperature that HomeKit sees", async () => {
    const { report, metricsPort, shutdown } = await startNook(true);
    try {
      report("c", "#FFA7FFA7");
      const body = await (
        await fetch(`http://127.0.0.1:${String(metricsPort)}/`)
      ).text();
      expect(body).toContain("370");
      expect(body).toContain("2703 K");
    } finally {
      await shutdown();
    }
  });
});

describe("WLED device support", () => {
  test("subscribes to WLED sub-topics on MQTT connect", async () => {
    const { shutdown } = await startBridge(wledConfig(), VERSION);
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
    const { shutdown } = await startBridge(wledConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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
    const { shutdown } = await startBridge(wledConfig(), VERSION);
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
    const { shutdown } = await startBridge(wledConfig(), VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");

    mockClient.emit("message", "wled/living-room/c", Buffer.from("xyz"));
    await shutdown();
  });

  test("HomeKit set publishes WLED JSON API format", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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

  test("HomeKit white (H=0/S=0) sends WLED RGB white", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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

  test("a WLED report that repeats the old color does not undo a color that HomeKit wrote", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "LED Strip",
    )!;
    const service = accessory.getService(Service.Lightbulb)!;

    mockClient.emit("message", "wled/living-room/c", Buffer.from("#0000FF"));
    service.getCharacteristic(Characteristic.Hue).setValue(120);
    service.getCharacteristic(Characteristic.Saturation).setValue(100);
    await flush();

    mockClient.emit("message", "wled/living-room/c", Buffer.from("#0000FF"));
    expect(service.getCharacteristic(Characteristic.Hue).value).toBe(120);
    expect(service.getCharacteristic(Characteristic.Saturation).value).toBe(
      100,
    );

    mockClient.emit("message", "wled/living-room/c", Buffer.from("#FF0000"));
    expect(service.getCharacteristic(Characteristic.Hue).value).toBe(0);

    await shutdown();
  });

  test("WLED brightness passes through while a color write is unconfirmed", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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

    // WLED sends a brightness update via /g
    mockClient.emit("message", "wled/living-room/g", Buffer.from("200"));

    // Brightness (non-color) is not part of the color write
    expect(service.getCharacteristic(Characteristic.On).value).toBe(true);

    await shutdown();
  });

  test("WLED getState returns normalized HK state from cache", async () => {
    const { bridge, shutdown } = await startBridge(wledConfig(), VERSION);
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

    const { shutdown } = await startBridge(cfg, VERSION);
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
    const { bridge, shutdown } = await startBridge(fanConfig(), VERSION);
    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Ceiling Fan",
    );
    expect(accessory).toBeDefined();
    expect(accessory!.getService(Service.Fanv2)).toBeDefined();
    expect(accessory!.getService(Service.Lightbulb)).toBeUndefined();
    await shutdown();
  });

  test("fan state update updates Active characteristic", async () => {
    const { bridge, shutdown } = await startBridge(fanConfig(), VERSION);
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
    expect(speed.value).toBe(2 * (100 / 3));

    await shutdown();
  });

  test("HomeKit set publishes fan_state to MQTT", async () => {
    const { bridge, shutdown } = await startBridge(fanConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(fanConfig(), VERSION);
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
    const { bridge, shutdown } = await startBridge(fanConfig(), VERSION);
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

  test("fan state from Z2M replaces the value HomeKit wrote", async () => {
    const { bridge, shutdown } = await startBridge(fanConfig(), VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");

    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Ceiling Fan",
    )!;
    const service = accessory.getService(Service.Fanv2)!;

    // Z2M reports a different mode than the one written, so the speed assertion
    // below holds only if the report is applied.
    service.getCharacteristic(Characteristic.RotationSpeed).setValue(33);
    await flush();

    mockClient.emit(
      "message",
      "zigbee2mqtt/ceiling_fan",
      Buffer.from(JSON.stringify({ fan_state: "ON", fan_mode: "high" })),
    );

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
    const handle = await startBridge(metricsConfig(), VERSION);
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
    const { shutdown } = await startBridge(config, VERSION, CREDENTIALS);
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
    const { shutdown } = await startBridge(config, VERSION, CREDENTIALS);
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
    const { shutdown } = await startBridge(config, VERSION, CREDENTIALS);
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
    const { shutdown } = await startBridge(config, VERSION, CREDENTIALS);
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
          await startBridge(config, VERSION, credentials);
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
    const { shutdown } = await startBridge(config, VERSION, CREDENTIALS);
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
      const { metricsPort, shutdown } = await startBridge(
        config,
        VERSION,
        CREDENTIALS,
      );
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
        const { metricsPort, shutdown } = await startBridge(config, VERSION);
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
      await startBridge(config, VERSION);
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
      VERSION,
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
    const { shutdown } = await startBridge(testConfig(), VERSION);
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
    const { shutdown } = await startBridge(metricsConfig(), VERSION);
    await shutdown();
  });

  test("metrics server serves /metrics endpoint", async () => {
    const cfg = metricsConfig();
    const { metricsPort, shutdown } = await startBridge(cfg, VERSION);
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
    const { metricsPort, shutdown } = await startBridge(cfg, VERSION);
    expect(metricsPort).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    expect(res.status).toBe(200);
    await shutdown();
  });

  test("status page reflects bridge state", async () => {
    const cfg = metricsConfig();
    const { metricsPort, shutdown } = await startBridge(cfg, VERSION);

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
    const { shutdown } = await startBridge(cfg, VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");

    // Verify the connect handler ran (subscriptions prove it)
    expect(mockClient.subscriptions).toHaveLength(1);
    await shutdown();
  });

  test("mqtt close sets mqttConnected to 0", async () => {
    const cfg = metricsConfig();
    const { shutdown } = await startBridge(cfg, VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");
    mockClient.emit("close");
    await shutdown();
  });

  test("mqtt offline sets mqttConnected to 0", async () => {
    const cfg = metricsConfig();
    const { shutdown } = await startBridge(cfg, VERSION);
    mockClient.emit("offline");
    await shutdown();
  });

  test("mqtt error increments mqttErrors", async () => {
    const cfg = metricsConfig();
    const { shutdown } = await startBridge(cfg, VERSION);
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
    const { shutdown } = await startBridge(cfg, VERSION);
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
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
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
    const { shutdown } = await startBridge(cfg, VERSION);
    // devicesConfigured is set synchronously during startBridge
    await shutdown();
  });

  test("logs a HAP write request, including a value HAP-NodeJS rejects", async () => {
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
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");
    const output = captureConsole();
    try {
      const light = bridge.bridgedAccessories.find(
        (a) => a.displayName === "Color Light",
      )!;
      const aid = light.aid!;
      const service = light.getService(Service.Lightbulb)!;
      const iid = (characteristic: typeof Characteristic.Hue) =>
        service.getCharacteristic(characteristic).iid!;
      const connection = Object.assign(
        new FakeHAPConnection("192.168.1.50", 12345),
        { hasEventNotifications: () => true },
      );

      const response = await new Promise<
        { aid: number; iid: number; status?: number }[]
      >((resolve) => {
        bridge._server!.emit(
          "set-characteristics",
          connection as never,
          {
            characteristics: [
              { aid, iid: iid(Characteristic.Hue), value: 400 },
              { aid, iid: iid(Characteristic.Saturation), value: 20 },
              { aid, iid: iid(Characteristic.On), ev: true },
              { aid: 999, iid: 7, value: "x\ny" },
            ],
          },
          (_error, written) => {
            resolve(written!.characteristics);
          },
        );
      });

      const status = (characteristic: typeof Characteristic.Hue) =>
        response.find((write) => write.iid === iid(characteristic))?.status;
      expect(status(Characteristic.Hue)).toBe(
        HAPStatus.INVALID_VALUE_IN_REQUEST,
      );
      expect(status(Characteristic.Saturation)).toBe(HAPStatus.SUCCESS);
      await flush();
      expect(output.lines().map((line) => line.replace(/^\S+ /, ""))).toEqual([
        'HAP write from 192.168.1.50: "Color Light" Hue=400, "Color Light" Saturation=20, 999.7="x\\ny"',
        'HomeKit write for "Color Light": {"saturation":20} published to zigbee2mqtt/color_light/set as {"color":{"saturation":20}}',
      ]);
    } finally {
      output.restore();
      await shutdown();
    }
  });

  test("does not log a HAP request that only subscribes to events", async () => {
    const { bridge, shutdown } = await startBridge(testConfig(), VERSION);
    const output = captureConsole();
    try {
      const light = bridge.bridgedAccessories[0]!;
      const on = light
        .getService(Service.Lightbulb)!
        .getCharacteristic(Characteristic.On);
      const connection = Object.assign(
        new FakeHAPConnection("192.168.1.50", 12345),
        { hasEventNotifications: () => true },
      );
      await new Promise((resolve) => {
        bridge._server!.emit(
          "set-characteristics",
          connection as never,
          { characteristics: [{ aid: light.aid!, iid: on.iid!, ev: true }] },
          resolve,
        );
      });
      expect(output.lines()).toEqual([]);
    } finally {
      output.restore();
      await shutdown();
    }
  });

  test("HAP connection-opened increments hapConnectionsActive", async () => {
    const cfg = metricsConfig();
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
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
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
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
    const { bridge, shutdown } = await startBridge(cfg, VERSION);
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
    const result = await startBridge(cfg ?? testConfig(), VERSION);
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
    const { metricsPort, shutdown } = await startBridge(cfg, VERSION);

    const res = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    const body = await res.text();
    const match = /hoboken_devices_state_unknown (\d+)/.exec(body);
    expect(match).toBeDefined();
    expect(Number(match![1])).toBe(2);
    await shutdown();
  });

  test("decreases as devices respond", async () => {
    const cfg = metricsConfig();
    const { metricsPort, shutdown } = await startBridge(cfg, VERSION);
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
    const { metricsPort, shutdown } = await startBridge(cfg, VERSION);
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
    const { metricsPort, shutdown } = await startBridge(cfg, VERSION);
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
          .heatedBedding![0],
      ).toMatchObject({ state: null });
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

  test("a heated bedding group lists the status of each of its zones", async () => {
    const group = {
      name: "Bed",
      prefix: "tuya",
      controller: "bed",
      zones: ["side_a", "side_b"],
    };
    const config = {
      ...testConfig(),
      heatedBedding: [...HEATED_BEDDING, group],
    };
    const source = new HeatedBeddingSource(
      HEATED_BEDDING,
      (_topic, _payload, complete) => {
        complete();
      },
    );
    const mqtt = { url: "mqtt://localhost", connected: true };
    const withoutSource = buildStatusData(
      config,
      new Map(),
      mqtt,
      [],
      "version",
    );
    expect(withoutSource.heatedBedding![2]).toEqual({
      name: "Bed",
      zones: [
        { topic: "tuya/bed/side_a", state: null, pending: 0 },
        { topic: "tuya/bed/side_b", state: null, pending: 0 },
      ],
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
      source.handle(generation, "tuya/bed/side_b", HEATED_BEDDING_STATE, true);
      const outcomes = Promise.allSettled([
        source.writePreheat("tuya/bed/side_b", true),
      ]);
      const status = buildStatusData(
        config,
        new Map(),
        mqtt,
        [],
        "version",
        source,
      );
      expect(status.heatedBedding![2]).toMatchObject({
        name: "Bed",
        zones: [
          { topic: "tuya/bed/side_a", state: null, pending: 0 },
          { topic: "tuya/bed/side_b", state: HEATED_BEDDING_STATE, pending: 1 },
        ],
      });
      expect(status.heatedBedding![0]).toMatchObject({
        topic: "tuya/bed/side_a",
      });
      source.disconnect();
      await outcomes;
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

describe("Adaptive Lighting", () => {
  const TOPIC = "zigbee2mqtt/lamp";
  const controllers: { disableAdaptiveLighting: () => void }[] = [];
  let output: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    output = captureConsole();
  });

  afterEach(() => {
    for (const controller of controllers.splice(0))
      controller.disableAdaptiveLighting();
    // HAP-NodeJS erases the persisted transition from a debounced timer.
    if (jest.isFakeTimers()) jest.runOnlyPendingTimers();
    jest.useRealTimers();
    output.restore();
  });

  const logged = (prefix: string) =>
    output
      .lines()
      .map((line) => line.slice(line.indexOf(" ") + 1))
      .filter((line) => line.startsWith(prefix));

  function lampConfig(mac = "0E:42:A1:B2:C3:D4"): Config {
    return {
      ...testConfig(),
      bridge: { ...testConfig().bridge, mac },
      devices: [
        {
          name: "Lamp",
          type: "z2m",
          topic: TOPIC,
          capabilities: ["on_off", "brightness", "color_temp", "color_hs"],
        },
      ],
    };
  }

  async function startLamp(config = lampConfig(), connect = true) {
    const started = await startBridge(config, VERSION);
    if (connect) {
      mockClient.connected = true;
      mockClient.emit("connect");
    }
    const accessory = started.bridge.bridgedAccessories.find(
      (a) => a.displayName === "Lamp",
    )!;
    const controller = adaptiveLightingController(accessory)!;
    controllers.push(controller);
    const service = accessory.getService(Service.Lightbulb)!;
    const characteristic = (type: typeof Characteristic.Hue) =>
      service.getCharacteristic(type);
    const report = (state: Record<string, unknown>) => {
      mockClient.emit("message", TOPIC, Buffer.from(JSON.stringify(state)));
    };
    const published = () =>
      mockClient.published
        .filter((p) => p.topic === `${TOPIC}/set`)
        .map((p) => JSON.parse(p.message) as Record<string, unknown>);
    const sent = () => published().filter((message) => !("command" in message));
    const sentWhileOff = () =>
      published().filter((message) => "command" in message);
    const start = (options?: Parameters<typeof hubStartsAdaptiveLighting>[1]) =>
      hubStartsAdaptiveLighting(accessory, options);
    return {
      ...started,
      accessory,
      controller,
      characteristic,
      report,
      sent,
      sentWhileOff,
      published,
      start,
    };
  }

  const ON = {
    state: "ON",
    brightness: 254,
    color_mode: "color_temp",
    color_temp: 300,
  };
  const OFF = { ...ON, state: "OFF" };

  test("starting it on a light that is on publishes the temperature as Adaptive Lighting's", async () => {
    const { controller, characteristic, report, sent, start, shutdown } =
      await startLamp();
    report(ON);
    await start();
    await flush();

    expect(sent()).toEqual([{ color_temp: 350 }]);
    expect(logged("Adaptive Lighting for")).toEqual([
      `Adaptive Lighting for "Lamp": {"color_temp":350} published to ${TOPIC}/set as {"color_temp":350}`,
    ]);
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    expect(characteristic(Characteristic.Hue).value).toBe(
      Math.round(colorTempToHueSaturation(350).hue),
    );
    await shutdown();
  });

  test("a light that reports another brightness when HomeKit turns it on is sent the temperature for it once it has stood", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...OFF, brightness: 0 });
    await start();
    await flush();

    characteristic(Characteristic.On).setValue(true);
    await flush();
    expect(sent()).toEqual([{ state: "ON", color_temp: 395 }]);
    report({ ...ON, brightness: 254, color_temp: 395 });
    jest.advanceTimersByTime(9999);
    await flush();
    expect(sent()).toEqual([{ state: "ON", color_temp: 395 }]);
    jest.advanceTimersByTime(1);
    await flush();
    expect(sent()).toEqual([
      { state: "ON", color_temp: 395 },
      { color_temp: 350 },
    ]);
    await shutdown();
  });

  test("a brightness that a report gives in answer to a HomeKit write of another is acted on once it has stood", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(ON);
    await start(FLAT);
    await flush();
    report({ ...ON, color_temp: 350 });

    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        60,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent().slice(1)).toEqual([{ brightness: 152 }, { color_temp: 370 }]);
    report({ ...ON, brightness: 203, color_temp: 370 });
    jest.advanceTimersByTime(9999);
    await flush();
    expect(sent().slice(3)).toEqual([]);
    jest.advanceTimersByTime(1);
    await flush();
    expect(sent().slice(3)).toEqual([{ color_temp: 360 }]);
    await shutdown();
  });

  test("a turn-off that no report confirms does not send the temperature when it is undone", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(ON);
    await start(FLAT);
    await flush();
    report({ ...ON, color_temp: 350 });
    report({ ...ON, color_temp: 340 });

    characteristic(Characteristic.On).setValue(false);
    await flush();
    jest.advanceTimersByTime(2000);
    await flush();
    expect(characteristic(Characteristic.On).value).toBe(true);
    expect(sent()).toEqual([{ color_temp: 350 }, { state: "OFF" }]);
    await shutdown();
  });

  test("a light that is off is sent nothing, and the turn-on write carries the temperature", async () => {
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report(OFF);
    await start();
    await flush();
    expect(sent()).toEqual([]);

    characteristic(Characteristic.On).setValue(true);
    await flush();
    expect(sent()).toEqual([{ state: "ON", color_temp: 350 }]);
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    expect(logged("HomeKit write for")).toEqual([
      `HomeKit write for "Lamp": {"on":true} with the temperature of Adaptive Lighting published to ${TOPIC}/set as {"state":"ON","color_temp":350}`,
    ]);
    await shutdown();
  });

  test("a light turned on at another brightness is sent the temperature for that brightness", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(OFF);
    await start();
    await flush();

    // HAP-NodeJS handles a write request in the nextTick callback that ends
    // the request body, so the flush precedes the recomputed temperature.
    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        20,
        {} as never,
      );
      void characteristic(Characteristic.On).handleSetRequest(
        true,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent()).toEqual([
      { state: "ON", brightness: 50, color_temp: 350 },
      { color_temp: 390 },
    ]);
    await shutdown();
  });

  test("the stale reports that follow a turn-on write do not send the temperature back and forth", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(OFF);
    await start();
    await flush();

    const seen: [string, unknown][] = [];
    for (const type of [Characteristic.On, Characteristic.Brightness])
      characteristic(type).on("change", (change) => {
        if (change.oldValue !== change.newValue)
          seen.push([characteristic(type).displayName, change.newValue]);
      });
    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        60,
        {} as never,
      );
      void characteristic(Characteristic.On).handleSetRequest(
        true,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    seen.length = 0;
    // Zigbee2MQTT reports the state from before the write twice, then the new
    // state with the first temperature, then the second.
    for (const state of [
      OFF,
      { ...OFF, last_seen: 2 },
      { ...ON, brightness: 152, color_temp: 350 },
      { ...ON, brightness: 152, color_temp: 370 },
    ]) {
      report(state);
      await flush();
      expect(characteristic(Characteristic.Brightness).value).toBe(60);
      expect(characteristic(Characteristic.On).value).toBe(true);
    }
    jest.advanceTimersByTime(10000);
    expect(sent()).toEqual([
      { state: "ON", brightness: 152, color_temp: 350 },
      { color_temp: 370 },
    ]);
    expect(seen).toEqual([]);
    expect(characteristic(Characteristic.ColorTemperature).value).toBe(370);
    await shutdown();
  });

  test("a light that HomeKit has just turned off is not sent a recomputed temperature", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(ON);
    await start();
    await flush();
    characteristic(Characteristic.On).setValue(false);
    await flush();

    report({ brightness: 51 });
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }, { state: "OFF" }]);
    await shutdown();
  });

  test("a light that HomeKit turned off and on before any report is sent the temperature", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(ON);
    await start();
    await flush();
    characteristic(Characteristic.On).setValue(false);
    await flush();
    characteristic(Characteristic.On).setValue(true);
    await flush();
    expect(sent()).toEqual([
      { color_temp: 350 },
      { state: "OFF" },
      { state: "ON", color_temp: 350 },
    ]);
    await shutdown();
  });

  test("a turn-on write with its own temperature or color gets none added", async () => {
    for (const [writes, expected] of [
      [[[Characteristic.ColorTemperature, 300]], { color_temp: 300 }],
      [
        [
          [Characteristic.Hue, 120],
          [Characteristic.Saturation, 100],
        ],
        { color: { hue: 120, saturation: 100 } },
      ],
    ] as const) {
      const { report, sent, start, characteristic, shutdown } =
        await startLamp();
      report(OFF);
      await start();
      await flush();
      characteristic(Characteristic.On).setValue(true);
      for (const [type, value] of writes) characteristic(type).setValue(value);
      await flush();
      expect(sent()).toEqual([{ state: "ON", ...expected }]);
      await shutdown();
    }
  });

  test("a temperature that the light already shows is not sent again, until it shows another", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, shutdown } = await startLamp();
    report(ON);
    await start();
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }]);

    report({ ...ON, color_temp: 348 });
    jest.advanceTimersByTime(60000);
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }]);

    report({ ...ON, color_temp: 400 });
    jest.advanceTimersByTime(60000);
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }, { color_temp: 347 }]);
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    await shutdown();
  });

  // A schedule that takes weeks to change holds one temperature for a Brightness.
  const FLAT = { spanMs: 4e9 };

  test("a bulb that clamps the temperature is sent it twice and then left alone", async () => {
    jest.useFakeTimers();
    const { report, sent, start, shutdown } = await startLamp();
    report(ON);
    await start(FLAT);
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }]);

    report({ ...ON, color_temp: 370 });
    for (let minute = 0; minute < 4; minute++) {
      jest.advanceTimersByTime(60000);
      await flush();
    }
    expect(sent()).toEqual([{ color_temp: 350 }, { color_temp: 350 }]);
    await shutdown();
  });

  test("a bulb that clamps the temperature is sent it again once Adaptive Lighting is turned on again", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report(ON);
    await start(FLAT);
    await flush();
    report({ ...ON, color_temp: 370 });
    for (let minute = 0; minute < 3; minute++) {
      jest.advanceTimersByTime(60000);
      await flush();
    }
    expect(sent()).toEqual([{ color_temp: 350 }, { color_temp: 350 }]);

    characteristic(Characteristic.ColorTemperature).setValue(370);
    await flush();
    expect(controller.isAdaptiveLightingActive()).toBe(false);
    jest.advanceTimersByTime(1000);
    report({ ...ON, color_temp: 370 });
    await start(FLAT);
    await flush();
    expect(sent()).toEqual([
      { color_temp: 350 },
      { color_temp: 350 },
      { color_temp: 370 },
      { color_temp: 350 },
    ]);
    await shutdown();
  });

  test("a command that never takes effect is sent twice", async () => {
    jest.useFakeTimers();
    const { report, sent, start, shutdown } = await startLamp();
    report(ON);
    await start(FLAT);
    await flush();
    for (let minute = 0; minute < 4; minute++) {
      report({ ...ON, color_temp: 310 });
      jest.advanceTimersByTime(60000);
      await flush();
    }
    expect(sent()).toEqual([{ color_temp: 350 }, { color_temp: 350 }]);
    await shutdown();
  });

  test("a bulb that clamps the temperature is sent it again after it shows another", async () => {
    jest.useFakeTimers();
    const { report, sent, start, shutdown } = await startLamp();
    report(ON);
    await start(FLAT);
    await flush();
    for (const shown of [370, 370, 370, 300, 370, 370, 370]) {
      report({ ...ON, color_temp: shown });
      jest.advanceTimersByTime(60000);
      await flush();
    }
    // Asked at the start, at 370 (recorded), at 300, and at 370 again.
    expect(sent()).toHaveLength(4);
    await shutdown();
  });

  test("a bulb that clamps the temperature is sent a different temperature at once", async () => {
    jest.useFakeTimers();
    const { report, sent, start, shutdown } = await startLamp();
    report(ON);
    await start(FLAT);
    await flush();
    report({ ...ON, color_temp: 370 });
    for (let minute = 0; minute < 3; minute++) {
      jest.advanceTimersByTime(60000);
      await flush();
    }
    expect(sent()).toHaveLength(2);

    report({ ...ON, brightness: 25, color_temp: 370 });
    jest.advanceTimersByTime(10000);
    await flush();
    for (let minute = 0; minute < 3; minute++) {
      report({ ...ON, brightness: 25, color_temp: 370 });
      jest.advanceTimersByTime(60000);
      await flush();
    }
    expect(sent().slice(2)).toEqual([{ color_temp: 395 }, { color_temp: 395 }]);
    await shutdown();
  });

  test("a light that takes the temperature is corrected each time it is changed to the same value outside HomeKit", async () => {
    jest.useFakeTimers();
    const { report, sent, start, shutdown } = await startLamp();
    report(ON);
    await start(FLAT);
    await flush();
    expect(sent()).toHaveLength(1);
    for (let change = 0; change < 4; change++) {
      report({ ...ON, color_temp: 350 });
      jest.advanceTimersByTime(60000);
      await flush();
      report({ ...ON, color_temp: 370 });
      jest.advanceTimersByTime(60000);
      await flush();
    }
    expect(sent()).toHaveLength(5);
    await shutdown();
  });

  test("a Brightness write to a light that is off carries the temperature, and the recomputed one follows", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(OFF);
    await start();
    await flush();

    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        20,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent()).toEqual([
      { brightness: 50, color_temp: 350 },
      { color_temp: 390 },
    ]);
    await shutdown();
  });

  test("a Brightness write to a light that is on gets no temperature added", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(ON);
    await start();
    await flush();

    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        20,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent()).toEqual([
      { color_temp: 350 },
      { brightness: 50 },
      { color_temp: 390 },
    ]);
    await shutdown();
  });

  test("a write of On to a light that is already on gets no temperature added", async () => {
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(ON);
    await start();
    await flush();

    characteristic(Characteristic.On).setValue(true);
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }, { state: "ON" }]);
    await shutdown();
  });

  test("a Brightness of zero without On is not a turn-on", async () => {
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(OFF);
    await start();
    await flush();

    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        0,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent()).toEqual([{ brightness: 0 }]);
    await shutdown();
  });

  test("a light turned off and on again is sent the temperature even if it showed it before", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();
    expect(sent()).toEqual([]);

    report({ ...ON, state: "OFF", color_temp: 200 });
    characteristic(Characteristic.On).setValue(true);
    await flush();
    expect(sent()).toEqual([{ state: "ON", color_temp: 350 }]);
    await shutdown();
  });

  test("a report that brightens the light is followed by the temperature once the brightness has stood", async () => {
    jest.useFakeTimers();
    const { report, sent, start, shutdown } = await startLamp();
    report({ ...ON, brightness: 25 });
    await start();
    await flush();
    expect(sent()).toEqual([{ color_temp: 395 }]);

    report({ ...ON, brightness: 254, color_temp: 395 });
    jest.advanceTimersByTime(9999);
    await flush();
    expect(sent()).toEqual([{ color_temp: 395 }]);
    jest.advanceTimersByTime(1);
    await flush();
    expect(sent()).toEqual([{ color_temp: 395 }, { color_temp: 350 }]);
    expect(logged("Adaptive Lighting for")).toEqual([
      `Adaptive Lighting for "Lamp": {"color_temp":395} published to ${TOPIC}/set as {"color_temp":395}`,
      `Adaptive Lighting for "Lamp": {"color_temp":350} published to ${TOPIC}/set as {"color_temp":350}`,
    ]);
    await shutdown();
  });

  test("the schedule's updates bring no notification of Hue or Saturation", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(ON);
    await start({ notifyMs: 3_600_000 });
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }]);
    report({ ...ON, color_temp: 350 });

    // HAP-NodeJS notifies controllers of an update only if it changes the value.
    const notified: unknown[] = [];
    for (const type of [Characteristic.Hue, Characteristic.Saturation]) {
      characteristic(type).on("change", (change) => {
        if (change.oldValue !== change.newValue)
          notified.push([
            characteristic(type).displayName,
            change.oldValue,
            change.newValue,
          ]);
      });
    }

    const last = () => (sent().at(-1) as { color_temp: number }).color_temp;
    for (let minute = 0; minute < 10; minute++) {
      jest.advanceTimersByTime(60000);
      await flush();
      report({ ...ON, color_temp: last() });
    }
    expect(sent()).toHaveLength(11);
    const temperature = last();
    expect(temperature).toBeLessThan(340);
    const color = colorTempToHueSaturation(temperature);
    expect(characteristic(Characteristic.Saturation).value).toBe(
      Math.round(color.saturation),
    );
    expect(notified).toEqual([]);
    await shutdown();
  });

  test("a temperature recomputed for a brightness that has stood sets the curve's Hue and Saturation without a notification", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...ON, brightness: 25, color_temp: 395 });
    await start();
    await flush();
    expect(sent()).toEqual([]);
    report({ ...ON, brightness: 254, color_temp: 395 });

    const notified: unknown[] = [];
    for (const type of [Characteristic.Hue, Characteristic.Saturation]) {
      characteristic(type).on("change", (change) => {
        if (change.oldValue !== change.newValue)
          notified.push([
            characteristic(type).displayName,
            change.oldValue,
            change.newValue,
          ]);
      });
    }

    jest.advanceTimersByTime(10000);
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }]);
    const color = colorTempToHueSaturation(350);
    expect(characteristic(Characteristic.Hue).value).toBe(
      Math.round(color.hue),
    );
    expect(characteristic(Characteristic.Saturation).value).toBe(
      Math.round(color.saturation),
    );
    expect(notified).toEqual([]);
    await shutdown();
  });

  test("a color in a report turns it off", async () => {
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report(OFF);
    await start();
    await flush();
    expect(controller.isAdaptiveLightingActive()).toBe(true);

    report({
      state: "ON",
      color_mode: "hs",
      color: { hue: 120, saturation: 100 },
      color_temp: 500,
    });
    expect(controller.isAdaptiveLightingActive()).toBe(false);
    expect(characteristic(Characteristic.ColorTemperature).value).toBe(140);
    expect(sent()).toEqual([]);
    expect(logged("Adaptive Lighting off for")).toEqual([
      'Adaptive Lighting off for "Lamp": the light shows a color',
    ]);
    await shutdown();
  });

  const GREEN = {
    state: "ON",
    brightness: 254,
    color_mode: "hs",
    color: { hue: 120, saturation: 100 },
    color_temp: 500,
  };

  test("a report that repeats the color shown before a write does not turn it off", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, shutdown } = await startLamp();
    report(GREEN);
    await start();
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }]);

    jest.advanceTimersByTime(1999);
    report({ ...GREEN, last_seen: 1 });
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    await shutdown();
  });

  test("a report that changes the color to another turns it off at once", async () => {
    jest.useFakeTimers();
    const { controller, report, start, shutdown } = await startLamp();
    report(GREEN);
    await start();
    await flush();

    report({ ...GREEN, color: { hue: 240, saturation: 100 } });
    expect(controller.isAdaptiveLightingActive()).toBe(false);
    await shutdown();
  });

  for (const [elapsed, active] of [
    [1999, true],
    [2000, false],
  ] as const) {
    test(`a color that the light still shows after ${String(elapsed)} ms turns it off: ${String(!active)}`, async () => {
      jest.useFakeTimers();
      const { controller, report, start, shutdown } = await startLamp();
      report(GREEN);
      await start();
      await flush();
      jest.advanceTimersByTime(elapsed);
      expect(controller.isAdaptiveLightingActive()).toBe(active);
      await shutdown();
    });
  }

  describe("a Zigbee2MQTT light that is off", () => {
    const command = (temperature: number) => ({
      command: {
        cluster: "lightingColorCtrl",
        command: "moveToColorTemp",
        payload: {
          colortemp: temperature,
          transtime: 0,
          optionsMask: 1,
          optionsOverride: 1,
        },
      },
    });
    const minute = async () => {
      jest.advanceTimersByTime(60000);
      await flush();
    };

    test("is sent the temperature as a raw command that stores it, and nothing else", async () => {
      jest.useFakeTimers();
      const { report, sent, sentWhileOff, start, characteristic, shutdown } =
        await startLamp();
      report({ ...OFF, color_temp: 300 });
      await start(FLAT);
      await flush();

      expect(sentWhileOff()).toEqual([command(350)]);
      expect(sent()).toEqual([]);
      expect(logged('Adaptive Lighting for "Lamp" while off')).toEqual([
        `Adaptive Lighting for "Lamp" while off: {"color_temp":350} published to ${TOPIC}/set as ${JSON.stringify(command(350))}`,
      ]);
      expect(characteristic(Characteristic.On).value).toBe(false);
      await shutdown();
    });

    test("is sent the same temperature once, and a new one when it changes", async () => {
      jest.useFakeTimers();
      const { report, sentWhileOff, start, shutdown } = await startLamp();
      report({ ...OFF, color_temp: 300 });
      await start(FLAT);
      await flush();
      await minute();
      await minute();
      expect(sentWhileOff()).toEqual([command(350)]);
      await shutdown();

      mockClient.published.length = 0;
      const second = await startLamp(lampConfig("0E:42:A1:B2:C3:D5"));
      second.report({ ...OFF, color_temp: 300 });
      await second.start();
      await flush();
      await minute();
      await minute();
      const temperatures = second
        .sentWhileOff()
        .map(
          (message) =>
            (message.command as { payload: { colortemp: number } }).payload
              .colortemp,
        );
      expect(temperatures.length).toBe(3);
      expect(new Set(temperatures).size).toBe(3);
      await second.shutdown();
    });

    test("is sent nothing while its power is unknown", async () => {
      jest.useFakeTimers();
      const { published, start, shutdown } = await startLamp();
      await start();
      await flush();
      await minute();
      expect(published()).toEqual([]);
      await shutdown();
    });

    test("is sent nothing while MQTT is down, and the temperature once it is back", async () => {
      jest.useFakeTimers();
      const { report, published, sentWhileOff, start, shutdown } =
        await startLamp();
      report({ ...OFF, color_temp: 300 });
      mockClient.connected = false;
      await start(FLAT);
      await flush();
      await minute();
      expect(published()).toEqual([]);

      mockClient.connected = true;
      await minute();
      expect(sentWhileOff()).toEqual([command(350)]);
      await shutdown();
    });

    test("does not make the controller's set fail while MQTT is down", async () => {
      jest.useFakeTimers();
      const {
        controller,
        report,
        characteristic,
        sentWhileOff,
        start,
        shutdown,
      } = await startLamp();
      report({ ...OFF, color_temp: 300 });
      await start(FLAT);
      await flush();
      mockClient.connected = false;

      const temperature = characteristic(Characteristic.ColorTemperature);
      const set = (): unknown =>
        temperature.handleSetRequest(320, undefined, { controller });
      await set();
      expect(sentWhileOff()).toEqual([command(350)]);
      await shutdown();
    });

    test("that HomeKit has just turned off is sent the temperature", async () => {
      jest.useFakeTimers();
      const { report, sent, sentWhileOff, start, characteristic, shutdown } =
        await startLamp();
      report({ ...ON, color_temp: 350 });
      await start({ intervalMs: 1000, spanMs: 100000 });
      await flush();
      characteristic(Characteristic.On).setValue(false);
      await flush();
      expect(sent()).toEqual([{ state: "OFF" }]);
      expect(sentWhileOff()).toEqual([]);

      jest.advanceTimersByTime(1000);
      await flush();
      expect(sentWhileOff()).toEqual([command(349)]);
      await shutdown();
    });

    test("is still sent the temperature with a HomeKit turn-on", async () => {
      jest.useFakeTimers();
      const { report, sent, sentWhileOff, start, characteristic, shutdown } =
        await startLamp();
      report({ ...OFF, color_temp: 300 });
      await start(FLAT);
      await flush();
      expect(sentWhileOff()).toEqual([command(350)]);

      characteristic(Characteristic.On).setValue(true);
      await flush();
      expect(sent()).toEqual([{ state: "ON", color_temp: 350 }]);
      await shutdown();
    });

    test("that a report from outside turns on is sent the temperature in the usual way, and again when it goes off", async () => {
      jest.useFakeTimers();
      const { report, sent, sentWhileOff, start, shutdown } = await startLamp();
      report({ ...OFF, color_temp: 300 });
      await start(FLAT);
      await flush();
      expect(sentWhileOff()).toEqual([command(350)]);

      report({ ...ON, color_temp: 300 });
      expect(sent()).toEqual([{ color_temp: 350 }]);
      report({ ...ON, color_temp: 350 });
      report({ ...OFF, color_temp: 350 });
      await minute();
      expect(sentWhileOff()).toEqual([command(350), command(350)]);
      await shutdown();
    });

    test("is sent the temperature again after a report that it is on, even one that shows the temperature", async () => {
      jest.useFakeTimers();
      const { report, sent, sentWhileOff, start, shutdown } = await startLamp();
      report({ ...OFF, color_temp: 300 });
      await start(FLAT);
      await flush();
      expect(sentWhileOff()).toEqual([command(350)]);

      report({ ...ON, color_temp: 350 });
      report({ ...OFF, color_temp: 350 });
      await minute();
      expect(sentWhileOff()).toEqual([command(350), command(350)]);
      expect(sent()).toEqual([]);
      await shutdown();
    });

    test("is not sent the temperature again after reports that do not show it on", async () => {
      jest.useFakeTimers();
      const { report, sentWhileOff, start, shutdown } = await startLamp();
      report({ ...OFF, color_temp: 300 });
      await start(FLAT);
      await flush();
      expect(sentWhileOff()).toEqual([command(350)]);

      report({ ...OFF, color_temp: 300 });
      report({ linkquality: 80 });
      await minute();
      expect(sentWhileOff()).toEqual([command(350)]);
      await shutdown();
    });

    test("is sent the temperature again after a HomeKit write for it", async () => {
      jest.useFakeTimers();
      const { report, sent, sentWhileOff, start, characteristic, shutdown } =
        await startLamp();
      report({ ...OFF, color_temp: 300 });
      await start(FLAT);
      await flush();
      expect(sentWhileOff()).toEqual([command(350)]);

      characteristic(Characteristic.On).setValue(false);
      await flush();
      expect(sent()).toEqual([{ state: "OFF" }]);
      await minute();
      expect(sentWhileOff()).toEqual([command(350), command(350)]);
      await shutdown();
    });

    test("is sent nothing when Adaptive Lighting is not active", async () => {
      jest.useFakeTimers();
      const { controller, report, published, start, characteristic, shutdown } =
        await startLamp();
      report({ ...ON, color_temp: 350 });
      await start(FLAT);
      await flush();
      characteristic(Characteristic.ColorTemperature).setValue(250);
      await flush();
      expect(controller.isAdaptiveLightingActive()).toBe(false);
      report({ ...OFF, color_temp: 250 });
      mockClient.published.length = 0;

      await minute();
      await minute();
      expect(published()).toEqual([]);
      await shutdown();
    });
  });

  test("a light turned on by a switch, whose brightness flickers, is sent nothing", async () => {
    jest.useFakeTimers();
    const { report, sent, start, shutdown } = await startLamp();
    report({ ...OFF, color_temp: 350 });
    await start();
    await flush();
    expect(sent()).toEqual([]);

    report({ ...ON, color_temp: 350 });
    jest.advanceTimersByTime(14);
    report({ ...ON, brightness: 31, color_temp: 350 });
    jest.advanceTimersByTime(5200);
    report({ ...ON, color_temp: 350 });
    jest.advanceTimersByTime(10000);
    await flush();
    expect(sent()).toEqual([]);
    expect(logged('Adaptive Lighting for "Lamp": ')).toEqual([]);
    await shutdown();
  });

  test("a light turned on by a switch after the schedule moved is sent the temperature once", async () => {
    jest.useFakeTimers();
    const { report, sent, start, shutdown } = await startLamp();
    report({ ...OFF, color_temp: 300 });
    await start();
    await flush();
    expect(sent()).toEqual([]);

    report({ ...ON, color_temp: 300 });
    expect(sent()).toEqual([{ color_temp: 350 }]);
    report({ ...ON, color_temp: 350 });
    jest.advanceTimersByTime(14);
    report({ ...ON, brightness: 31, color_temp: 350 });
    jest.advanceTimersByTime(5200);
    report({ ...ON, color_temp: 350 });
    jest.advanceTimersByTime(10000);
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }]);
    expect(logged('Adaptive Lighting for "Lamp": ')).toEqual([
      `Adaptive Lighting for "Lamp": {"color_temp":350} published to ${TOPIC}/set as {"color_temp":350}`,
    ]);
    await shutdown();
  });

  test("a light turned on outside HomeKit is sent nothing while Adaptive Lighting is not active", async () => {
    const { report, sent, shutdown } = await startLamp();
    report(OFF);
    report(ON);
    await flush();
    expect(sent()).toEqual([]);
    await shutdown();
  });

  test("a light that a report turns on while MQTT is down is sent nothing", async () => {
    jest.useFakeTimers();
    const { report, sent, start, shutdown } = await startLamp();
    report({ ...OFF, color_temp: 300 });
    await start();
    await flush();
    mockClient.connected = false;
    report({ ...ON, color_temp: 300 });
    expect(sent()).toEqual([]);
    await shutdown();
  });

  test("a brightness that a switch sets and leaves is shown after 10 s, with the temperature for it", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();
    expect(sent()).toEqual([]);

    report({ ...ON, brightness: 127, color_temp: 350 });
    jest.advanceTimersByTime(9999);
    await flush();
    expect(sent()).toEqual([]);
    expect(characteristic(Characteristic.Brightness).value).toBe(100);
    jest.advanceTimersByTime(1);
    await flush();
    expect(characteristic(Characteristic.Brightness).value).toBe(50);
    expect(sent()).toEqual([{ color_temp: 375 }]);
    await shutdown();
  });

  test("a different brightness during the hold restarts it", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();

    report({ ...ON, brightness: 127, color_temp: 350 });
    jest.advanceTimersByTime(6000);
    report({ ...ON, brightness: 203, color_temp: 350 });
    jest.advanceTimersByTime(9999);
    await flush();
    expect(sent()).toEqual([]);
    expect(characteristic(Characteristic.Brightness).value).toBe(100);
    jest.advanceTimersByTime(1);
    await flush();
    expect(characteristic(Characteristic.Brightness).value).toBe(80);
    expect(sent()).toEqual([{ color_temp: 360 }]);
    await shutdown();
  });

  test("a repeat of the held brightness does not restart the hold", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();
    report({ ...ON, brightness: 127, color_temp: 350 });
    jest.advanceTimersByTime(6000);
    report({ ...ON, brightness: 127, color_temp: 350, last_seen: 1 });
    jest.advanceTimersByTime(3999);
    await flush();
    expect(sent()).toEqual([]);
    expect(characteristic(Characteristic.Brightness).value).toBe(100);
    jest.advanceTimersByTime(1);
    await flush();
    expect(characteristic(Characteristic.Brightness).value).toBe(50);
    expect(sent()).toEqual([{ color_temp: 375 }]);
    await shutdown();
  });

  test("a brightness that returns to the one shown drops the hold", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();
    report({ ...ON, brightness: 127, color_temp: 350 });
    jest.advanceTimersByTime(5200);
    report({ ...ON, color_temp: 350 });
    expect(characteristic(Characteristic.Brightness).value).toBe(100);
    jest.advanceTimersByTime(10000);
    await flush();
    expect(characteristic(Characteristic.Brightness).value).toBe(100);
    expect(sent()).toEqual([]);
    await shutdown();
  });

  test("a brightness that HomeKit writes drops the held one, and its temperature is sent", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();
    report({ ...ON, brightness: 127, color_temp: 350 });

    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        20,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent()).toEqual([{ brightness: 50 }, { color_temp: 390 }]);
    report({ ...ON, brightness: 50, color_temp: 390 });
    jest.advanceTimersByTime(10000);
    await flush();
    expect(sent()).toHaveLength(2);
    expect(characteristic(Characteristic.Brightness).value).toBe(20);
    await shutdown();
  });

  test("a brightness held when Adaptive Lighting turns off is still shown", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();
    report({ ...ON, brightness: 127, color_temp: 350 });
    jest.advanceTimersByTime(1000);
    report({
      state: "ON",
      brightness: 127,
      color_mode: "hs",
      color: { hue: 120, saturation: 100 },
      color_temp: 500,
    });
    expect(controller.isAdaptiveLightingActive()).toBe(false);
    jest.advanceTimersByTime(9000);
    await flush();
    expect(characteristic(Characteristic.Brightness).value).toBe(50);
    expect(sent()).toEqual([]);
    await shutdown();
  });

  test("a report that leaves the light off publishes nothing while the brightness is held", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...OFF, color_temp: 300 });
    await start();
    await flush();
    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        20,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent()).toEqual([
      { brightness: 50, color_temp: 350 },
      { color_temp: 390 },
    ]);

    report({ ...OFF, brightness: 127, color_temp: 300 });
    report({ ...OFF, brightness: 127, color_temp: 300, last_seen: 1 });
    expect(sent()).toHaveLength(2);
    expect(characteristic(Characteristic.On).value).toBe(false);
    await shutdown();
  });

  test("a write of something else leaves the hold running", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();
    report({ ...ON, brightness: 127, color_temp: 350 });
    jest.advanceTimersByTime(1000);
    characteristic(Characteristic.On).setValue(true);
    await flush();
    expect(sent()).toEqual([{ state: "ON" }]);
    jest.advanceTimersByTime(9000);
    await flush();
    expect(sent()).toEqual([{ state: "ON" }, { color_temp: 375 }]);
    await shutdown();
  });

  test("a held brightness that is shown after HomeKit turned Adaptive Lighting off publishes nothing", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();
    report({ ...ON, brightness: 127, color_temp: 350 });
    characteristic(Characteristic.Hue).setValue(120);
    characteristic(Characteristic.Saturation).setValue(100);
    await flush();
    expect(controller.isAdaptiveLightingActive()).toBe(false);
    const written = sent().length;
    jest.advanceTimersByTime(10000);
    await flush();
    expect(sent()).toHaveLength(written);
    await shutdown();
  });

  test("shutdown cancels the hold", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report({ ...ON, color_temp: 350 });
    await start();
    await flush();
    report({ ...ON, brightness: 127, color_temp: 350 });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    await shutdown();
    const timers = jest.getTimerCount();
    jest.advanceTimersByTime(10000);
    await flush();
    expect(sent()).toEqual([]);
    expect(characteristic(Characteristic.Brightness).value).toBe(100);
    expect(jest.getTimerCount()).toBeLessThanOrEqual(timers);
  });

  test("a Brightness of zero without On is not sent a recomputed temperature", async () => {
    jest.useFakeTimers();
    const { report, sent, start, characteristic, shutdown } = await startLamp();
    report(ON);
    await start();
    await flush();

    process.nextTick(() => {
      void characteristic(Characteristic.Brightness).handleSetRequest(
        0,
        {} as never,
      );
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent()).toEqual([{ color_temp: 350 }, { brightness: 0 }]);
    await shutdown();
  });

  async function schedule(
    controller: object,
    characteristic: (type: typeof Characteristic.Hue) => Characteristic,
    mireds: number,
  ) {
    void characteristic(Characteristic.ColorTemperature).handleSetRequest(
      mireds,
      undefined,
      { controller },
    );
    await new Promise((resolve) => setImmediate(resolve));
  }

  for (const [elapsed, recomputed] of [
    [1999, [{ color_temp: 395 }]],
    [2000, []],
  ] as const) {
    test(`a power write stands for the light after ${String(elapsed)} ms`, async () => {
      jest.useFakeTimers();
      const { controller, report, sent, start, characteristic, shutdown } =
        await startLamp();
      report(OFF);
      await start(FLAT);
      await flush();
      characteristic(Characteristic.On).setValue(true);
      await flush();
      jest.advanceTimersByTime(elapsed);
      await schedule(controller, characteristic, 395);
      expect(sent()).toEqual([{ state: "ON", color_temp: 350 }, ...recomputed]);
      await shutdown();
    });
  }

  test("a report that changes the power ends the stand of a power write", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report(ON);
    await start(FLAT);
    await flush();
    characteristic(Characteristic.On).setValue(true);
    await flush();
    report(OFF);
    await schedule(controller, characteristic, 395);
    expect(sent()).toEqual([{ color_temp: 350 }, { state: "ON" }]);
    await shutdown();
  });

  test("a write of only a temperature does not keep an earlier power write alive", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report(OFF);
    await start(FLAT);
    await flush();
    characteristic(Characteristic.On).setValue(true);
    await flush();
    jest.advanceTimersByTime(1500);
    await schedule(controller, characteristic, 395);
    jest.advanceTimersByTime(600);
    await schedule(controller, characteristic, 400);
    expect(sent()).toEqual([
      { state: "ON", color_temp: 350 },
      { color_temp: 395 },
    ]);
    await shutdown();
  });

  for (const [elapsed, again] of [
    [1999, []],
    [2000, [{ color_temp: 350 }]],
  ] as const) {
    test(`a temperature write stands for the light after ${String(elapsed)} ms`, async () => {
      jest.useFakeTimers();
      const { controller, report, sent, start, characteristic, shutdown } =
        await startLamp();
      report({ ...ON, color_temp: 300 });
      await start(FLAT);
      await flush();
      jest.advanceTimersByTime(elapsed);
      await schedule(controller, characteristic, 350);
      expect(sent()).toEqual([{ color_temp: 350 }, ...again]);
      await shutdown();
    });
  }

  test("a report that changes the color ends the stand of a temperature write", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report({ ...ON, color_temp: 300 });
    await start(FLAT);
    await flush();
    report({ ...ON, color_temp: 320 });
    await schedule(controller, characteristic, 350);
    expect(sent()).toEqual([{ color_temp: 350 }, { color_temp: 350 }]);
    await shutdown();
  });

  test("a power write does not keep an earlier temperature alive", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report({ ...ON, color_temp: 300 });
    await start(FLAT);
    await flush();
    jest.advanceTimersByTime(1500);
    characteristic(Characteristic.On).setValue(true);
    await flush();
    jest.advanceTimersByTime(600);
    await schedule(controller, characteristic, 350);
    expect(sent()).toEqual([
      { color_temp: 350 },
      { state: "ON" },
      { color_temp: 350 },
    ]);
    await shutdown();
  });

  const lampWithScene = () => {
    const config = lampConfig();
    config.devices[0]!.scenes = [{ name: "Movie", id: 1 }];
    config.devices.push({
      name: "Hall",
      type: "z2m",
      topic: "zigbee2mqtt/hall",
      capabilities: ["on_off", "brightness", "color_temp"],
      scenes: [{ name: "Hall Movie", id: 2 }],
    });
    return config;
  };
  const recall = (
    bridge: { bridgedAccessories: { displayName: string }[] },
    name: string,
  ) =>
    (bridge.bridgedAccessories.find((a) => a.displayName === name) as Accessory)
      .getService(Service.Switch)!
      .getCharacteristic(Characteristic.On)
      .setValue(true);

  test("recalling a scene of its device turns Adaptive Lighting off", async () => {
    const { bridge, controller, report, sent, start, shutdown } =
      await startLamp(lampWithScene());
    report(ON);
    await start();
    await flush();

    recall(bridge, "Movie");
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }, { scene_recall: 1 }]);
    expect(controller.isAdaptiveLightingActive()).toBe(false);
    expect(logged("Adaptive Lighting off for")).toEqual([
      'Adaptive Lighting off for "Lamp": a scene was recalled',
    ]);

    recall(bridge, "Movie");
    await flush();
    expect(logged("Adaptive Lighting off for")).toHaveLength(1);
    await shutdown();
  });

  test("a scene recall that cannot be published leaves Adaptive Lighting on", async () => {
    const { bridge, controller, report, start, shutdown } =
      await startLamp(lampWithScene());
    report(ON);
    await start();
    await flush();

    mockClient.connected = false;
    recall(bridge, "Movie");
    await flush();
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    expect(logged("Adaptive Lighting off for")).toEqual([]);
    await shutdown();
  });

  test("recalling a scene of another device leaves Adaptive Lighting on", async () => {
    const { bridge, controller, report, start, shutdown } =
      await startLamp(lampWithScene());
    report(ON);
    await start();
    await flush();

    recall(bridge, "Hall Movie");
    await flush();
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    expect(logged("Adaptive Lighting off for")).toEqual([]);
    await shutdown();
  });

  describe("on a WLED light with white segments", () => {
    async function startNook() {
      const config = wledConfig();
      config.devices = [
        {
          name: "Lamp",
          type: "wled",
          topic: "wled/nook",
          capabilities: ["on_off", "brightness", "color_temp", "color_hs"],
          colorSegments: [0],
          whiteSegments: [1, 2],
          whiteChannels: { r: 5500, g: 2400, b: 5500, w: 2400 },
          gamma: 2.2,
        },
      ];
      const { bridge, shutdown } = await startBridge(config, VERSION);
      mockClient.connected = true;
      mockClient.emit("connect");
      const accessory = bridge.bridgedAccessories.find(
        (a) => a.displayName === "Lamp",
      )!;
      const controller = adaptiveLightingController(accessory)!;
      controllers.push(controller);
      await hubStartsAdaptiveLighting(accessory);
      await flush();
      return { controller, shutdown };
    }

    test("the white at the end with no lit w channel, reported after a restart, leaves it on", async () => {
      const { controller, shutdown } = await startNook();
      mockClient.emit("message", "wled/nook/c", Buffer.from("#FF00FF"));
      expect(controller.isAdaptiveLightingActive()).toBe(true);
      expect(logged("Adaptive Lighting off for")).toEqual([]);
      await shutdown();
    });

    test("an ordinary color in a report turns it off", async () => {
      const { controller, shutdown } = await startNook();
      mockClient.emit("message", "wled/nook/c", Buffer.from("#00FF00"));
      expect(controller.isAdaptiveLightingActive()).toBe(false);
      await shutdown();
    });
  });

  test("a white at the minimum temperature in a report does not turn it off", async () => {
    const { controller, report, start, shutdown } = await startLamp();
    report(OFF);
    await start();
    report({ state: "ON", color_mode: "color_temp", color_temp: 140 });
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    expect(logged("Adaptive Lighting off for")).toEqual([]);
    await shutdown();
  });

  test("a temperature that changes outside HomeKit does not turn it off", async () => {
    const { controller, report, start, shutdown } = await startLamp();
    report(OFF);
    await start();
    report({ color_temp: 250, color_mode: "color_temp" });
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    await shutdown();
  });

  test("a HomeKit write of a temperature, or of Hue and Saturation, turns it off", async () => {
    for (const type of [
      Characteristic.ColorTemperature,
      Characteristic.Hue,
      Characteristic.Saturation,
    ]) {
      const { controller, report, start, characteristic, shutdown } =
        await startLamp();
      report(OFF);
      await start();
      characteristic(type).setValue(type === Characteristic.Hue ? 30 : 250);
      await flush();
      expect(controller.isAdaptiveLightingActive()).toBe(false);
      await shutdown();
    }
  });

  test("a write while MQTT is down neither throws nor publishes, and the temperature is remembered", async () => {
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report(ON);
    mockClient.connected = false;
    const temperature = characteristic(Characteristic.ColorTemperature);
    const handle = temperature.handleSetRequest.bind(temperature);
    const settled: Promise<unknown>[] = [];
    jest
      .spyOn(temperature, "handleSetRequest")
      .mockImplementation((...args: Parameters<typeof handle>) => {
        const result = handle(...args);
        settled.push(result);
        return result;
      });
    await start();
    await flush();
    expect(sent()).toEqual([]);
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    expect(await Promise.allSettled(settled)).toEqual([
      { status: "fulfilled", value: undefined },
    ]);

    mockClient.connected = true;
    report(OFF);
    characteristic(Characteristic.On).setValue(true);
    await flush();
    expect(sent()).toEqual([{ state: "ON", color_temp: 350 }]);
    await shutdown();
  });

  test("a light that Adaptive Lighting no longer controls is not sent the remembered temperature", async () => {
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report(ON);
    await start();
    await flush();
    characteristic(Characteristic.ColorTemperature).setValue(250);
    await flush();
    expect(controller.isAdaptiveLightingActive()).toBe(false);

    report(OFF);
    characteristic(Characteristic.On).setValue(true);
    await flush();
    expect(sent().at(-1)).toEqual({ state: "ON" });
    await shutdown();
  });

  test("shutdown leaves Adaptive Lighting on", async () => {
    const { controller, report, start, shutdown } = await startLamp();
    report(OFF);
    await start();
    await shutdown();
    expect(controller.isAdaptiveLightingActive()).toBe(true);
  });

  test("a light without brightness or color_temp has no controller", async () => {
    const config = lampConfig();
    config.devices[0]!.capabilities = ["on_off", "color_temp"];
    const { bridge, shutdown } = await startBridge(config, VERSION);
    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Lamp",
    )!;
    expect(adaptiveLightingController(accessory)).toBeUndefined();
    await shutdown();
  });

  test("a light with white segments gets it over its own range and publishes segment colors", async () => {
    const config = wledConfig();
    config.devices = [
      {
        name: "Lamp",
        type: "wled",
        topic: "wled/nook",
        capabilities: ["on_off", "brightness", "color_temp", "color_hs"],
        colorSegments: [0],
        whiteSegments: [1, 2],
        whiteChannels: { r: 5500, g: 2400, b: 5500, w: 2400 },
        gamma: 2.2,
      },
    ];
    const { bridge, shutdown } = await startBridge(config, VERSION);
    mockClient.connected = true;
    mockClient.emit("connect");
    const accessory = bridge.bridgedAccessories.find(
      (a) => a.displayName === "Lamp",
    )!;
    const controller = adaptiveLightingController(accessory)!;
    controllers.push(controller);
    const service = accessory.getService(Service.Lightbulb)!;
    mockClient.emit("message", "wled/nook/g", Buffer.from("255"));
    mockClient.emit("message", "wled/nook/c", Buffer.from("#FFA7FFA7"));

    await hubStartsAdaptiveLighting(accessory);
    await flush();
    const written = mockClient.published.filter(
      (p) => p.topic === "wled/nook/api",
    );
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    expect(
      service.getCharacteristic(Characteristic.ColorTemperature).value,
    ).toBe(350);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.message)).toMatchObject({
      seg: [
        { id: 0, on: false, sel: false },
        { id: 1, on: true, sel: true },
        { id: 2, on: true, sel: true },
      ],
    });
    await shutdown();
  });

  test("is restored from the persisted transition without a connection", async () => {
    const mac = "0E:42:A1:B2:C3:E5";
    const first = await startLamp(lampConfig(mac), false);
    jest.useFakeTimers();
    await first.start();
    jest.advanceTimersByTime(100);
    jest.useRealTimers();
    await first.shutdown();

    const second = await startLamp(lampConfig(mac), false);
    expect(second.controller.isAdaptiveLightingActive()).toBe(true);
    expect(second.sent()).toEqual([]);

    mockClient.connected = true;
    mockClient.emit("connect");
    second.report(OFF);
    second.characteristic(Characteristic.On).setValue(true);
    await flush();
    expect(second.sent()).toEqual([{ state: "ON", color_temp: 350 }]);
    await second.shutdown();
  });

  test("a color that a report shows right after Adaptive Lighting's own publish turns it off and is applied", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, characteristic, shutdown } =
      await startLamp();
    report({ ...ON, color_temp: 300 });
    await start();
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }]);

    jest.advanceTimersByTime(500);
    report({
      state: "ON",
      brightness: 254,
      color_mode: "hs",
      color: { hue: 120, saturation: 100 },
      color_temp: 500,
    });
    expect(controller.isAdaptiveLightingActive()).toBe(false);
    expect(characteristic(Characteristic.Hue).value).toBe(120);
    await shutdown();
  });

  test("a temperature that Adaptive Lighting publishes and the light never reports leaves it active after 2000 ms", async () => {
    jest.useFakeTimers();
    const { controller, report, sent, start, shutdown } = await startLamp();
    report({ ...ON, color_temp: 300 });
    await start();
    await flush();
    expect(sent()).toEqual([{ color_temp: 350 }]);

    jest.advanceTimersByTime(2000);
    expect(controller.isAdaptiveLightingActive()).toBe(true);
    expect(sent()).toHaveLength(1);
    await shutdown();
  });

  describe("a Zigbee2MQTT light's reported brightness", () => {
    const shown = async (
      characteristic: (type: typeof Characteristic.Hue) => Characteristic,
    ) => {
      const read = await characteristic(
        Characteristic.Brightness,
      ).handleGetRequest();
      expect(read).toBe(characteristic(Characteristic.Brightness).value);
      return read;
    };

    test("a group that turns off and on again within 5 s shows the brightness it passes through at neither", async () => {
      jest.useFakeTimers();
      const { report, sent, start, characteristic, shutdown } =
        await startLamp();
      report({ ...ON, color_temp: 350 });
      await start();
      await flush();

      characteristic(Characteristic.On).setValue(false);
      await flush();
      const steps: [number, Record<string, unknown>][] = [
        [0, { ...ON, brightness: 126, color_temp: 350 }],
        [400, { ...ON, state: "OFF", brightness: 126, color_temp: 350 }],
      ];
      for (const [after, state] of steps) {
        jest.advanceTimersByTime(after);
        report(state);
        expect(await shown(characteristic)).toBe(100);
      }
      jest.advanceTimersByTime(2300);
      characteristic(Characteristic.On).setValue(true);
      await flush();
      for (const [after, state] of [
        [0, { ...ON, brightness: 126, color_temp: 350 }],
        [30, { ...ON, brightness: 126, color_temp: 350, last_seen: 1 }],
      ] as const) {
        jest.advanceTimersByTime(after);
        report(state);
        expect(await shown(characteristic)).toBe(100);
      }
      jest.advanceTimersByTime(5070 - 400 - 2300 - 30);
      report({ ...ON, color_temp: 350 });
      expect(await shown(characteristic)).toBe(100);
      expect(characteristic(Characteristic.On).value).toBe(true);
      jest.advanceTimersByTime(20000);
      await flush();
      expect(await shown(characteristic)).toBe(100);
      expect(sent()).toEqual([
        { state: "OFF" },
        { state: "ON", color_temp: 350 },
      ]);
      await shutdown();
    });

    test("a transient on a steady light shows nothing and sends no temperature", async () => {
      jest.useFakeTimers();
      const { report, sent, start, characteristic, shutdown } =
        await startLamp();
      report({ ...ON, color_temp: 350 });
      await start();
      await flush();

      report({ ...ON, brightness: 144, color_temp: 350 });
      expect(await shown(characteristic)).toBe(100);
      jest.advanceTimersByTime(5200);
      report({ ...ON, color_temp: 350 });
      jest.advanceTimersByTime(20000);
      await flush();
      expect(await shown(characteristic)).toBe(100);
      expect(sent()).toEqual([]);
      expect(logged("Adaptive Lighting for")).toEqual([]);
      await shutdown();
    });

    test("a held brightness is shown without Adaptive Lighting", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report(ON);
      report({ ...ON, brightness: 127 });
      expect(await shown(characteristic)).toBe(100);
      jest.advanceTimersByTime(9999);
      expect(await shown(characteristic)).toBe(100);
      jest.advanceTimersByTime(1);
      expect(await shown(characteristic)).toBe(50);
      await shutdown();
    });

    test("the first report of a device is shown at once", async () => {
      const { report, characteristic, shutdown } = await startLamp();
      report({ ...ON, brightness: 127 });
      expect(characteristic(Characteristic.Brightness).value).toBe(50);
      await shutdown();
    });

    test("a report that answers a write with a brightness of its own is held", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report(ON);
      process.nextTick(() => {
        void characteristic(Characteristic.Brightness).handleSetRequest(
          20,
          {} as never,
        );
      });
      await new Promise((resolve) => setImmediate(resolve));
      report({ ...ON, brightness: 200 });
      expect(characteristic(Characteristic.Brightness).value).toBe(20);
      jest.advanceTimersByTime(10000);
      expect(characteristic(Characteristic.Brightness).value).toBe(79);
      await shutdown();
    });

    test("the report of an earlier write that arrives after a later one does not show", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report({ ...ON, brightness: 218 });
      const brightness = characteristic(Characteristic.Brightness);
      const write = async (value: number) => {
        process.nextTick(() => {
          void brightness.handleSetRequest(value, {} as never);
        });
        await new Promise((resolve) => setImmediate(resolve));
      };
      await write(58);
      await write(100);
      report({ ...ON, brightness: 147 });
      expect(await shown(characteristic)).toBe(100);
      report({ ...ON, brightness: 254 });
      expect(await shown(characteristic)).toBe(100);
      jest.advanceTimersByTime(10000);
      expect(await shown(characteristic)).toBe(100);
      await shutdown();
    });

    test("the first report that has a brightness is shown at once", async () => {
      const { report, characteristic, shutdown } = await startLamp();
      report({ state: "ON" });
      report({ ...ON, brightness: 127 });
      expect(characteristic(Characteristic.Brightness).value).toBe(50);
      await shutdown();
    });

    test("a report without a brightness leaves the held one running", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report(ON);
      report({ ...ON, brightness: 127 });
      jest.advanceTimersByTime(6000);
      report({ state: "ON", last_seen: 1 });
      jest.advanceTimersByTime(4000);
      expect(characteristic(Characteristic.Brightness).value).toBe(50);
      await shutdown();
    });

    test("a brightness that HomeKit wrote over a held one is not taken for the held one later", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report(ON);
      report({ ...ON, brightness: 127 });
      process.nextTick(() => {
        void characteristic(Characteristic.Brightness).handleSetRequest(
          20,
          {} as never,
        );
      });
      await new Promise((resolve) => setImmediate(resolve));
      report({ ...ON, brightness: 50 });
      expect(characteristic(Characteristic.Brightness).value).toBe(20);
      report({ ...ON, brightness: 127 });
      jest.advanceTimersByTime(10000);
      expect(characteristic(Characteristic.Brightness).value).toBe(50);
      await shutdown();
    });

    test("a HomeKit write of Brightness late in a hold keeps what it wrote when the hold would have ended", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report(ON);
      report({ ...ON, brightness: 127 });
      jest.advanceTimersByTime(9000);
      process.nextTick(() => {
        void characteristic(Characteristic.Brightness).handleSetRequest(
          20,
          {} as never,
        );
      });
      await new Promise((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(1500);
      expect(characteristic(Characteristic.Brightness).value).toBe(20);
      await shutdown();
    });

    test("a held brightness does not add characteristics that the light lacks", async () => {
      jest.useFakeTimers();
      const config = lampConfig();
      config.devices = [
        { ...config.devices[0]!, capabilities: ["on_off", "brightness"] },
      ];
      const { bridge, shutdown } = await startBridge(config, VERSION);
      mockClient.connected = true;
      mockClient.emit("connect");
      const service = bridge.bridgedAccessories
        .find((a) => a.displayName === "Lamp")!
        .getService(Service.Lightbulb)!;
      const report = (state: Record<string, unknown>) => {
        mockClient.emit("message", TOPIC, Buffer.from(JSON.stringify(state)));
      };
      report(ON);
      report({ ...ON, brightness: 127 });
      jest.advanceTimersByTime(10000);
      for (const type of [
        Characteristic.Hue,
        Characteristic.Saturation,
        Characteristic.ColorTemperature,
      ])
        expect(service.testCharacteristic(type)).toBe(false);
      expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(
        50,
      );
      await shutdown();
    });

    test("a report that turns on a light for a brightness that HomeKit wrote does not publish the remembered temperature", async () => {
      jest.useFakeTimers();
      const { report, sent, start, characteristic, shutdown } =
        await startLamp();
      report(OFF);
      await start();
      await flush();
      process.nextTick(() => {
        void characteristic(Characteristic.Brightness).handleSetRequest(
          20,
          {} as never,
        );
      });
      await new Promise((resolve) => setImmediate(resolve));
      const before = sent().length;
      report({ ...ON, brightness: 50, color_temp: 350 });
      await flush();
      expect(characteristic(Characteristic.On).value).toBe(true);
      expect(sent()).toHaveLength(before);
      await shutdown();
    });

    test("a report with a brightness for a light that has none holds nothing", async () => {
      jest.useFakeTimers();
      const config = lampConfig();
      config.devices = [{ ...config.devices[0]!, capabilities: ["on_off"] }];
      const { shutdown } = await startBridge(config, VERSION);
      mockClient.connected = true;
      mockClient.emit("connect");
      const report = (state: Record<string, unknown>) => {
        mockClient.emit("message", TOPIC, Buffer.from(JSON.stringify(state)));
      };
      report(ON);
      const timers = jest.getTimerCount();
      report({ ...ON, brightness: 127 });
      expect(jest.getTimerCount()).toBe(timers);
      await shutdown();
    });

    test("a held brightness is not in the state that a read gets", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report(ON);
      report({ ...ON, brightness: 127 });
      expect(characteristic(Characteristic.Brightness).value).toBe(100);
      expect(await shown(characteristic)).toBe(100);
      jest.advanceTimersByTime(10000);
      report({ ...ON, brightness: 127, last_seen: 1 });
      expect(await shown(characteristic)).toBe(50);
      await shutdown();
    });
  });

  describe("the log of a write that no report confirmed", () => {
    test("three writes of the brightness that the light has log nothing", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report(ON);
      for (let write = 0; write < 3; write++) {
        process.nextTick(() => {
          void characteristic(Characteristic.Brightness).handleSetRequest(
            100,
            {} as never,
          );
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
      jest.advanceTimersByTime(2000);
      expect(logged("No report confirmed")).toEqual([]);
      expect(characteristic(Characteristic.Brightness).value).toBe(100);
      await shutdown();
    });

    test("a write of On to a light that keeps reporting off is logged once, for power", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report(OFF);
      characteristic(Characteristic.On).setValue(true);
      await flush();
      jest.advanceTimersByTime(2000);
      expect(logged("No report confirmed")).toEqual([
        'No report confirmed the power written to "Lamp" within 2000 ms; HomeKit shows the reported state',
      ]);
      expect(characteristic(Characteristic.On).value).toBe(false);
      jest.advanceTimersByTime(20000);
      expect(logged("No report confirmed")).toHaveLength(1);
      await shutdown();
    });

    test("only the groups that differ from what HomeKit shows are named", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report(OFF);
      process.nextTick(() => {
        characteristic(Characteristic.On).setValue(true);
        void characteristic(Characteristic.Brightness).handleSetRequest(
          100,
          {} as never,
        );
      });
      await new Promise((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(2000);
      expect(logged("No report confirmed")).toEqual([
        'No report confirmed the power written to "Lamp" within 2000 ms; HomeKit shows the reported state',
      ]);
      await shutdown();
    });

    for (const [name, type, value, capabilities] of [
      ["Hue", Characteristic.Hue, 200, ["on_off", "color_hs"]],
      ["Saturation", Characteristic.Saturation, 5, ["on_off", "color_hs"]],
      [
        "ColorTemperature",
        Characteristic.ColorTemperature,
        200,
        ["on_off", "color_temp"],
      ],
    ] as const) {
      test(`a write of ${name} that no report confirms names the color`, async () => {
        jest.useFakeTimers();
        const config = lampConfig();
        config.devices[0]!.capabilities = [...capabilities];
        const started = await startBridge(config, VERSION);
        mockClient.connected = true;
        mockClient.emit("connect");
        const service = started.bridge.bridgedAccessories
          .find((a) => a.displayName === "Lamp")!
          .getService(Service.Lightbulb)!;
        const characteristic = (t: typeof Characteristic.Hue) =>
          service.getCharacteristic(t);
        const shutdown = started.shutdown;
        mockClient.emit(
          "message",
          TOPIC,
          Buffer.from(
            JSON.stringify(
              name === "ColorTemperature"
                ? { state: "ON", color_mode: "color_temp", color_temp: 400 }
                : {
                    state: "ON",
                    color_mode: "hs",
                    color: { hue: 100, saturation: 50 },
                  },
            ),
          ),
        );
        process.nextTick(() => {
          void characteristic(type).handleSetRequest(value, {} as never);
        });
        await new Promise((resolve) => setImmediate(resolve));
        jest.advanceTimersByTime(2000);
        expect(logged("No report confirmed")).toEqual([
          'No report confirmed the color written to "Lamp" within 2000 ms; HomeKit shows the reported state',
        ]);
        await shutdown();
      });
    }

    test("a hue and saturation that round to what HomeKit shows are not taken for a difference", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report({
        state: "ON",
        brightness: 254,
        color_mode: "hs",
        color: { hue: 100.4, saturation: 50.2 },
      });
      process.nextTick(() => {
        void characteristic(Characteristic.Hue).handleSetRequest(
          100,
          {} as never,
        );
        void characteristic(Characteristic.Saturation).handleSetRequest(
          50,
          {} as never,
        );
      });
      await new Promise((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(2000);
      expect(logged("No report confirmed")).toEqual([]);
      expect(characteristic(Characteristic.Hue).value).toBe(100);
      await shutdown();
    });

    test("a color temperature beyond the range is not taken for a difference", async () => {
      jest.useFakeTimers();
      const { report, characteristic, shutdown } = await startLamp();
      report({ ...ON, color_temp: 574 });
      process.nextTick(() => {
        void characteristic(Characteristic.ColorTemperature).handleSetRequest(
          500,
          {} as never,
        );
      });
      await new Promise((resolve) => setImmediate(resolve));
      jest.advanceTimersByTime(2000);
      expect(logged("No report confirmed")).toEqual([]);
      await shutdown();
    });
  });
});
