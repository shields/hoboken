import { HAPStorage } from "@homebridge/hap-nodejs";
import { loadConfig } from "./config.ts";
import { startBridge } from "./bridge.ts";

let shutdown: (() => Promise<void>) | undefined;
const onShutdown = () => {
  if (shutdown) {
    void shutdown().then(() => process.exit(0));
  } else {
    process.exit(0);
  }
};
process.on("SIGTERM", onShutdown);
process.on("SIGINT", onShutdown);

const configPath = process.env.CONFIG_PATH ?? "/config/config.yaml";

HAPStorage.setCustomStoragePath(process.env.PERSIST_PATH ?? "/persist");

const config = loadConfig(configPath);
({ shutdown } = await startBridge(config));
