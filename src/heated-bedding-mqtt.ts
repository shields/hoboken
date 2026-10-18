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
  connect,
  type IClientOptions,
  type ISubscriptionMap,
  type MqttClient,
} from "mqtt";
import pino, { type Logger } from "pino";
import {
  HeatedBeddingSource,
  type HeatedBeddingPublication,
  type HeatedBeddingZoneConfig,
} from "./heated-bedding-source.ts";

interface MqttOptions {
  connect?: (url: string, options: IClientOptions) => MqttClient;
  random?: () => number;
  changed?: () => void;
  logger?: Logger;
  received?: (topic: string) => void;
  published?: () => void;
  failed?: () => void;
}

const CONNECT_TIMEOUT = 10000;
const CLOSE_TIMEOUT = 2000;
const MAX_PAYLOAD = 65536;
const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 60000;

export class HeatedBeddingMQTT {
  readonly source: HeatedBeddingSource;
  #url: string;
  #connect: (url: string, options: IClientOptions) => MqttClient;
  #random: () => number;
  #changed: MqttOptions["changed"];
  #logger: Logger;
  #received: MqttOptions["received"];
  #published: MqttOptions["published"];
  #failed: MqttOptions["failed"];
  #routes: Map<string, boolean>;
  #client: MqttClient | undefined;
  #ready = false;
  #stopped = false;
  #backoff = MIN_BACKOFF;
  #deadline: ReturnType<typeof setTimeout> | undefined;
  #stable: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #stopPromise: Promise<void> | undefined;
  #depth = 0;
  #dirty = false;

  constructor(
    url: string,
    zones: readonly HeatedBeddingZoneConfig[],
    options: MqttOptions = {},
  ) {
    this.#url = url;
    this.#connect = options.connect ?? connect;
    this.#random = options.random ?? Math.random;
    this.#changed = options.changed;
    this.#logger = options.logger ?? pino({ name: "heated-bedding-mqtt" });
    this.#received = options.received;
    this.#published = options.published;
    this.#failed = options.failed;
    this.source = new HeatedBeddingSource(
      zones,
      (topic, payload, complete) => {
        this.#publish(topic, payload, complete);
      },
      {
        changed: () => {
          this.#notify();
        },
        failed: () => {
          if (this.#client) this.#fail(this.#client, "mqtt_publish_failed");
        },
      },
    );
    this.#routes = new Map(
      this.source.topics().map(({ topic, live }) => [topic, live]),
    );
    this.#attempt();
  }

  get connected(): boolean {
    return this.#ready && this.#client?.connected === true;
  }

  // The source notifies before it rejects an invalid message and before the
  // wrapper learns of a publication failure, so a batch holds notifications
  // until the outermost event is done and its state is final.
  #notify(): void {
    if (this.#depth > 0) this.#dirty = true;
    else this.#changed?.();
  }

  #batch(run: () => void): void {
    this.#depth++;
    try {
      run();
    } finally {
      this.#depth--;
    }
    if (this.#depth > 0 || !this.#dirty) return;
    this.#dirty = false;
    this.#changed?.();
  }

  #publish(
    topic: string,
    payload: HeatedBeddingPublication,
    complete: (error?: Error) => void,
  ): void {
    const finish = (error?: Error): void => {
      this.#batch(() => {
        complete(error);
      });
    };
    if (!this.connected || !this.#client) {
      finish(new Error("Heated bedding MQTT is unavailable"));
      return;
    }
    this.#client.publish(
      topic,
      JSON.stringify(payload),
      { qos: 0, retain: false },
      finish,
    );
    this.#published?.();
  }

  #attempt(): void {
    // eslint-disable-next-line unicorn/no-declarations-before-early-exit -- State invalidation can synchronously request shutdown.
    const generation = this.source.connect();
    if (this.#stopped) {
      this.source.disconnect();
      return;
    }
    const client = this.#connect(this.#url, {
      protocolVersion: 5,
      clean: true,
      properties: { sessionExpiryInterval: 0, maximumPacketSize: MAX_PAYLOAD },
      reconnectPeriod: 0,
      queueQoSZero: false,
      resubscribe: false,
      keepalive: 15,
      connectTimeout: CONNECT_TIMEOUT,
      manualConnect: true,
    });
    this.#client = client;
    this.#logger.info(
      { event: "mqtt_connecting" },
      "Connecting heated bedding MQTT",
    );
    client.on("connect", (packet) => {
      if (client !== this.#client) return;
      if (
        packet.sessionPresent ||
        (packet.properties?.sessionExpiryInterval ?? 0) !== 0
      ) {
        this.#fail(client, "mqtt_session_not_clean");
        return;
      }
      clearTimeout(this.#deadline);
      this.#deadline = setTimeout(() => {
        this.#fail(client, "mqtt_subscription_timeout");
      }, CONNECT_TIMEOUT);
      this.#deadline.unref();
      const subscriptions: ISubscriptionMap = Object.fromEntries(
        [...this.#routes].map(([topic, live]) => [
          topic,
          { qos: live ? 0 : 1, rh: live ? 2 : 0, rap: true },
        ]),
      );
      client.subscribe(subscriptions, (error, granted) => {
        if (client !== this.#client) return;
        const topics = new Set(granted?.map(({ topic }) => topic));
        if (
          error ||
          granted?.length !== this.#routes.size ||
          topics.size !== this.#routes.size ||
          granted.some(({ topic, qos }) => qos !== subscriptions[topic]?.qos)
        ) {
          this.#fail(client, "mqtt_subscription_failed");
          return;
        }
        clearTimeout(this.#deadline);
        this.#deadline = undefined;
        this.#ready = true;
        // A fault that recurs after each subscription, such as an invalid
        // retained snapshot, keeps backing off unless the connection
        // outlasts the longest delay.
        this.#stable = setTimeout(() => {
          this.#backoff = MIN_BACKOFF;
        }, MAX_BACKOFF);
        this.#stable.unref();
        this.source.subscriptionsReady(generation);
        this.#logger.info(
          { event: "mqtt_ready" },
          "Heated bedding MQTT subscribed",
        );
      });
    });
    client.on("message", (topic, payload, packet) => {
      if (client !== this.#client || !this.#routes.has(topic)) return;
      if (this.#routes.get(topic) && packet.retain) return;
      this.#received?.(topic);
      this.#batch(() => {
        try {
          if (payload.byteLength > MAX_PAYLOAD)
            throw new RangeError(
              "Heated bedding MQTT payload exceeds its limit",
            );
          const value: unknown = topic.endsWith("/availability")
            ? payload.toString("utf8")
            : JSON.parse(payload.toString("utf8"));
          this.source.handle(generation, topic, value, packet.retain);
        } catch (error: unknown) {
          if (!(error instanceof RangeError || error instanceof SyntaxError))
            throw error;
          // SyntaxError text quotes the payload, so only RangeError's fixed text is logged.
          this.#fail(client, "invalid_heated_bedding_message", {
            topic,
            reason:
              error instanceof RangeError
                ? error.message
                : "Heated bedding MQTT payload is not valid JSON",
          });
        }
      });
    });
    client.on("error", (error) => {
      const { code } = error as { code?: unknown };
      this.#fail(client, "mqtt_connection_error", {
        code:
          typeof code === "string" || typeof code === "number"
            ? code
            : undefined,
      });
    });
    client.on("close", () => {
      this.#fail(client, "mqtt_connection_closed");
    });
    client.on("offline", () => {
      this.#fail(client, "mqtt_connection_offline");
    });
    client.on("disconnect", () => {
      this.#fail(client, "mqtt_server_disconnect");
    });
    this.#deadline = setTimeout(() => {
      this.#fail(client, "mqtt_connection_timeout");
    }, CONNECT_TIMEOUT);
    this.#deadline.unref();
    client.connect();
  }

  #fail(
    client: MqttClient,
    event: string,
    details: Record<string, unknown> = {},
  ): void {
    if (client !== this.#client) return;
    this.#batch(() => {
      this.#client = undefined;
      this.#ready = false;
      clearTimeout(this.#deadline);
      this.#deadline = undefined;
      clearTimeout(this.#stable);
      this.source.disconnect();
      client.end(true);
      const delay = Math.min(
        MAX_BACKOFF,
        this.#backoff * (1 + 0.25 * this.#random()),
      );
      this.#backoff = Math.min(MAX_BACKOFF, this.#backoff * 2);
      this.#retry = setTimeout(() => {
        this.#retry = undefined;
        this.#attempt();
      }, delay);
      this.#retry.unref();
      this.#logger.error(
        { event, ...details, retry_ms: delay },
        "Heated bedding MQTT unavailable",
      );
      this.#failed?.();
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return this.#stopPromise;
    this.#stopped = true;
    clearTimeout(this.#deadline);
    clearTimeout(this.#stable);
    clearTimeout(this.#retry);
    const client = this.#client;
    if (!client) return;
    this.#batch(() => {
      this.#client = undefined;
      this.#ready = false;
      this.source.disconnect();
    });
    this.#stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Heated bedding MQTT shutdown timed out"));
      }, CLOSE_TIMEOUT);
      timer.unref();
      client.end(true, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
    return this.#stopPromise;
  }
}
