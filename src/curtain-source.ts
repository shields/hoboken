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

import { HAPStatus, HapStatusError } from "@homebridge/hap-nodejs";
import {
  parseCurtainState,
  type CurtainCommand,
  type CurtainState,
} from "./curtain-profile.ts";
import {
  TucsonSource,
  type TucsonEndpointConfig,
  type TucsonPublish,
  type SourceOptions,
} from "./tucson-source.ts";

export type CurtainConfig = TucsonEndpointConfig;

export class CurtainSource extends TucsonSource<CurtainState, CurtainCommand> {
  constructor(
    configs: readonly CurtainConfig[],
    publish: TucsonPublish<CurtainCommand>,
    options: SourceOptions = {},
  ) {
    super(
      configs,
      publish,
      {
        parse: parseCurtainState,
        matches: (command, state) =>
          command.target_position === state.target_position,
      },
      options,
    );
  }

  async writePosition(topic: string, position: number): Promise<CurtainState> {
    if (!Number.isInteger(position) || position < 0 || position > 100)
      throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    return this.writeCommand(topic, { target_position: position });
  }
}
