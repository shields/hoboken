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
import type { MQTTCredentials } from "../src/config.ts";
import { HeatedBeddingMQTT } from "../src/heated-bedding-mqtt.ts";
import { INVALID_MQTT_URL, MALFORMED_MQTT_URLS, SECRET } from "./mqtt-urls.ts";

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
const PASSWORD = "correct-horse-9f3a";
const CREDENTIALS: MQTTCredentials = {
  username: "tucson-hoboken",
  password: PASSWORD,
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
    // mqtt.js calls the callback again with whatever its first call threw.
    this.subscribed = (error, grants) => {
      try {
        complete(error, grants);
      } catch (thrown: unknown) {
        complete(thrown as Error, grants);
      }
    };
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

// bun:test's toThrow(error) compares only the message, so identity needs the
// caught value itself.
function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected the callback to throw");
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected the promise to reject");
}

describe("heated bedding MQTT owner", () => {
  let clients: TestMqttClient[];
  let owner: HeatedBeddingMQTT;
  let logs: string[];
  let changed: number;
  let random: number;
  let shutdownError: Error | undefined;
  let onChange: (() => void) | undefined;
  let onPublish: (() => void) | undefined;

  function createOwner(
    url: string,
    credentials?: MQTTCredentials,
  ): HeatedBeddingMQTT {
    return new HeatedBeddingMQTT(url, [ZONE], {
      credentials,
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
      published: () => {
        onPublish?.();
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
  }

  beforeEach(() => {
    jest.useFakeTimers();
    clients = [];
    logs = [];
    changed = 0;
    random = 0;
    shutdownError = undefined;
    onChange = undefined;
    onPublish = undefined;
    owner = createOwner("mqtt://user:secret@localhost");
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

  test("adds no login options unless credentials are configured, leaving URL userinfo to mqtt.js", () => {
    expect(clients).toHaveLength(1);
    for (const key of ["username", "password", "auth"])
      expect(key in clients[0]!.options).toBe(false);
  });

  test("authenticates every connection attempt", async () => {
    await owner.stop();
    const first = clients.length;
    owner = createOwner("mqtt://localhost", CREDENTIALS);
    const failures: [string, unknown?][] = [
      ["close"],
      [
        "error",
        Object.assign(new Error("Connection refused: Not authorized"), {
          code: 135,
        }),
      ],
      ["offline"],
      ["disconnect"],
      ["error", new Error("failure")],
    ];
    for (const [event, error] of failures) {
      clients.at(-1)!.emit(event, error);
      jest.advanceTimersToNextTimer();
    }
    expect(clients).toHaveLength(first + failures.length + 1);
    for (const client of clients.slice(first)) {
      expect(client.options).toMatchObject({
        ...CREDENTIALS,
        auth: "",
        protocolVersion: 5,
      });
    }
  });

  test("never logs the password", async () => {
    await owner.stop();
    owner = createOwner("mqtt://localhost", CREDENTIALS);
    expect(clients.at(-1)!.options.password).toBe(PASSWORD);
    const failures: [string, unknown][] = [
      ["error", new Error(PASSWORD)],
      ["close", new Error(PASSWORD)],
      ["offline", new Error(PASSWORD)],
      ["disconnect", new Error(PASSWORD)],
      ["error", Object.assign(new Error("Connection refused"), { code: 135 })],
    ];
    for (const [event, error] of failures) {
      ready().emit(event, error);
      jest.advanceTimersToNextTimer();
    }
    ready().receive(TOPIC, `not JSON ${PASSWORD}`);
    jest.advanceTimersToNextTimer();
    ready();
    await owner.stop();
    const output = logs.join(" ");
    expect(output).toContain("mqtt_connection_error");
    expect(output).toContain('"code":135');
    expect(output).toContain("mqtt_ready");
    expect(output).not.toContain(PASSWORD);
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
    for (const [jitter, delay] of [
      [1, 750],
      [0.5, 1750],
      [0.25, 3750],
      [0.75, 6500],
      [1, 12000],
      [0.5, 28000],
      [0.4, 54000],
      [0.8, 48000],
      [1, 45000],
      [0, 60000],
    ] as const) {
      random = jitter;
      clients.at(-1)!.emit("error", new Error("network"));
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ retry_ms: delay });
      expectRetry(delay);
    }
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

  test("a publication observer that stops the owner fails the write as unavailable", async () => {
    ready();
    onPublish = () => {
      onPublish = undefined;
      void owner.stop();
    };
    expect(
      await rejectionOf(owner.source.writePreheat(TOPIC, true)),
    ).toMatchObject({ hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE });
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
      expect(logs.join(" ")).toContain("invalid_tucson_message");
    },
  );

  test.each([
    [{ ...STATE, power: "secret" }, "Invalid heated bedding reported Boolean"],
    ["secret invalid JSON", "Tucson MQTT payload is not valid JSON"],
    ["secret".repeat(11000), "Tucson MQTT payload exceeds its limit"],
  ])(
    "an invalid message logs its topic and a fixed reason",
    (value, reason) => {
      ready().receive(TOPIC, value);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        event: "invalid_tucson_message",
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

  test("shutdown requested by a disconnect observer prevents another connection", () => {
    const client = ready();
    onChange = () => {
      onChange = undefined;
      void owner.stop();
    };
    client.emit("close");
    jest.advanceTimersByTime(60000);
    expect(clients).toHaveLength(1);
    expect(client.ended).toBe(1);
    expect(owner.connected).toBe(false);
  });

  test("shutdown surfaces the MQTT end error", async () => {
    shutdownError = new Error("Injected shutdown failure");
    clients[0]!.endError = shutdownError;
    expect(await Promise.allSettled([owner.stop()])).toEqual([
      { status: "rejected", reason: shutdownError },
    ]);
  });

  test("shutdown ends the client even when an observer throws", async () => {
    const client = ready();
    const error = new Error("Unexpected observer failure");
    onChange = () => {
      onChange = undefined;
      throw error;
    };
    expect(await Promise.allSettled([owner.stop()])).toEqual([
      { status: "rejected", reason: error },
    ]);
    expect(client.ended).toBe(1);
  });

  test("shutdown reports a close failure together with an observer failure", async () => {
    shutdownError = new Error("Injected shutdown failure");
    const client = ready();
    client.endError = shutdownError;
    const error = new Error("Unexpected observer failure");
    onChange = () => {
      onChange = undefined;
      throw error;
    };
    const failure = await rejectionOf(owner.stop());
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(error);
    expect((failure as AggregateError).errors[1]).toBe(shutdownError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).message).toContain(error.message);
    expect((failure as AggregateError).message).toContain(
      shutdownError.message,
    );
    expect(client.ended).toBe(1);
  });

  test("shutdown has a finite deadline", async () => {
    shutdownError = new Error("Tucson MQTT shutdown timed out");
    clients[0]!.finishEnd = false;
    const outcome = Promise.allSettled([owner.stop()]);
    jest.advanceTimersByTime(2000);
    expect(await outcome).toEqual([
      { status: "rejected", reason: shutdownError },
    ]);
  });

  test("an observer error propagates and leaves no notification pending", () => {
    const client = ready();
    const error = new Error("Unexpected observer failure");
    onChange = () => {
      onChange = undefined;
      throw error;
    };
    changed = 0;
    expect(
      thrownBy(() => {
        client.receive(TOPIC, STATE);
      }),
    ).toBe(error);
    expect(changed).toBe(1);
    changed = 0;
    client.receive(`${TOPIC}/result`, {
      request_id: "unknown",
      outcome: "confirmed",
    });
    expect(changed).toBe(0);
  });

  test("an unexpected error decoding a message propagates without failing the connection", () => {
    const client = ready();
    const error = new TypeError("Unexpected decode failure");
    const payload = {
      byteLength: 1,
      toString: () => {
        throw error;
      },
    };
    expect(
      thrownBy(() => {
        client.emit("message", TOPIC, payload, { retain: false });
      }),
    ).toBe(error);
    expect(owner.connected).toBe(true);
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
  let failure: Error | undefined;
  let observerFailure: Error | undefined;
  let publishFailure: Error | undefined;
  let tasks: (() => void)[];

  beforeEach(() => {
    jest.useFakeTimers();
    clients = [];
    seen = [];
    errors = 0;
    failure = undefined;
    observerFailure = undefined;
    publishFailure = undefined;
    tasks = [];
    owner = new HeatedBeddingMQTT("mqtt://localhost", [ZONE], {
      connect: (_url, options) => {
        const client = new TestMqttClient(options);
        clients.push(client);
        return client as unknown as MqttClient;
      },
      random: () => 0,
      logger: pino({ level: "silent" }),
      defer: (task) => {
        tasks.push(task);
      },
      published: () => {
        if (publishFailure) throw publishFailure;
      },
      failed: () => {
        errors++;
        if (failure) throw failure;
      },
      changed: () => {
        seen.push({
          connected: owner.connected,
          state: owner.source.usableState(TOPIC),
          pending: owner.source.pendingCount(TOPIC),
          errors,
        });
        if (observerFailure) throw observerFailure;
      },
    });
  });

  afterEach(async () => {
    failure = undefined;
    observerFailure = undefined;
    publishFailure = undefined;
    await owner.stop();
    jest.useRealTimers();
  });

  function flush(): void {
    while (tasks.length > 0) tasks.shift()!();
  }

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
    flush();
    expect(seen).toEqual([DOWN]);
    expect((await outcome)[0].status).toBe("rejected");
  });

  test("a successful publication does not notify", () => {
    const client = ready();
    void Promise.allSettled([owner.source.writePreheat(TOPIC, true)]);
    seen.length = 0;
    client.publications[0]!.complete();
    flush();
    expect(seen).toEqual([]);
  });

  test("a throwing publication observer surfaces without affecting the sent write", async () => {
    const client = ready();
    publishFailure = new Error("Unexpected metrics failure");
    const write = owner.source.writePreheat(TOPIC, true);
    expect(client.publications).toHaveLength(1);
    expect(thrownBy(flush)).toBe(publishFailure);
    const { request_id } = JSON.parse(client.publications[0]!.message) as {
      request_id: string;
    };
    client.receive(TOPIC, { ...STATE, preheat: true });
    client.receive(`${TOPIC}/result`, { request_id, outcome: "confirmed" });
    expect(await write).toMatchObject({ preheat: true });
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

  test("shutdown after the connection already failed cancels the retry without notifying", async () => {
    ready().emit("close");
    seen.length = 0;
    await owner.stop();
    jest.advanceTimersByTime(60000);
    expect(clients).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  test("construction and a retry attempt do not notify", () => {
    expect(seen).toEqual([]);
    ready().emit("close");
    seen.length = 0;
    jest.advanceTimersByTime(1000);
    expect(clients).toHaveLength(2);
    expect(seen).toEqual([]);
  });

  test("a write on a socket that is down notifies once, with the error counted", async () => {
    const client = ready();
    client.connected = false;
    seen.length = 0;
    const outcome = Promise.allSettled([
      owner.source.writePreheat(TOPIC, true),
    ]);
    flush();
    expect(seen).toEqual([DOWN]);
    expect((await outcome)[0].status).toBe("rejected");
  });

  test("a failure still notifies once when the failure callback throws", () => {
    const client = ready();
    failure = new Error("Unexpected metrics failure");
    seen.length = 0;
    expect(
      thrownBy(() => {
        client.emit("close");
      }),
    ).toBe(failure);
    expect(seen).toEqual([DOWN]);
    failure = undefined;
    jest.advanceTimersByTime(1000);
    expect(clients).toHaveLength(2);
    const replacement = ready();
    seen.length = 0;
    replacement.receive(`${TOPIC}/result`, {
      request_id: "unknown",
      outcome: "confirmed",
    });
    expect(seen).toEqual([]);
  });

  test("a failure callback and an observer that both throw are both reported", () => {
    const client = ready();
    failure = new Error("Unexpected metrics failure");
    observerFailure = new Error("Unexpected observer failure");
    const error = thrownBy(() => {
      client.emit("close");
    });
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBe(failure);
    expect((error as AggregateError).errors[1]).toBe(observerFailure);
    expect((error as AggregateError).errors).toHaveLength(2);
  });

  test("an observer error on subscription readiness propagates without failing the connection", () => {
    const client = subscribe();
    snapshot(client);
    observerFailure = new Error("Unexpected observer failure");
    expect(
      thrownBy(() => {
        client.acknowledge();
      }),
    ).toBe(observerFailure);
    observerFailure = undefined;
    expect(owner.connected).toBe(true);
    expect(errors).toBe(0);
  });

  test("an observer error while failing a subscription propagates", () => {
    const client = subscribe();
    failure = new Error("Unexpected metrics failure");
    expect(
      thrownBy(() => {
        client.subscribed!(new Error("denied"));
      }),
    ).toBe(failure);
  });

  test("a preheat write on a socket that is down fails as unavailable and surfaces a throwing failure callback", async () => {
    const client = ready();
    client.connected = false;
    failure = new Error("Unexpected metrics failure");
    const outcome = rejectionOf(owner.source.writePreheat(TOPIC, true));
    expect(thrownBy(flush)).toBe(failure);
    expect(await outcome).toMatchObject({
      hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    });
    expect(owner.source.pendingCount(TOPIC)).toBe(0);
  });

  test("a fan write on a socket that is down fails as unavailable and surfaces a throwing failure callback", async () => {
    const client = ready();
    const outcome = rejectionOf(owner.source.writeFan(TOPIC, { speed: 50 }));
    client.connected = false;
    failure = new Error("Unexpected metrics failure");
    jest.advanceTimersByTime(50);
    expect(thrownBy(flush)).toBe(failure);
    expect(await outcome).toMatchObject({
      hapStatus: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    });
    expect(owner.source.pendingCount(TOPIC)).toBe(0);
  });
});

describe("heated bedding MQTT owner with an mqtt.url that is not well formed", () => {
  const QUOTING_ERROR_MESSAGE = `The argument 'url' mqtt://user:${SECRET}@localhost:1x. Received 'Invalid port in url'`;
  const REDACTED_MESSAGE = "MQTT client could not be started";
  let clients: TestMqttClient[];
  let owner: HeatedBeddingMQTT | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    clients = [];
    owner = undefined;
  });

  afterEach(async () => {
    await owner?.stop();
    jest.useRealTimers();
  });

  function failure(create: () => unknown): Error & { code?: unknown } {
    try {
      create();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the call to throw");
  }

  function createOwner(
    url: string,
    connect: (options: IClientOptions) => MqttClient,
  ): HeatedBeddingMQTT {
    return new HeatedBeddingMQTT(url, [ZONE], {
      connect: (_url, options) => connect(options),
    });
  }

  function recordingClient(options: IClientOptions): MqttClient {
    const client = new TestMqttClient(options);
    clients.push(client);
    return client as unknown as MqttClient;
  }

  test.each(MALFORMED_MQTT_URLS)(
    "refuses %j without connecting or quoting it",
    (url) => {
      expect(
        failure(() => {
          owner = createOwner(url, recordingClient);
        }),
      ).toStrictEqual(new Error(INVALID_MQTT_URL));
      expect(clients).toHaveLength(0);
    },
  );

  test.each([
    [
      "creating the client",
      (options: IClientOptions) => {
        recordingClient(options);
        throw Object.assign(new Error(QUOTING_ERROR_MESSAGE), {
          code: "ERR_INVALID_ARG_VALUE",
        });
      },
    ],
    [
      "connecting the client",
      (options: IClientOptions) => {
        const client = new TestMqttClient(options);
        client.connect = () => {
          throw Object.assign(new Error(QUOTING_ERROR_MESSAGE), {
            code: "ERR_INVALID_ARG_VALUE",
          });
        };
        return client as unknown as MqttClient;
      },
    ],
  ])(
    "rethrows an error from %s without its message and leaves no timer",
    (_step, connect) => {
      const error = failure(() => {
        owner = createOwner("mqtt://localhost", connect);
      });
      expect(error.message).toBe(REDACTED_MESSAGE);
      expect(error.code).toBe("ERR_INVALID_ARG_VALUE");
      expect(error.stack).not.toContain(SECRET);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
