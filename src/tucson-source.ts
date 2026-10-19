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

import { randomUUID } from "node:crypto";
import { HAPStatus, HapStatusError } from "@homebridge/hap-nodejs";
import {
  parseTucsonHeartbeat,
  parseTucsonResult,
  tucsonTopic,
} from "./tucson-profile.ts";

export interface TucsonEndpointConfig {
  name: string;
  prefix: string;
  controller: string;
  zone?: string;
}

export type TucsonPublish<C extends object> = (
  topic: string,
  payload: C & { request_id: string },
  complete: (error?: Error) => void,
) => void;

export interface TucsonProfile<S, C> {
  parse: (value: unknown) => S | undefined;
  matches: (command: C, state: S) => boolean;
}

// How a window of writes that only asks an endpoint to resume interacts with
// its power.
export interface TucsonResume<S, C, W> {
  only: (writes: readonly W[]) => boolean;
  powered: (state: S) => boolean;
  power: (command: C) => boolean | undefined;
}

interface Prefix<S, W> {
  online: boolean;
  session: string | undefined;
  heartbeat: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  endpoints: Endpoint<S, W>[];
}

interface Controller<S, W> {
  online: boolean;
  endpoints: Endpoint<S, W>[];
}

interface Waiter<S> {
  resolve: (state: S) => void;
  reject: (error: unknown) => void;
}

interface WriteWindow<S, W> {
  writes: W[];
  waiters: Waiter<S>[];
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Endpoint<S, W> {
  topic: string;
  prefix: Prefix<S, W>;
  controller: Controller<S, W>;
  state: S | undefined;
  window: WriteWindow<S, W> | undefined;
  callers: number;
  published: number;
}

interface Pending<S, C, W> {
  endpoint: Endpoint<S, W>;
  command: C;
  sequence: number;
  session: string;
  deadline: number;
  confirmed: boolean;
  waiters: Waiter<S>[];
  timer: ReturnType<typeof setTimeout>;
}

type Route<S, W> =
  | { kind: "bridge" | "heartbeat"; prefix: Prefix<S, W> }
  | { kind: "controller"; controller: Controller<S, W> }
  | { kind: "state" | "result"; endpoint: Endpoint<S, W> };

export interface SourceOptions {
  clock?: () => number;
  identifier?: () => string;
  changed?: () => void;
  failed?: () => void;
}

const HEARTBEAT_TIMEOUT = 45000;
const WRITE_TIMEOUT = 8500;
const COALESCE_DELAY = 50;
const MAX_CALLERS = 32;

export class TucsonSource<
  S extends { session_id: string },
  C extends object,
  W = never,
> {
  #profile: TucsonProfile<S, C>;
  #endpoints = new Map<string, Endpoint<S, W>>();
  #prefixes = new Map<string, Prefix<S, W>>();
  #controllers = new Map<string, Controller<S, W>>();
  #routes = new Map<string, Route<S, W>>();
  #pending = new Map<string, Pending<S, C, W>>();
  #clock: () => number;
  #identifier: () => string;
  #publish: TucsonPublish<C>;
  #changed: SourceOptions["changed"];
  #failed: SourceOptions["failed"];
  #generation = 0;
  #connected = false;
  #subscribed = false;

  constructor(
    configs: readonly TucsonEndpointConfig[],
    publish: TucsonPublish<C>,
    profile: TucsonProfile<S, C>,
    options: SourceOptions = {},
  ) {
    this.#publish = publish;
    this.#profile = profile;
    this.#clock = options.clock ?? performance.now.bind(performance);
    this.#identifier = options.identifier ?? randomUUID;
    this.#changed = options.changed;
    this.#failed = options.failed;
    for (const config of configs) {
      let prefix = this.#prefixes.get(config.prefix);
      if (!prefix) {
        prefix = {
          online: false,
          session: undefined,
          heartbeat: undefined,
          timer: undefined,
          endpoints: [],
        };
        this.#prefixes.set(config.prefix, prefix);
        this.#route(`${config.prefix}/bridge/availability`, {
          kind: "bridge",
          prefix,
        });
        this.#route(`${config.prefix}/bridge/heartbeat`, {
          kind: "heartbeat",
          prefix,
        });
      }
      const controllerTopic = `${config.prefix}/${config.controller}`;
      let controller = this.#controllers.get(controllerTopic);
      if (!controller) {
        controller = { online: false, endpoints: [] };
        this.#controllers.set(controllerTopic, controller);
        this.#route(`${controllerTopic}/availability`, {
          kind: "controller",
          controller,
        });
      }
      const topic = tucsonTopic(config);
      const endpoint: Endpoint<S, W> = {
        topic,
        prefix,
        controller,
        state: undefined,
        window: undefined,
        callers: 0,
        published: 0,
      };
      this.#route(topic, { kind: "state", endpoint });
      this.#route(`${topic}/result`, { kind: "result", endpoint });
      this.#endpoints.set(topic, endpoint);
      prefix.endpoints.push(endpoint);
      controller.endpoints.push(endpoint);
    }
  }

  #route(topic: string, route: Route<S, W>): void {
    if (this.#routes.has(topic))
      throw new RangeError(`Duplicate Tucson MQTT topic "${topic}"`);
    this.#routes.set(topic, route);
  }

  #endpoint(topic: string): Endpoint<S, W> {
    const endpoint = this.#endpoints.get(topic);
    if (!endpoint) throw new RangeError("Unknown Tucson endpoint");
    return endpoint;
  }

  connect(): number {
    this.disconnect();
    this.#connected = true;
    return this.#generation;
  }

  subscriptionsReady(generation: number): void {
    if (!this.#connected || generation !== this.#generation) return;
    this.#subscribed = true;
    this.#changed?.();
  }

  disconnect(): void {
    const connected = this.#connected;
    this.#generation++;
    this.#connected = false;
    this.#subscribed = false;
    for (const prefix of this.#prefixes.values()) {
      clearTimeout(prefix.timer);
      prefix.timer = undefined;
      prefix.online = false;
      prefix.session = undefined;
      prefix.heartbeat = undefined;
    }
    for (const controller of this.#controllers.values())
      controller.online = false;
    for (const endpoint of this.#endpoints.values()) {
      endpoint.state = undefined;
      this.#cancel(endpoint);
    }
    // TucsonMQTT connects only a disconnected source and relies on
    // connect() staying silent, so no observer can stop it before it has a
    // client.
    if (connected) this.#changed?.();
  }

  topics(): { topic: string; live: boolean }[] {
    return [...this.#routes].map(([topic, route]) => ({
      topic,
      live: route.kind === "heartbeat" || route.kind === "result",
    }));
  }

  usableState(topic: string): S | undefined {
    const endpoint = this.#endpoint(topic);
    const state = endpoint.state;
    return !this.#connected ||
      !this.#subscribed ||
      !endpoint.prefix.online ||
      !endpoint.controller.online ||
      endpoint.prefix.heartbeat === undefined ||
      this.#clock() - endpoint.prefix.heartbeat >= HEARTBEAT_TIMEOUT ||
      !state ||
      state.session_id !== endpoint.prefix.session
      ? undefined
      : state;
  }

  getState(topic: string): S {
    const state = this.usableState(topic);
    if (!state)
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    return state;
  }

  pendingCount(topic: string): number {
    return this.#endpoint(topic).callers;
  }

  handle(
    generation: number,
    topic: string,
    payload: unknown,
    retained: boolean,
  ): void {
    if (!this.#connected || generation !== this.#generation) return;
    const route = this.#routes.get(topic);
    if (!route) return;
    switch (route.kind) {
      case "bridge": {
        route.prefix.online = payload === "online";
        if (!route.prefix.online) {
          clearTimeout(route.prefix.timer);
          route.prefix.heartbeat = undefined;
          for (const endpoint of route.prefix.endpoints) this.#cancel(endpoint);
        }
        this.#changed?.();
        if (payload !== "online" && payload !== "offline")
          throw new RangeError("Invalid Tucson bridge availability");
        break;
      }
      case "controller": {
        route.controller.online = payload === "online";
        if (!route.controller.online) {
          for (const endpoint of route.controller.endpoints)
            this.#cancel(endpoint);
        }
        this.#changed?.();
        if (payload !== "online" && payload !== "offline")
          throw new RangeError("Invalid Tucson controller availability");
        break;
      }
      case "heartbeat": {
        if (retained) return;
        const session = parseTucsonHeartbeat(payload);
        if (session !== route.prefix.session) {
          for (const endpoint of route.prefix.endpoints) this.#cancel(endpoint);
        }
        route.prefix.session = session;
        route.prefix.heartbeat = this.#clock();
        clearTimeout(route.prefix.timer);
        route.prefix.timer = setTimeout(() => {
          route.prefix.heartbeat = undefined;
          for (const endpoint of route.prefix.endpoints) this.#cancel(endpoint);
          this.#changed?.();
        }, HEARTBEAT_TIMEOUT);
        route.prefix.timer.unref();
        this.#changed?.();
        break;
      }
      case "state": {
        route.endpoint.state = undefined;
        try {
          route.endpoint.state = this.#profile.parse(payload);
        } catch (error: unknown) {
          this.#cancel(route.endpoint);
          this.#changed?.();
          throw error;
        }
        for (const [id, pending] of this.#pending) {
          if (pending.endpoint === route.endpoint) this.#confirm(id, pending);
        }
        this.#changed?.();
        break;
      }
      case "result": {
        if (retained) return;
        const result = parseTucsonResult(payload);
        const pending = this.#pending.get(result.request_id);
        if (pending?.endpoint !== route.endpoint) return;
        if (result.outcome === "confirmed") {
          pending.confirmed = true;
          this.#confirm(result.request_id, pending);
        } else {
          const status =
            result.error_code === "invalid_command"
              ? HAPStatus.INVALID_VALUE_IN_REQUEST
              : result.error_code === "queue_full"
                ? HAPStatus.RESOURCE_BUSY
                : result.error_code === "expired" ||
                    result.error_code === "confirmation_timeout"
                  ? HAPStatus.OPERATION_TIMED_OUT
                  : HAPStatus.SERVICE_COMMUNICATION_FAILURE;
          this.#finish(result.request_id, pending, new HapStatusError(status));
        }
        break;
      }
    }
  }

  #admit(topic: string): Endpoint<S, W> {
    this.getState(topic);
    const endpoint = this.#endpoint(topic);
    if (endpoint.callers >= MAX_CALLERS)
      throw new HapStatusError(HAPStatus.RESOURCE_BUSY);
    endpoint.callers++;
    return endpoint;
  }

  protected async writeCoalesced(
    topic: string,
    write: W,
    coalesce: (writes: readonly W[]) => C,
    resume?: TucsonResume<S, C, W>,
  ): Promise<S> {
    const endpoint = this.#admit(topic);
    return new Promise((resolve, reject) => {
      const waiter: Waiter<S> = { resolve, reject };
      if (endpoint.window) {
        endpoint.window.writes.push(write);
        endpoint.window.waiters.push(waiter);
      } else {
        const window: WriteWindow<S, W> = {
          writes: [write],
          waiters: [waiter],
          deadline: this.#clock() + WRITE_TIMEOUT,
          timer: setTimeout(() => {
            endpoint.window = undefined;
            this.#send(
              endpoint,
              coalesce(window.writes),
              window.waiters,
              window.deadline,
              resume?.only(window.writes) ? resume : undefined,
            );
          }, COALESCE_DELAY),
        };
        window.timer.unref();
        endpoint.window = window;
      }
    });
  }

  protected async writeCommand(topic: string, command: C): Promise<S> {
    const endpoint = this.#admit(topic);
    return new Promise((resolve, reject) => {
      this.#send(
        endpoint,
        command,
        [{ resolve, reject }],
        this.#clock() + WRITE_TIMEOUT,
      );
    });
  }

  #send(
    endpoint: Endpoint<S, W>,
    command: C,
    waiters: Waiter<S>[],
    deadline: number,
    resume?: TucsonResume<S, C, W>,
  ): void {
    try {
      this.#dispatch(endpoint, command, waiters, deadline, resume);
    } catch (error: unknown) {
      this.#reject(endpoint, waiters, error);
    }
  }

  #dispatch(
    endpoint: Endpoint<S, W>,
    command: C,
    waiters: Waiter<S>[],
    deadline: number,
    resume: TucsonResume<S, C, W> | undefined,
  ): void {
    if (this.#clock() >= deadline) {
      this.#reject(
        endpoint,
        waiters,
        new HapStatusError(HAPStatus.OPERATION_TIMED_OUT),
      );
      return;
    }
    const state = this.usableState(endpoint.topic);
    if (!state) {
      this.#reject(
        endpoint,
        waiters,
        new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
      );
      return;
    }
    if (resume) {
      // Reported power lags a power write that is still in flight, so the
      // latest such write decides.
      let inFlight: Pending<S, C, W> | undefined;
      for (const pending of this.#pending.values()) {
        if (
          pending.endpoint === endpoint &&
          resume.power(pending.command) !== undefined
        )
          inFlight = pending;
      }
      if (inFlight ? resume.power(inFlight.command) : resume.powered(state)) {
        if (inFlight) inFlight.waiters.push(...waiters);
        else this.#resolve(endpoint, waiters, state);
        return;
      }
    }
    const id = this.#identifier();
    if (this.#pending.has(id)) {
      throw new Error("Duplicate generated Tucson request ID");
    }
    const pending: Pending<S, C, W> = {
      endpoint,
      command,
      sequence: endpoint.published + 1,
      waiters,
      deadline,
      session: state.session_id,
      confirmed: false,
      timer: setTimeout(() => {
        this.#finish(
          id,
          pending,
          new HapStatusError(HAPStatus.OPERATION_TIMED_OUT),
        );
      }, deadline - this.#clock()),
    };
    pending.timer.unref();
    this.#pending.set(id, pending);
    const generation = this.#generation;
    try {
      this.#publish(
        `${endpoint.topic}/set`,
        { ...command, request_id: id },
        (error) => {
          if (!(error && generation === this.#generation)) {
            return;
          }

          this.disconnect();
          this.#failed?.();
        },
      );
    } catch (error: unknown) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      throw error;
    }
    endpoint.published = pending.sequence;
  }

  #confirm(id: string, pending: Pending<S, C, W>): void {
    if (this.#clock() >= pending.deadline) {
      this.#finish(
        id,
        pending,
        new HapStatusError(HAPStatus.OPERATION_TIMED_OUT),
      );
      return;
    }
    if (!pending.confirmed) return;
    const state = this.usableState(pending.endpoint.topic);
    if (!state) {
      this.#finish(
        id,
        pending,
        new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
      );
      return;
    }
    // A newer write to this endpoint, or a firmware side effect of one such as
    // preheat's level 10, can replace this write's values before its
    // confirmed result arrives.
    if (
      state.session_id !== pending.session ||
      (pending.sequence === pending.endpoint.published &&
        !this.#profile.matches(pending.command, state))
    )
      return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    this.#resolve(pending.endpoint, pending.waiters, state);
  }

  #resolve(endpoint: Endpoint<S, W>, waiters: Waiter<S>[], state: S): void {
    endpoint.callers -= waiters.length;
    for (const waiter of waiters) waiter.resolve(state);
  }

  #reject(
    endpoint: Endpoint<S, W>,
    waiters: Waiter<S>[],
    error: unknown,
  ): void {
    endpoint.callers -= waiters.length;
    for (const waiter of waiters) waiter.reject(error);
  }

  #finish(id: string, pending: Pending<S, C, W>, error: HapStatusError): void {
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    this.#reject(pending.endpoint, pending.waiters, error);
  }

  #cancel(endpoint: Endpoint<S, W>): void {
    if (endpoint.window) {
      clearTimeout(endpoint.window.timer);
      this.#reject(
        endpoint,
        endpoint.window.waiters,
        new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
      );
      endpoint.window = undefined;
    }
    for (const [id, pending] of this.#pending) {
      if (pending.endpoint === endpoint)
        this.#finish(
          id,
          pending,
          new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
        );
    }
  }
}
