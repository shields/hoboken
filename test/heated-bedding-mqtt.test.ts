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

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { EventEmitter } from "node:events";
import { HAPStatus, HapStatusError } from "@homebridge/hap-nodejs";
import type {
  IClientOptions,
  IClientSubscribeOptions,
  MqttClient,
  ISubscriptionGrant,
  IClientPublishOptions,
} from "mqtt";
import pino from "pino";
import { HeatedBeddingMQTT } from "../src/heated-bedding-mqtt.ts";

const ZONE = {
  name: "Bed Side A",
  prefix: "tuya",
  controller: "bed",
  zone: "left",
};
const TOPIC = "tuya/bed/left";
const STATE = {
  session_id: "live",
  power: false,
  heat_level: 4,
  preheat: false,
};

// eslint-disable-next-line unicorn/prefer-event-target -- MQTT exposes EventEmitter callbacks.
class TestMqttClient extends EventEmitter {
  connected = false;
  options: IClientOptions;
  subscriptions: Record<string, IClientSubscribeOptions> | undefined;
  subscribed:
    ((error: Error | null, grants?: ISubscriptionGrant[]) => void) | undefined;
  publications: {
    topic: string;
    message: string;
    options: IClientPublishOptions;
    complete: (error?: Error) => void;
  }[] = [];
  ended = 0;
  finishEnd = true;
  endError: Error | undefined;
  started = false;

  constructor(options: IClientOptions) {
    super();
    this.options = options;
  }

  connect(): this {
    this.started = true;
    return this;
  }

  subscribe(
    topics: Record<string, IClientSubscribeOptions>,
    complete: (error: Error | null, grants?: ISubscriptionGrant[]) => void,
  ): this {
    this.subscriptions = topics;
    this.subscribed = complete;
    return this;
  }

  publish(
    topic: string,
    message: string,
    options: IClientPublishOptions,
    complete: (error?: Error) => void,
  ): this {
    this.publications.push({ topic, message, options, complete });
    return this;
  }

  end(_force: boolean, complete?: (error?: Error) => void): this {
    this.ended++;
    this.connected = false;
    if (this.finishEnd) complete?.(this.endError);
    return this;
  }

  acknowledge(): void {
    this.subscribed!(
      null,
      Object.entries(this.subscriptions!).map(([topic, options]) => ({
        topic,
        ...options,
      })),
    );
  }

  receive(topic: string, value: unknown, retained = false): void {
    this.emit(
      "message",
      topic,
      Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
      { retain: retained },
    );
  }
}

describe("heated bedding MQTT owner", () => {
  let clients: TestMqttClient[];
  let owner: HeatedBeddingMQTT;
  let logs: string[];
  let changed: number;
  let random: number;
  let shutdownError: Error | undefined;
  let onChange: (() => void) | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    clients = [];
    logs = [];
    changed = 0;
    random = 0;
    shutdownError = undefined;
    onChange = undefined;
    owner = new HeatedBeddingMQTT("mqtt://user:secret@localhost", [ZONE], {
      connect: (_url, options) => {
        const client = new TestMqttClient(options);
        clients.push(client);
        return client as unknown as MqttClient;
      },
      random: () => random,
      changed: () => {
        changed++;
        onChange?.();
      },
      logger: pino(
        { base: null },
        {
          write: (text: string) => {
            logs.push(text);
          },
        },
      ),
    });
  });

  afterEach(async () => {
    if (shutdownError) {
      expect(await Promise.allSettled([owner.stop()])).toEqual([
        { status: "rejected", reason: shutdownError },
      ]);
    } else await owner.stop();
    jest.useRealTimers();
  });

  function ready(client = clients.at(-1)!): TestMqttClient {
    client.connected = true;
    client.emit("connect", { sessionPresent: false });
    client.receive("tuya/bridge/availability", "online", true);
    client.receive("tuya/bed/availability", "online", true);
    client.receive(TOPIC, STATE, true);
    client.receive("tuya/bridge/heartbeat", { session_id: "live" });
    client.acknowledge();
    return client;
  }

  test("uses a clean MQTT 5 session, retained snapshots, and live-only subscriptions", () => {
    const client = ready();
    expect(client.started).toBe(true);
    expect(client.options).toMatchObject({
      protocolVersion: 5,
      clean: true,
      reconnectPeriod: 0,
      queueQoSZero: false,
      resubscribe: false,
      keepalive: 15,
      properties: { sessionExpiryInterval: 0 },
    });
    expect(client.subscriptions).toEqual({
      "tuya/bridge/availability": { qos: 1, rh: 0, rap: true },
      "tuya/bridge/heartbeat": { qos: 0, rh: 2, rap: true },
      "tuya/bed/availability": { qos: 1, rh: 0, rap: true },
      [TOPIC]: { qos: 1, rh: 0, rap: true },
      [`${TOPIC}/result`]: { qos: 0, rh: 2, rap: true },
    });
    expect(owner.connected).toBe(true);
    expect(owner.source.getState(TOPIC)).toMatchObject(STATE);
    expect(changed).toBeGreaterThan(0);
  });

  test("publishes QoS 0 commands and waits for result plus reported state", async () => {
    const client = ready();
    const write = owner.source.writePreheat(TOPIC, true);
    const publication = client.publications[0]!;
    expect(publication.topic).toBe(`${TOPIC}/set`);
    expect(publication.options).toEqual({ qos: 0, retain: false });
    const command = JSON.parse(publication.message) as {
      request_id: string;
      preheat: boolean;
    };
    expect(command.preheat).toBe(true);
    publication.complete();
    client.receive(`${TOPIC}/result`, {
      request_id: command.request_id,
      outcome: "confirmed",
    });
    expect(owner.source.pendingCount(TOPIC)).toBe(1);
    client.receive(TOPIC, { ...STATE, preheat: true });
    expect((await write).preheat).toBe(true);
  });

  test("disconnects outstanding writes and creates a fresh client without replay", async () => {
    const client = ready();
    const outcome = Promise.allSettled([
      owner.source.writePreheat(TOPIC, true),
    ]);
    client.emit("close");
    expect(owner.connected).toBe(false);
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
    jest.advanceTimersByTime(1000);
    const restored = ready();
    expect(restored).not.toBe(client);
    expect(restored.publications).toHaveLength(0);
    client.receive(TOPIC, { ...STATE, heat_level: 9 });
    expect(owner.source.getState(TOPIC).heat_level).toBe(4);
  });

  test("retained heartbeats and results cannot make the source live or confirm work", () => {
    const client = clients[0]!;
    client.connected = true;
    client.emit("connect", { sessionPresent: false });
    client.acknowledge();
    client.receive("tuya/bridge/availability", "online", true);
    client.receive("tuya/bed/availability", "online", true);
    client.receive(TOPIC, STATE, true);
    client.receive("tuya/bridge/heartbeat", { session_id: "live" }, true);
    expect(() => owner.source.getState(TOPIC)).toThrow(HapStatusError);
    client.receive(`${TOPIC}/result`, "invalid-json", true);
    client.receive("tuya/bridge/heartbeat", "invalid-json", true);
    expect(owner.connected).toBe(true);
  });

  test("waits for every subscription acknowledgement before accepting a write", async () => {
    const client = clients[0]!;
    client.connected = true;
    client.emit("connect", { sessionPresent: false });
    client.receive("tuya/bridge/availability", "online", true);
    client.receive("tuya/bed/availability", "online", true);
    client.receive(TOPIC, STATE, true);
    client.receive("tuya/bridge/heartbeat", { session_id: "live" });
    expect(owner.connected).toBe(false);
    expect(
      await Promise.allSettled([owner.source.writePreheat(TOPIC, true)]),
    ).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
    expect(client.publications).toHaveLength(0);
    client.acknowledge();
    expect(owner.source.getState(TOPIC)).toMatchObject(STATE);
  });

  test.each(["error", "close", "offline", "disconnect"])(
    "%s retires the connection once and omits opaque error text from logs",
    (event) => {
      const client = ready();
      client.emit(event, new Error("secret mqtt://user:secret@host"));
      client.emit("close");
      client.emit("error", new Error("secret"));
      expect(client.ended).toBe(1);
      expect(owner.connected).toBe(false);
      expect(logs.join(" ")).not.toContain("secret");
      expect(
        logs.some(
          (entry) => (JSON.parse(entry) as { level: number }).level === 50,
        ),
      ).toBe(true);
      jest.advanceTimersByTime(1000);
      expect(clients).toHaveLength(2);
      client.emit("connect", { sessionPresent: false });
      client.receive(TOPIC, STATE);
      client.acknowledge();
      expect(owner.connected).toBe(false);
    },
  );

  test.each([
    { sessionPresent: true },
    { sessionPresent: false, properties: { sessionExpiryInterval: 60 } },
  ])(
    "rejects a broker that resumes a session or overrides expiry: %j",
    (packet) => {
      const client = clients[0]!;
      client.connected = true;
      client.emit("connect", packet);
      expect(client.subscriptions).toBeUndefined();
      expect(client.ended).toBe(1);
      expect(owner.connected).toBe(false);
    },
  );

  test.each([
    "error",
    "absent",
    "missing",
    "duplicate",
    "unexpected",
    "rejected",
    "downgraded",
  ])("%s subscription acknowledgement cannot make the source ready", (kind) => {
    const client = clients[0]!;
    client.connected = true;
    client.emit("connect", { sessionPresent: false });
    const grants: ISubscriptionGrant[] = Object.entries(
      client.subscriptions!,
    ).map(([topic, options]) => ({ topic, ...options }));
    if (kind === "missing") grants.pop();
    if (kind === "duplicate") grants[0] = grants[1]!;
    if (kind === "unexpected")
      grants[0] = { ...grants[0]!, topic: "unconfigured/topic" };
    if (kind === "rejected") grants[0] = { ...grants[0]!, qos: 128 };
    if (kind === "downgraded") grants[0] = { ...grants[0]!, qos: 0 };
    client.subscribed!(
      kind === "error" ? new Error("secret") : null,
      kind === "absent" ? undefined : grants,
    );
    expect(owner.connected).toBe(false);
    expect(client.ended).toBe(1);
    expect(() => owner.source.getState(TOPIC)).toThrow(HapStatusError);
  });

  test.each(["connection", "subscriptions"])(
    "bounds the %s deadline",
    (phase) => {
      const client = clients[0]!;
      if (phase === "subscriptions") {
        client.connected = true;
        client.emit("connect", { sessionPresent: false });
      }
      jest.advanceTimersByTime(10000);
      expect(client.ended).toBe(1);
      expect(owner.connected).toBe(false);
      jest.advanceTimersByTime(1000);
      expect(clients).toHaveLength(2);
      if (phase === "subscriptions") client.acknowledge();
      expect(owner.connected).toBe(false);
    },
  );

  function expectRetry(delay: number): void {
    const attempts = clients.length;
    jest.advanceTimersByTime(delay - 1);
    expect(clients).toHaveLength(attempts);
    jest.advanceTimersByTime(1);
    expect(clients).toHaveLength(attempts + 1);
  }

  test("bounds exponential backoff and resets it only after a minute of readiness", () => {
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      clients.at(-1)!.emit("error", new Error("network"));
      expectRetry(delay);
    }
    ready();
    jest.advanceTimersByTime(59999);
    clients.at(-1)!.emit("close");
    expectRetry(60000);
    clients.at(-1)!.emit("error", new Error("network"));
    expectRetry(60000);
    ready();
    jest.advanceTimersByTime(60000);
    clients.at(-1)!.emit("close");
    expectRetry(1000);
  });

  test("jitter shortens each delay, including at the cap", () => {
    const retryDelay = (): number => {
      clients.at(-1)!.emit("error", new Error("network"));
      const delay = (JSON.parse(logs.at(-1)!) as { retry_ms: number }).retry_ms;
      jest.advanceTimersByTime(delay);
      return delay;
    };
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000])
      expect(retryDelay()).toBe(delay);
    random = 0.4;
    expect(retryDelay()).toBe(54000);
    random = 0.8;
    expect(retryDelay()).toBe(48000);
    random = 1;
    expect(retryDelay()).toBe(45000);
    random = 0;
    expect(retryDelay()).toBe(60000);
  });

  test("an invalid retained snapshot after subscription readiness keeps backing off", () => {
    for (const delay of [1000, 2000, 4000, 8000]) {
      const client = clients.at(-1)!;
      client.connected = true;
      client.emit("connect", { sessionPresent: false });
      client.acknowledge();
      client.receive(TOPIC, { ...STATE, power: "invalid" }, true);
      expectRetry(delay);
    }
  });

  test("retained results cannot confirm an outstanding command", async () => {
    const client = ready();
    const write = owner.source.writePreheat(TOPIC, true);
    const { request_id } = JSON.parse(client.publications[0]!.message) as {
      request_id: string;
    };
    client.receive(TOPIC, { ...STATE, preheat: true });
    client.receive(
      `${TOPIC}/result`,
      { request_id, outcome: "confirmed" },
      true,
    );
    expect(owner.source.pendingCount(TOPIC)).toBe(1);
    client.receive(`${TOPIC}/result`, { request_id, outcome: "confirmed" });
    await write;
  });

  test("publication errors cancel the write and a stale publication callback cannot close a replacement", async () => {
    const client = ready();
    const outcome = Promise.allSettled([
      owner.source.writePreheat(TOPIC, true),
    ]);
    client.publications[0]!.complete(new Error("secret"));
    expect(await outcome).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
    jest.advanceTimersByTime(1000);
    const replacement = ready();
    client.publications[0]!.complete(new Error("late secret"));
    expect(replacement.ended).toBe(0);
    expect(owner.connected).toBe(true);
  });

  test("a disconnected socket cannot buffer a QoS 0 command", async () => {
    const client = ready();
    client.connected = false;
    expect(
      await Promise.allSettled([owner.source.writePreheat(TOPIC, true)]),
    ).toMatchObject([
      {
        status: "rejected",
        reason: { hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE },
      },
    ]);
    expect(client.publications).toHaveLength(0);
    expect(client.ended).toBe(1);
  });

  test.each([
    [TOPIC, "secret invalid JSON"],
    [TOPIC, { ...STATE, power: "secret" }],
    [TOPIC, "secret".repeat(11000)],
    ["tuya/bed/availability", "secret"],
    ["tuya/bridge/heartbeat", { session_id: false, secret: "secret" }],
  ])(
    "invalid data on %s disconnects and clears cached state",
    (topic, value) => {
      const client = ready();
      client.receive(topic, value);
      expect(owner.connected).toBe(false);
      expect(() => owner.source.getState(TOPIC)).toThrow(HapStatusError);
      expect(logs.join(" ")).not.toContain("secret");
      expect(logs.join(" ")).toContain("invalid_heated_bedding_message");
    },
  );

  test.each([
    [{ ...STATE, power: "secret" }, "Invalid heated bedding reported Boolean"],
    ["secret invalid JSON", "Heated bedding MQTT payload is not valid JSON"],
    ["secret".repeat(11000), "Heated bedding MQTT payload exceeds its limit"],
  ])(
    "an invalid message logs its topic and a fixed reason",
    (value, reason) => {
      ready().receive(TOPIC, value);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        event: "invalid_heated_bedding_message",
        topic: TOPIC,
        reason,
      });
      expect(logs.join(" ")).not.toContain("secret");
    },
  );

  test.each([
    ["ECONNREFUSED", "ECONNREFUSED"],
    [5, 5],
    [{ secret: true }, undefined],
  ])("a connection error logs only a scalar code: %j", (code, logged) => {
    clients.at(-1)!.emit("error", Object.assign(new Error("secret"), { code }));
    const entry = JSON.parse(logs.at(-1)!) as Record<string, unknown>;
    expect(entry).toMatchObject({ event: "mqtt_connection_error" });
    expect(entry.code).toBe(logged);
    expect(logs.join(" ")).not.toContain("secret");
  });

  test("ignores messages outside configured routes", () => {
    const client = ready();
    client.receive("unconfigured/topic", "invalid-json");
    expect(owner.connected).toBe(true);
  });

  test("shutdown cancels pending callers and blocks scheduled reconnects", async () => {
    const client = ready();
    const outcomes = Promise.allSettled([
      owner.source.writeFan(TOPIC, { speed: 80 }),
      owner.source.writePreheat(TOPIC, true),
    ]);
    await owner.stop();
    await owner.stop();
    expect((await outcomes).every(({ status }) => status === "rejected")).toBe(
      true,
    );
    jest.advanceTimersByTime(60000);
    expect(client.ended).toBe(1);
    expect(clients).toHaveLength(1);
    expect(owner.connected).toBe(false);
  });

  test("shutdown cancels reconnect while no client is active", async () => {
    clients[0]!.emit("close");
    await owner.stop();
    await owner.stop();
    jest.advanceTimersByTime(60000);
    expect(clients).toHaveLength(1);
  });

  test.each(["disconnect", "retry"])(
    "shutdown requested by a %s observer prevents another connection",
    (phase) => {
      const client = ready();
      const stopOnChange = (): void => {
        onChange = undefined;
        void owner.stop();
      };
      if (phase === "disconnect") onChange = stopOnChange;
      client.emit("close");
      if (phase === "retry") onChange = stopOnChange;
      jest.advanceTimersByTime(60000);
      expect(clients).toHaveLength(1);
      expect(client.ended).toBe(1);
      expect(owner.connected).toBe(false);
    },
  );

  test("shutdown surfaces the MQTT end error", async () => {
    shutdownError = new Error("Injected shutdown failure");
    clients[0]!.endError = shutdownError;
    expect(await Promise.allSettled([owner.stop()])).toEqual([
      { status: "rejected", reason: shutdownError },
    ]);
  });

  test("shutdown has a finite deadline", async () => {
    shutdownError = new Error("Heated bedding MQTT shutdown timed out");
    clients[0]!.finishEnd = false;
    const outcome = Promise.allSettled([owner.stop()]);
    jest.advanceTimersByTime(2000);
    expect(await outcome).toEqual([
      { status: "rejected", reason: shutdownError },
    ]);
  });

  test("unexpected observer errors propagate", async () => {
    await owner.stop();
    let explode = false;
    const error = new Error("Unexpected observer failure");
    owner = new HeatedBeddingMQTT("mqtt://localhost", [ZONE], {
      connect: (_url, options) => {
        const client = new TestMqttClient(options);
        clients.push(client);
        return client as unknown as MqttClient;
      },
      changed: () => {
        if (explode) throw error;
      },
    });
    const client = ready();
    explode = true;
    expect(() => {
      client.receive(TOPIC, STATE);
    }).toThrow(error);
    explode = false;
  });
});

describe("heated bedding MQTT change notifications", () => {
  interface Seen {
    connected: boolean;
    state: unknown;
    pending: number;
    errors: number;
  }

  let clients: TestMqttClient[];
  let owner: HeatedBeddingMQTT;
  let seen: Seen[];
  let errors: number;
  let constructed: boolean;

  beforeEach(() => {
    jest.useFakeTimers();
    clients = [];
    seen = [];
    constructed = false;
    errors = 0;
    owner = new HeatedBeddingMQTT("mqtt://localhost", [ZONE], {
      connect: (_url, options) => {
        const client = new TestMqttClient(options);
        clients.push(client);
        return client as unknown as MqttClient;
      },
      random: () => 0,
      failed: () => {
        errors++;
      },
      changed: () => {
        if (!constructed) return;
        seen.push({
          connected: owner.connected,
          state: owner.source.usableState(TOPIC),
          pending: owner.source.pendingCount(TOPIC),
          errors,
        });
      },
    });
    constructed = true;
  });

  afterEach(async () => {
    await owner.stop();
    jest.useRealTimers();
  });

  function subscribe(): TestMqttClient {
    const client = clients.at(-1)!;
    client.connected = true;
    client.emit("connect", { sessionPresent: false });
    return client;
  }

  function snapshot(client: TestMqttClient): void {
    client.receive("tuya/bridge/availability", "online", true);
    client.receive("tuya/bed/availability", "online", true);
    client.receive(TOPIC, STATE, true);
    client.receive("tuya/bridge/heartbeat", { session_id: "live" });
  }

  function ready(): TestMqttClient {
    const client = subscribe();
    snapshot(client);
    client.acknowledge();
    return client;
  }

  const DOWN = { connected: false, state: undefined, pending: 0, errors: 1 };

  test("a subscription acknowledgement notifies once, with the connection ready", () => {
    const client = subscribe();
    snapshot(client);
    seen.length = 0;
    client.acknowledge();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ connected: true, errors: 0 });
    expect(seen[0]!.state).toMatchObject(STATE);
  });

  test.each(["close", "error", "offline", "disconnect"])(
    "a %s failure notifies once, with the state cleared and the error counted",
    (event) => {
      const client = ready();
      seen.length = 0;
      client.emit(event, new Error("network"));
      expect(seen).toEqual([DOWN]);
    },
  );

  test("a failure with a write outstanding notifies once with the write settled", async () => {
    const client = ready();
    const outcome = Promise.allSettled([
      owner.source.writePreheat(TOPIC, true),
    ]);
    seen.length = 0;
    client.emit("close");
    expect(seen).toEqual([DOWN]);
    expect((await outcome)[0].status).toBe("rejected");
  });

  test("a publication error notifies once, with the connection down", async () => {
    const client = ready();
    const outcome = Promise.allSettled([
      owner.source.writePreheat(TOPIC, true),
    ]);
    seen.length = 0;
    client.publications[0]!.complete(new Error("write failed"));
    expect(seen).toEqual([DOWN]);
    expect((await outcome)[0].status).toBe("rejected");
  });

  test("a successful publication does not notify", () => {
    const client = ready();
    void Promise.allSettled([owner.source.writePreheat(TOPIC, true)]);
    seen.length = 0;
    client.publications[0]!.complete();
    expect(seen).toEqual([]);
  });

  test.each([
    ["invalid JSON", "{"],
    ["an oversize payload", "x".repeat(65537)],
    ["an invalid state", { ...STATE, power: "invalid" }],
  ])("%s notifies once, with the connection down", (_name, payload) => {
    const client = ready();
    seen.length = 0;
    client.receive(TOPIC, payload);
    expect(seen).toEqual([DOWN]);
  });

  test("an invalid availability message notifies once", () => {
    const client = ready();
    seen.length = 0;
    client.receive("tuya/bed/availability", "maybe");
    expect(seen).toEqual([DOWN]);
  });

  test("a valid message notifies once, with the connection still up", () => {
    const client = ready();
    seen.length = 0;
    client.receive(TOPIC, { ...STATE, heat_level: 6 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ connected: true, errors: 0 });
  });

  test("a rejected subscription notifies once", () => {
    const client = subscribe();
    seen.length = 0;
    client.subscribed!(new Error("denied"));
    expect(seen).toEqual([DOWN]);
  });

  test("shutdown notifies once, with the connection down and writes settled", async () => {
    ready();
    const outcome = Promise.allSettled([
      owner.source.writePreheat(TOPIC, true),
    ]);
    seen.length = 0;
    await owner.stop();
    expect(seen).toEqual([{ ...DOWN, errors: 0 }]);
    expect((await outcome)[0].status).toBe("rejected");
  });

  test("shutdown after the connection already failed does not notify", async () => {
    ready().emit("close");
    seen.length = 0;
    await owner.stop();
    expect(seen).toEqual([]);
  });
});
