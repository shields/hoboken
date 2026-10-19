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
  coalesceHeatedBeddingFanWrites,
  heatedBeddingResumeOnly,
  normalizeHeatedBeddingSpeed,
  parseHeatedBeddingState,
  type HeatedBeddingCommand,
  type HeatedBeddingFanWrite,
  type HeatedBeddingState,
} from "./heated-bedding-profile.ts";
import { tucsonTopic } from "./tucson-profile.ts";
import {
  TucsonSource,
  type SourceOptions,
  type TucsonEndpointConfig,
  type TucsonPublish,
  type TucsonResume,
} from "./tucson-source.ts";

export type HeatedBeddingZoneConfig = TucsonEndpointConfig;

export interface HeatedBeddingGroupConfig {
  name: string;
  prefix: string;
  controller: string;
  zones: string[];
}

export type HeatedBeddingConfig =
  HeatedBeddingZoneConfig | HeatedBeddingGroupConfig;

export function heatedBeddingZoneConfigs(
  entries: readonly HeatedBeddingConfig[],
): HeatedBeddingZoneConfig[] {
  const zones = new Map<string, HeatedBeddingZoneConfig>();
  for (const entry of entries) {
    const { name, prefix, controller } = entry;
    for (const zone of "zones" in entry ? entry.zones : [entry.zone]) {
      const topic = tucsonTopic({ prefix, controller, zone });
      if (!zones.has(topic))
        zones.set(topic, { name, prefix, controller, zone });
    }
  }
  return [...zones.values()];
}
export type UsableHeatedBeddingState = HeatedBeddingState & {
  power: boolean;
  heat_level: number;
  preheat: boolean;
};
export type HeatedBeddingPublication = HeatedBeddingCommand & {
  request_id: string;
};
export type HeatedBeddingPublish = TucsonPublish<HeatedBeddingCommand>;

const RESUME: TucsonResume<
  UsableHeatedBeddingState,
  HeatedBeddingCommand,
  HeatedBeddingFanWrite
> = {
  only: heatedBeddingResumeOnly,
  powered: (state) => state.power,
  power: (command) => command.power,
};

export class HeatedBeddingSource extends TucsonSource<
  UsableHeatedBeddingState,
  HeatedBeddingCommand,
  HeatedBeddingFanWrite
> {
  constructor(
    configs: readonly HeatedBeddingZoneConfig[],
    publish: HeatedBeddingPublish,
    options: SourceOptions = {},
  ) {
    super(
      configs,
      publish,
      {
        parse: (value) => {
          const state = parseHeatedBeddingState(value);
          if (
            state.power === null ||
            state.heat_level === null ||
            state.preheat === null
          )
            return;
          return {
            ...state,
            power: state.power,
            heat_level: state.heat_level,
            preheat: state.preheat,
          };
        },
        matches: (command, state) =>
          Object.entries(command).every(
            ([field, value]) =>
              state[field as keyof HeatedBeddingCommand] === value,
          ),
      },
      options,
    );
  }

  async writeFan(
    topic: string,
    write: HeatedBeddingFanWrite,
  ): Promise<UsableHeatedBeddingState> {
    if ("speed" in write) normalizeHeatedBeddingSpeed(write.speed);
    return this.writeCoalesced(
      topic,
      write,
      coalesceHeatedBeddingFanWrites,
      RESUME,
    );
  }

  async writePreheat(
    topic: string,
    value: boolean,
  ): Promise<UsableHeatedBeddingState> {
    return this.writeCommand(topic, { preheat: value });
  }
}
