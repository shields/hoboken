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
import { heatedBeddingTopic } from "./heated-bedding-profile.ts";
import type {
  HeatedBeddingSource,
  HeatedBeddingZoneConfig,
} from "./heated-bedding-source.ts";

export interface HeatedBeddingAccessories {
  fan: Accessory;
  preheat: Accessory;
  update: () => void;
}

export function createHeatedBeddingAccessories(
  config: HeatedBeddingZoneConfig,
  source: HeatedBeddingSource,
): HeatedBeddingAccessories {
  const topic = heatedBeddingTopic(config);
  // These seeds define the initial accessory identities for Tucson's heated bedding profile.
  const fan = new Accessory(
    config.name,
    uuid.generate(
      JSON.stringify([
        "hoboken:heated-bedding:fan",
        config.controller,
        config.zone,
      ]),
    ),
  );
  fan.category = Categories.FAN;
  const fanService = fan.addService(Service.Fanv2, config.name);
  const active = fanService.getCharacteristic(Characteristic.Active);
  const speed = fanService.getCharacteristic(Characteristic.RotationSpeed);
  speed.setProps({ minValue: 0, maxValue: 100, minStep: 10 });

  const preheat = new Accessory(
    `${config.name} Preheat`,
    uuid.generate(
      JSON.stringify([
        "hoboken:heated-bedding:preheat",
        config.controller,
        config.zone,
      ]),
    ),
  );
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
    source.getState(topic).power
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE,
  );
  speed.onGet(() => source.getState(topic).heat_level * 10);
  on.onGet(() => source.getState(topic).preheat);

  active.onSet(async (value) => {
    if (
      value !== Characteristic.Active.ACTIVE &&
      value !== Characteristic.Active.INACTIVE
    ) {
      throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const state = await source.writeFan(topic, {
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
    const state = await source.writeFan(topic, { speed: value });
    return state.heat_level * 10;
  });
  on.onSet(async (value) => {
    if (typeof value !== "boolean") {
      throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    const state = await source.writePreheat(topic, value);
    return state.preheat;
  });

  const update = (): void => {
    const state = source.usableState(topic);
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
