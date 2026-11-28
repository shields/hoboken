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
import { vacuumTopics, type VacuumConfig } from "./vacuum-profile.ts";

export function createVacuumAccessory(
  config: VacuumConfig,
  getState: () => boolean | undefined,
  publish: (topic: string, command: string) => Promise<void>,
) {
  const topics = vacuumTopics(config);
  const accessory = new Accessory(
    config.name,
    uuid.generate(JSON.stringify(["hoboken:vacuum", topics.base])),
  );
  accessory.category = Categories.SWITCH;
  const on = accessory
    .addService(Service.Switch, config.name)
    .getCharacteristic(Characteristic.On);
  const unavailable = () =>
    new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  const read = () => {
    const value = getState();
    if (value === undefined) throw unavailable();
    return value;
  };
  on.setProps({ perms: [...on.props.perms, Perms.WRITE_RESPONSE] });
  on.onGet(read);
  on.onSet(async (value) => {
    read();
    await publish(topics.command, value ? "start" : "return");
    return read();
  });
  return {
    accessory,
    update: () => {
      on.updateValue(getState() ?? unavailable());
    },
  };
}
