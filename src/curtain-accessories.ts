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
import { tucsonTopic } from "./tucson-profile.ts";
import { curtainMotion } from "./curtain-profile.ts";
import type { CurtainSource, CurtainConfig } from "./curtain-source.ts";

export interface CurtainAccessory {
  accessory: Accessory;
  update: () => void;
}

export function createCurtainAccessory(
  config: CurtainConfig,
  source: CurtainSource,
): CurtainAccessory {
  const topic = tucsonTopic(config);
  const accessory = new Accessory(
    config.name,
    uuid.generate(
      JSON.stringify(["hoboken:curtain", config.controller, config.zone]),
    ),
  );
  accessory.category = Categories.WINDOW_COVERING;
  const service = accessory.addService(Service.WindowCovering, config.name);
  const current = service.getCharacteristic(Characteristic.CurrentPosition);
  const target = service.getCharacteristic(Characteristic.TargetPosition);
  const motion = service.getCharacteristic(Characteristic.PositionState);
  target.setProps({ perms: [...target.props.perms, Perms.WRITE_RESPONSE] });
  const positionState = (): number => {
    switch (curtainMotion(source.getState(topic))) {
      case "opening":
        return Characteristic.PositionState.INCREASING;
      case "closing":
        return Characteristic.PositionState.DECREASING;
      case "stopped":
        return Characteristic.PositionState.STOPPED;
    }
  };
  current.onGet(() => source.getState(topic).current_position);
  target.onGet(() => source.getState(topic).target_position);
  motion.onGet(positionState);
  target.onSet(async (value) => {
    if (typeof value !== "number")
      throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    return (await source.writePosition(topic, value)).target_position;
  });
  return {
    accessory,
    update: () => {
      const state = source.usableState(topic);
      if (state) {
        current.updateValue(state.current_position);
        target.updateValue(state.target_position);
        motion.updateValue(positionState());
      } else {
        for (const characteristic of [current, target, motion])
          characteristic.updateValue(
            new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE),
          );
      }
    },
  };
}
