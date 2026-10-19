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
  assertMQTTURL,
  credentialOptions,
  withoutErrorMessage,
  type MQTTCredentials,
} from "./config.ts";

export interface TucsonMQTTSource {
  connect: () => number;
  disconnect: () => void;
  subscriptionsReady: (generation: number) => void;
  topics: () => { topic: string; live: boolean }[];
  handle: (
    generation: number,
    topic: string,
    payload: unknown,
    retained: boolean,
  ) => void;
}

export type SourceFactory<S> = (
  publish: (
    topic: string,
    payload: object,
    complete: (error?: Error) => void,
  ) => void,
  options: { changed: () => void; failed: () => void },
) => S;

export interface MqttOptions {
  credentials?: MQTTCredentials | undefined;
  connect?: (url: string, options: IClientOptions) => MqttClient;
  random?: () => number;
  changed?: () => void;
  logger?: Logger;
  received?: (topic: string) => void;
  published?: () => void;
  failed?: () => void;
  defer?: (task: () => void) => void;
}

const CONNECT_TIMEOUT = 10000;
const CLOSE_TIMEOUT = 2000;
const MAX_PAYLOAD = 65536;
export const MIN_BACKOFF = 1000;
export const MAX_BACKOFF = 60000;
const JITTER_FRACTION = 0.25;

export class TucsonMQTT<S extends TucsonMQTTSource> {
  readonly source: S;
  #url: string;
  #credentials: MQTTCredentials | undefined;
  #connect: (url: string, options: IClientOptions) => MqttClient;
  #random: () => number;
  #changed: MqttOptions["changed"];
  #logger: Logger;
  #received: MqttOptions["received"];
  #published: MqttOptions["published"];
  #defer: (task: () => void) => void;
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
    createSource: SourceFactory<S>,
    options: MqttOptions = {},
  ) {
    assertMQTTURL(url);
    this.#url = url;
    this.#credentials = options.credentials;
    this.#connect = options.connect ?? connect;
    this.#random = options.random ?? Math.random;
    this.#changed = options.changed;
    this.#logger = options.logger ?? pino({ name: "tucson-mqtt" });
    this.#received = options.received;
    this.#published = options.published;
    this.#defer = options.defer ?? queueMicrotask;
    this.#failed = options.failed;
    this.source = createSource(
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
    } catch (error: unknown) {
      try {
        this.#settle();
      } catch (observer: unknown) {
        throw new AggregateError(
          [error, observer],
          "Tucson MQTT observer failed while an event was failing",
          { cause: observer },
        );
      }
      throw error;
    }
    this.#settle();
  }

  #settle(): void {
    if (--this.#depth > 0 || !this.#dirty) return;
    this.#dirty = false;
    this.#changed?.();
  }

  #publish(
    topic: string,
    payload: object,
    complete: (error?: Error) => void,
  ): void {
    // The outcome and the publication observer run after the source's
    // dispatch returns, so a throwing observer surfaces on its own and cannot
    // unwind into a write that the source has already settled or sent.
    const finish = (error?: Error): void => {
      this.#defer(() => {
        this.#batch(() => {
          complete(error);
        });
      });
    };
    if (!this.connected || !this.#client) {
      finish(new Error("Tucson MQTT is unavailable"));
      return;
    }
    this.#client.publish(
      topic,
      JSON.stringify(payload),
      { qos: 0, retain: false },
      finish,
    );
    this.#defer(() => {
      this.#published?.();
    });
  }

  #attempt(): void {
    const generation = this.source.connect();
    const client = withoutErrorMessage(() =>
      this.#connect(this.#url, {
        ...(this.#credentials && credentialOptions(this.#credentials)),
        protocolVersion: 5,
        clean: true,
        properties: {
          sessionExpiryInterval: 0,
          maximumPacketSize: MAX_PAYLOAD,
        },
        reconnectPeriod: 0,
        queueQoSZero: false,
        resubscribe: false,
        keepalive: 15,
        connectTimeout: CONNECT_TIMEOUT,
        manualConnect: true,
      }),
    );
    this.#client = client;
    this.#logger.info({ event: "mqtt_connecting" }, "Connecting Tucson MQTT");
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
      let answered = false;
      client.subscribe(subscriptions, (error, granted) => {
        // mqtt.js calls this again with whatever its first call threw, which
        // came from #fail or an observer and propagates.
        if (answered && error) throw error;
        answered = true;
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
        this.#logger.info({ event: "mqtt_ready" }, "Tucson MQTT subscribed");
      });
    });
    client.on("message", (topic, payload, packet) => {
      if (client !== this.#client || !this.#routes.has(topic)) return;
      if (this.#routes.get(topic) && packet.retain) return;
      this.#received?.(topic);
      this.#batch(() => {
        try {
          if (payload.byteLength > MAX_PAYLOAD)
            throw new RangeError("Tucson MQTT payload exceeds its limit");
          const value: unknown = topic.endsWith("/availability")
            ? payload.toString("utf8")
            : JSON.parse(payload.toString("utf8"));
          this.source.handle(generation, topic, value, packet.retain);
        } catch (error: unknown) {
          if (!(error instanceof RangeError || error instanceof SyntaxError))
            throw error;
          // SyntaxError text quotes the payload, so only RangeError's fixed text is logged.
          this.#fail(client, "invalid_tucson_message", {
            topic,
            reason:
              error instanceof RangeError
                ? error.message
                : "Tucson MQTT payload is not valid JSON",
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
    // mqtt.js arms its own connack timer for the same duration inside
    // connect(), and the timer armed first reports the timeout.
    this.#deadline = setTimeout(() => {
      this.#fail(client, "mqtt_connection_timeout");
    }, CONNECT_TIMEOUT);
    this.#deadline.unref();
    try {
      withoutErrorMessage(() => client.connect());
    } catch (error: unknown) {
      clearTimeout(this.#deadline);
      this.#deadline = undefined;
      this.#client = undefined;
      try {
        client.end(true);
      } catch {
        // end() throws when connect() failed before it created a stream.
      }
      throw error;
    }
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
      const delay = this.#backoff * (1 - JITTER_FRACTION * this.#random());
      this.#backoff = Math.min(MAX_BACKOFF, this.#backoff * 2);
      this.#retry = setTimeout(() => {
        this.#retry = undefined;
        this.#attempt();
      }, delay);
      this.#retry.unref();
      this.#logger.error(
        { event, ...details, retry_ms: delay },
        "Tucson MQTT unavailable",
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
    this.#client = undefined;
    this.#ready = false;
    // The client is ended before the observers hear of the disconnect, so an
    // observer that throws cannot leave it open.
    this.#stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Tucson MQTT shutdown timed out"));
      }, CLOSE_TIMEOUT);
      timer.unref();
      client.end(true, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
    try {
      this.source.disconnect();
    } catch (error: unknown) {
      const [closed] = await Promise.allSettled([this.#stopPromise]);
      throw closed.status === "rejected"
        ? new AggregateError(
            [error, closed.reason],
            `Tucson MQTT shutdown failed: ${String(error)}; ${String(closed.reason)}`,
          )
        : error;
    }
    return this.#stopPromise;
  }
}
