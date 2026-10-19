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
  Accessory,
  Categories,
  Characteristic,
  HAPStatus,
  HapStatusError,
  Perms,
  Service,
  uuid,
} from "@homebridge/hap-nodejs";
import pino, { type Logger } from "pino";
import {
  aggregateHeatedBeddingStates,
  heatedBeddingTopic,
  heatedBeddingTopics,
  sortedHeatedBeddingZones,
  type HeatedBeddingFanRequest,
  type HeatedBeddingSummary,
} from "./heated-bedding-profile.ts";
import type {
  HeatedBeddingConfig,
  HeatedBeddingGroupConfig,
  HeatedBeddingSource,
  UsableHeatedBeddingState,
} from "./heated-bedding-source.ts";

export interface HeatedBeddingAccessories {
  fan: Accessory;
  preheat: Accessory;
  update: () => void;
}

interface Control {
  usable: () => HeatedBeddingSummary | undefined;
  get: () => HeatedBeddingSummary;
  writeFan: (write: HeatedBeddingFanRequest) => Promise<HeatedBeddingSummary>;
  writePreheat: (value: boolean) => Promise<HeatedBeddingSummary>;
}

function zoneControl(source: HeatedBeddingSource, topic: string): Control {
  return {
    usable: () => source.usableState(topic),
    get: () => source.getState(topic),
    writeFan: (write) => source.writeFan(topic, write),
    writePreheat: (value) => source.writePreheat(topic, value),
  };
}

function groupControl(
  config: HeatedBeddingGroupConfig,
  source: HeatedBeddingSource,
  logger: Logger,
): Control {
  const topics = heatedBeddingTopics(config);
  const memberStates = (): (UsableHeatedBeddingState | undefined)[] =>
    topics.map((topic) => source.usableState(topic));
  const logFailure = (index: number, err: unknown): void => {
    logger.error(
      {
        event: "group_write_failed",
        group: config.name,
        topic: topics[index],
        err,
      },
      "Heated bedding group write failed",
    );
  };
  const fanOut = async (
    send: (topic: string) => Promise<HeatedBeddingSummary>,
  ): Promise<HeatedBeddingSummary> => {
    for (const topic of topics) source.getState(topic);
    const outcomes = await Promise.allSettled(topics.map(send));
    let failure: { reason: unknown } | undefined;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === "rejected") {
        logFailure(index, outcome.reason);
        failure ??= { reason: outcome.reason };
      }
    }
    if (failure) throw failure.reason;
    // The response becomes the characteristic's value without a notification,
    // and a member can change after it confirms and before the last one does,
    // so it must describe every member as they are now.
    const states = memberStates();
    const live = states.filter((state) => state !== undefined);
    if (live.length < topics.length) {
      const error = new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      for (const [index, state] of states.entries()) {
        if (!state) logFailure(index, error);
      }
      throw error;
    }
    return aggregateHeatedBeddingStates(live);
  };
  return {
    usable: () => {
      const states = memberStates();
      return states.every((state) => state !== undefined)
        ? aggregateHeatedBeddingStates(states)
        : undefined;
    },
    get: () =>
      aggregateHeatedBeddingStates(
        topics.map((topic) => source.getState(topic)),
      ),
    writeFan: (write) =>
      fanOut((topic) =>
        source.writeFan(
          topic,
          "active" in write && write.active ? { resume: true } : write,
        ),
      ),
    writePreheat: (value) =>
      fanOut((topic) => source.writePreheat(topic, value)),
  };
}

export function createHeatedBeddingAccessories(
  config: HeatedBeddingConfig,
  source: HeatedBeddingSource,
  logger?: Logger,
): HeatedBeddingAccessories {
  const control =
    "zones" in config
      ? groupControl(
          config,
          source,
          logger ?? pino({ name: "heated-bedding-group" }),
        )
      : zoneControl(source, heatedBeddingTopic(config));
  // These seeds define the initial accessory identities for Tucson's heated bedding profile.
  const seed = (kind: string): string =>
    uuid.generate(
      JSON.stringify([
        `hoboken:heated-bedding:${kind}`,
        config.controller,
        "zones" in config
          ? sortedHeatedBeddingZones(config.zones)
          : config.zone,
      ]),
    );
  const fan = new Accessory(config.name, seed("fan"));
  fan.category = Categories.FAN;
  const fanService = fan.addService(Service.Fanv2, config.name);
  const active = fanService.getCharacteristic(Characteristic.Active);
  const speed = fanService.getCharacteristic(Characteristic.RotationSpeed);
  speed.setProps({ minValue: 0, maxValue: 100, minStep: 10 });

  const preheat = new Accessory(`${config.name} Preheat`, seed("preheat"));
  preheat.category = Categories.SWITCH;
  const preheatService = preheat.addService(
    Service.Switch,
    `${config.name} Preheat`,
  );
  const on = preheatService.getCharacteristic(Characteristic.On);

  for (const characteristic of [active, speed, on]) {
    characteristic.setProps({
      perms: [...characteristic.props.perms, Perms.WRITE_RESPONSE],
    });
  }

  active.onGet(() =>
    control.get().power
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE,
  );
  speed.onGet(() => control.get().heat_level * 10);
  on.onGet(() => control.get().preheat);

  active.onSet(async (value) => {
    if (
      value !== Characteristic.Active.ACTIVE &&
      value !== Characteristic.Active.INACTIVE
    ) {
      throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const state = await control.writeFan({
      active: value === Characteristic.Active.ACTIVE,
    });
    return state.power
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE;
  });
  speed.onSet(async (value) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100
    ) {
      throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const state = await control.writeFan({ speed: value });
    return state.heat_level * 10;
  });
  on.onSet(async (value) => {
    if (typeof value !== "boolean") {
      throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const state = await control.writePreheat(value);
    return state.preheat;
  });

  const update = (): void => {
    const state = control.usable();
    if (!state) {
      for (const characteristic of [active, speed, on])
        characteristic.updateValue(
          new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
        );
      return;
    }
    active.updateValue(
      state.power
        ? Characteristic.Active.ACTIVE
        : Characteristic.Active.INACTIVE,
    );
    speed.updateValue(state.heat_level * 10);
    on.updateValue(state.preheat);
  };
  update();
  return { fan, preheat, update };
}
