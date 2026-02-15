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

import { HAPStorage } from "@homebridge/hap-nodejs";
import { loadConfig } from "./config.ts";
import { startBridge } from "./bridge.ts";
import * as log from "./log.ts";

// eslint-disable-next-line prefer-const -- assigned via destructuring after signal handlers are installed
let shutdown: (() => Promise<void>) | undefined;
let shuttingDown = false;
const onShutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.log(`Received ${signal}`);
  if (shutdown) {
    void shutdown()
      // eslint-disable-next-line unicorn/no-process-exit -- HAP server keeps handles open
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error(
          `Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
        // eslint-disable-next-line unicorn/no-process-exit -- must terminate despite active handles
        process.exit(1);
      });
  } else {
    // eslint-disable-next-line unicorn/no-process-exit -- no shutdown handler registered yet
    process.exit(0);
  }
};
process.on("SIGTERM", () => {
  onShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  onShutdown("SIGINT");
});

const configPath = process.env.CONFIG_PATH ?? "/config/config.yaml";

HAPStorage.setCustomStoragePath(process.env.PERSIST_PATH ?? "/persist");

const config = loadConfig(configPath);
({ shutdown } = await startBridge(config));
