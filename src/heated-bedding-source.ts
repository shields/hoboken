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
  coalesceHeatedBeddingFanWrites,
  normalizeHeatedBeddingSpeed,
  parseHeatedBeddingHeartbeat,
  parseHeatedBeddingResult,
  parseHeatedBeddingState,
  type HeatedBeddingCommand,
  type HeatedBeddingFanWrite,
  type HeatedBeddingState,
} from "./heated-bedding-profile.ts";

export interface HeatedBeddingZoneConfig {
  name: string;
  prefix: string;
  controller: string;
  zone: string;
}

export type UsableHeatedBeddingState = HeatedBeddingState & {
  power: boolean;
  heat_level: number;
  preheat: boolean;
};

export type HeatedBeddingPublication = HeatedBeddingCommand & {
  request_id: string;
};
export type HeatedBeddingPublish = (
  topic: string,
  payload: HeatedBeddingPublication,
  complete: (error?: Error) => void,
) => void;

interface Prefix {
  online: boolean;
  session: string | undefined;
  heartbeat: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  zones: Zone[];
}

interface Controller {
  online: boolean;
  zones: Zone[];
}

interface Waiter {
  resolve: (state: UsableHeatedBeddingState) => void;
  reject: (error: unknown) => void;
}

interface FanWindow {
  writes: HeatedBeddingFanWrite[];
  waiters: Waiter[];
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

interface Zone {
  topic: string;
  prefix: Prefix;
  controller: Controller;
  state: HeatedBeddingState | undefined;
  window: FanWindow | undefined;
  callers: number;
}

interface Pending {
  zone: Zone;
  command: HeatedBeddingCommand;
  session: string;
  deadline: number;
  confirmed: boolean;
  waiters: Waiter[];
  timer: ReturnType<typeof setTimeout>;
}

type Route =
  | { kind: "bridge" | "heartbeat"; prefix: Prefix }
  | { kind: "controller"; controller: Controller }
  | { kind: "state" | "result"; zone: Zone };

interface SourceOptions {
  clock?: () => number;
  identifier?: () => string;
  changed?: (topic: string) => void;
  failed?: () => void;
}

const HEARTBEAT_TIMEOUT = 45000;
const WRITE_TIMEOUT = 8500;
const COALESCE_DELAY = 50;
const MAX_CALLERS = 32;

export class HeatedBeddingSource {
  #zones = new Map<string, Zone>();
  #prefixes = new Map<string, Prefix>();
  #controllers = new Map<string, Controller>();
  #routes = new Map<string, Route>();
  #pending = new Map<string, Pending>();
  #clock: () => number;
  #identifier: () => string;
  #publish: HeatedBeddingPublish;
  #changed: SourceOptions["changed"];
  #failed: SourceOptions["failed"];
  #generation = 0;
  #connected = false;
  #subscribed = false;

  constructor(
    configs: readonly HeatedBeddingZoneConfig[],
    publish: HeatedBeddingPublish,
    options: SourceOptions = {},
  ) {
    this.#publish = publish;
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
          zones: [],
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
        controller = { online: false, zones: [] };
        this.#controllers.set(controllerTopic, controller);
        this.#route(`${controllerTopic}/availability`, {
          kind: "controller",
          controller,
        });
      }
      const topic = `${controllerTopic}/${config.zone}`;
      const zone: Zone = {
        topic,
        prefix,
        controller,
        state: undefined,
        window: undefined,
        callers: 0,
      };
      this.#route(topic, { kind: "state", zone });
      this.#route(`${topic}/result`, { kind: "result", zone });
      this.#zones.set(topic, zone);
      prefix.zones.push(zone);
      controller.zones.push(zone);
    }
  }

  #route(topic: string, route: Route): void {
    if (this.#routes.has(topic))
      throw new RangeError(`Duplicate heated bedding MQTT topic "${topic}"`);
    this.#routes.set(topic, route);
  }

  #zone(topic: string): Zone {
    const zone = this.#zones.get(topic);
    if (!zone) throw new RangeError("Unknown heated bedding zone");
    return zone;
  }

  connect(): number {
    this.disconnect();
    this.#connected = true;
    return this.#generation;
  }

  subscriptionsReady(generation: number): void {
    if (!this.#connected || generation !== this.#generation) return;
    this.#subscribed = true;
    for (const zone of this.#zones.values()) this.#changed?.(zone.topic);
  }

  disconnect(): void {
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
    for (const zone of this.#zones.values()) {
      zone.state = undefined;
      this.#cancel(zone);
      this.#changed?.(zone.topic);
    }
  }

  topics(): { topic: string; live: boolean }[] {
    return [...this.#routes].map(([topic, route]) => ({
      topic,
      live: route.kind === "heartbeat" || route.kind === "result",
    }));
  }

  getState(topic: string): UsableHeatedBeddingState {
    const zone = this.#zone(topic);
    const state = zone.state;
    if (
      !this.#connected ||
      !this.#subscribed ||
      !zone.prefix.online ||
      !zone.controller.online ||
      zone.prefix.heartbeat === undefined ||
      this.#clock() - zone.prefix.heartbeat >= HEARTBEAT_TIMEOUT ||
      !state ||
      state.session_id !== zone.prefix.session ||
      state.power === null ||
      state.heat_level === null ||
      state.preheat === null
    )
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    return {
      ...state,
      power: state.power,
      heat_level: state.heat_level,
      preheat: state.preheat,
    };
  }

  pendingCount(topic: string): number {
    return this.#zone(topic).callers;
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
          for (const zone of route.prefix.zones) this.#cancel(zone);
        }
        for (const zone of route.prefix.zones) this.#changed?.(zone.topic);
        if (payload !== "online" && payload !== "offline")
          throw new RangeError("Invalid heated bedding bridge availability");
        break;
      }
      case "controller": {
        route.controller.online = payload === "online";
        for (const zone of route.controller.zones) {
          if (!route.controller.online) this.#cancel(zone);
          this.#changed?.(zone.topic);
        }
        if (payload !== "online" && payload !== "offline")
          throw new RangeError(
            "Invalid heated bedding controller availability",
          );
        break;
      }
      case "heartbeat": {
        if (retained) return;
        const session = parseHeatedBeddingHeartbeat(payload);
        if (session !== route.prefix.session) {
          for (const zone of route.prefix.zones) this.#cancel(zone);
        }
        route.prefix.session = session;
        route.prefix.heartbeat = this.#clock();
        clearTimeout(route.prefix.timer);
        route.prefix.timer = setTimeout(() => {
          route.prefix.heartbeat = undefined;
          for (const zone of route.prefix.zones) {
            this.#cancel(zone);
            this.#changed?.(zone.topic);
          }
        }, HEARTBEAT_TIMEOUT);
        route.prefix.timer.unref();
        for (const zone of route.prefix.zones) this.#changed?.(zone.topic);
        break;
      }
      case "state": {
        route.zone.state = undefined;
        try {
          route.zone.state = parseHeatedBeddingState(payload);
        } catch (error: unknown) {
          this.#cancel(route.zone);
          this.#changed?.(route.zone.topic);
          throw error;
        }
        for (const [id, pending] of this.#pending) {
          if (pending.zone === route.zone) this.#confirm(id, pending);
        }
        this.#changed?.(route.zone.topic);
        break;
      }
      case "result": {
        if (retained) return;
        const result = parseHeatedBeddingResult(payload);
        const pending = this.#pending.get(result.request_id);
        if (pending?.zone !== route.zone) return;
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

  #admit(topic: string): Zone {
    this.getState(topic);
    const zone = this.#zone(topic);
    if (zone.callers >= MAX_CALLERS)
      throw new HapStatusError(HAPStatus.RESOURCE_BUSY);
    zone.callers++;
    return zone;
  }

  async writeFan(
    topic: string,
    write: HeatedBeddingFanWrite,
  ): Promise<UsableHeatedBeddingState> {
    if ("speed" in write) normalizeHeatedBeddingSpeed(write.speed);
    const zone = this.#admit(topic);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (zone.window) {
        zone.window.writes.push(write);
        zone.window.waiters.push(waiter);
      } else {
        const window: FanWindow = {
          writes: [write],
          waiters: [waiter],
          deadline: this.#clock() + WRITE_TIMEOUT,
          timer: setTimeout(() => {
            zone.window = undefined;
            this.#send(
              zone,
              coalesceHeatedBeddingFanWrites(window.writes),
              window.waiters,
              window.deadline,
            );
          }, COALESCE_DELAY),
        };
        window.timer.unref();
        zone.window = window;
      }
    });
  }

  async writePreheat(
    topic: string,
    value: boolean,
  ): Promise<UsableHeatedBeddingState> {
    const zone = this.#admit(topic);
    return new Promise((resolve, reject) => {
      this.#send(
        zone,
        { preheat: value },
        [{ resolve, reject }],
        this.#clock() + WRITE_TIMEOUT,
      );
    });
  }

  #send(
    zone: Zone,
    command: HeatedBeddingCommand,
    waiters: Waiter[],
    deadline: number,
  ): void {
    try {
      this.#dispatch(zone, command, waiters, deadline);
    } catch (error: unknown) {
      this.#reject(zone, waiters, error);
    }
  }

  #dispatch(
    zone: Zone,
    command: HeatedBeddingCommand,
    waiters: Waiter[],
    deadline: number,
  ): void {
    if (this.#clock() >= deadline) {
      this.#reject(
        zone,
        waiters,
        new HapStatusError(HAPStatus.OPERATION_TIMED_OUT),
      );
      return;
    }
    let state: UsableHeatedBeddingState;
    try {
      state = this.getState(zone.topic);
    } catch (error: unknown) {
      if (!(error instanceof HapStatusError)) throw error;
      this.#reject(zone, waiters, error);
      return;
    }
    const id = this.#identifier();
    if (this.#pending.has(id)) {
      throw new Error("Duplicate generated heated bedding request ID");
    }
    const pending: Pending = {
      zone,
      command,
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
        `${zone.topic}/set`,
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
  }

  #confirm(id: string, pending: Pending): void {
    if (this.#clock() >= pending.deadline) {
      this.#finish(
        id,
        pending,
        new HapStatusError(HAPStatus.OPERATION_TIMED_OUT),
      );
      return;
    }
    if (!pending.confirmed) return;
    let state: UsableHeatedBeddingState;
    try {
      state = this.getState(pending.zone.topic);
    } catch (error: unknown) {
      if (!(error instanceof HapStatusError)) throw error;
      this.#finish(id, pending, error);
      return;
    }
    if (
      state.session_id !== pending.session ||
      Object.entries(pending.command).some(
        ([field, value]) =>
          state[field as keyof HeatedBeddingCommand] !== value,
      )
    )
      return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.zone.callers -= pending.waiters.length;
    for (const waiter of pending.waiters) waiter.resolve(state);
  }

  #reject(zone: Zone, waiters: Waiter[], error: unknown): void {
    zone.callers -= waiters.length;
    for (const waiter of waiters) waiter.reject(error);
  }

  #finish(id: string, pending: Pending, error: HapStatusError): void {
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    this.#reject(pending.zone, pending.waiters, error);
  }

  #cancel(zone: Zone): void {
    if (zone.window) {
      clearTimeout(zone.window.timer);
      this.#reject(
        zone,
        zone.window.waiters,
        new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
      );
      zone.window = undefined;
    }
    for (const [id, pending] of this.#pending) {
      if (pending.zone === zone)
        this.#finish(
          id,
          pending,
          new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
        );
    }
  }
}
