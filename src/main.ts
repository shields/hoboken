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
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error(
          `Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      });
  } else {
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
