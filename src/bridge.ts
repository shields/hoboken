import {
  Bridge,
  Categories,
  Characteristic,
  HAPStatus,
  HapStatusError,
  Service,
  uuid,
} from "@homebridge/hap-nodejs";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "mqtt";
import { Registry } from "prom-client";
import type { Config } from "./config.ts";
import * as log from "./log.ts";
import {
  createLightAccessory,
  createSceneAccessory,
  updateAccessoryState,
} from "./accessories.ts";
import type { PublishFn, Z2MState } from "./accessories.ts";
import { createMetrics, startMetricsServer } from "./metrics.ts";
import type { Metrics, MetricsServer } from "./metrics.ts";

export async function startBridge(
  config: Config,
): Promise<{ bridge: Bridge; shutdown: () => Promise<void> }> {
  const stateCache = new Map<string, Z2MState>();

  let metrics: Metrics | undefined;
  let metricsServer: MetricsServer | undefined;
  let metricsRegister: Registry | undefined;
  if (config.metrics) {
    metricsRegister = new Registry();
    metrics = createMetrics(metricsRegister);
    metricsServer = startMetricsServer(
      config.metrics.port,
      metricsRegister,
      config.metrics.bind,
    );
  }

  let sanitizedUrl: string;
  try {
    const parsed = new URL(config.mqtt.url);
    parsed.password = "";
    parsed.username = "";
    sanitizedUrl = parsed.href;
  } catch {
    // Strip userinfo (user:pass@) via regex for URLs that new URL() can't parse
    // but mqtt.connect() accepts (e.g. bare hostnames).
    sanitizedUrl = config.mqtt.url.replace(/\/\/[^@/]*@/, "//");
  }
  log.log(`Connecting to MQTT at ${sanitizedUrl}`);

  // mqtt.connect() is more lenient than new URL() — it handles bare hostnames,
  // missing protocols, etc. — so an unparseable URL here is not an error.
  const mqttClient = connect(config.mqtt.url);

  mqttClient.on("error", (err) => {
    log.error(`MQTT error: ${err.message}`);
    metrics?.mqttErrors.inc();
  });

  mqttClient.on("close", () => {
    log.log("MQTT connection closed");
    metrics?.mqttConnected.set(0);
  });

  mqttClient.on("reconnect", () => {
    log.log("MQTT reconnecting");
  });

  mqttClient.on("offline", () => {
    log.log("MQTT client offline");
    metrics?.mqttConnected.set(0);
  });

  const publish: PublishFn = (topic, payload) => {
    if (!mqttClient.connected) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    mqttClient.publish(
      `${config.mqtt.topic_prefix}/${topic}`,
      JSON.stringify(payload),
    );
    metrics?.mqttMessagesPublished.inc();
  };

  const getState = (topic: string) => stateCache.get(topic);

  let version = "unknown";
  try {
    version = readFileSync(
      new URL("../VERSION", import.meta.url),
      "utf-8",
    ).trim();
  } catch {
    try {
      version = execFileSync("git", ["describe", "--always", "--dirty"], {
        encoding: "utf-8",
      }).trim();
    } catch {
      // Neither VERSION file nor git available
    }
  }

  const bridge = new Bridge(
    config.bridge.name,
    uuid.generate(config.bridge.mac),
  );

  setAccessoryInfo(
    bridge,
    "Hoboken",
    "MQTT Bridge",
    config.bridge.mac,
    version,
  );

  const accessoryMap = new Map<
    string,
    {
      accessory: ReturnType<typeof createLightAccessory>;
      device: Config["devices"][number];
    }
  >();

  log.log(
    `Configuring bridge "${config.bridge.name}" with ${String(config.devices.length)} device(s)`,
  );

  for (const device of config.devices) {
    log.log(
      `  Adding device "${device.name}" (topic: ${device.topic}, capabilities: ${device.capabilities.join(", ")})`,
    );
    const accessory = createLightAccessory(device, publish, getState);
    setAccessoryInfo(accessory, "Hoboken", device.topic, device.topic, version);
    bridge.addBridgedAccessory(accessory);
    accessoryMap.set(device.topic, { accessory, device });

    if (device.scenes) {
      for (const scene of device.scenes) {
        const sceneAccessory = createSceneAccessory(device, scene, publish);
        setAccessoryInfo(
          sceneAccessory,
          "Hoboken",
          "Scene",
          `${device.topic}:scene:${String(scene.id)}`,
          version,
        );
        bridge.addBridgedAccessory(sceneAccessory);
      }
    }
  }

  metrics?.devicesConfigured.set(config.devices.length);

  mqttClient.on("connect", () => {
    log.log("MQTT connected");
    metrics?.mqttConnected.set(1);
    const topics = config.devices.map(
      (d) => `${config.mqtt.topic_prefix}/${d.topic}`,
    );
    mqttClient.subscribe(topics);

    for (const device of config.devices) {
      mqttClient.publish(
        `${config.mqtt.topic_prefix}/${device.topic}/get`,
        JSON.stringify({ state: "" }),
      );
    }
  });

  mqttClient.on("message", (topic, payload) => {
    const prefix = `${config.mqtt.topic_prefix}/`;
    if (!topic.startsWith(prefix)) return;

    const deviceTopic = topic.slice(prefix.length);
    const entry = accessoryMap.get(deviceTopic);
    if (!entry) return;

    metrics?.mqttMessagesReceived.labels(deviceTopic).inc();

    let state: Z2MState;
    try {
      state = JSON.parse(payload.toString()) as Z2MState;
    } catch {
      return;
    }

    // Intentionally verbose — essential for diagnosing device/state issues
    // during bring-up. Device count is small (single household), so volume
    // is manageable. Remove once the deployment is stable.
    log.log(
      `State update for "${entry.device.name}": ${JSON.stringify(state)}`,
    );

    const existing = stateCache.get(deviceTopic);
    stateCache.set(deviceTopic, { ...existing, ...state });

    // Pass the partial update, not the merged state — updateAccessoryState
    // uses "key in state" checks to only push characteristics that changed.
    updateAccessoryState(entry.accessory, state, entry.device.capabilities);
  });

  bridge.on("identify", (paired, callback) => {
    log.log(`Identify requested (paired=${String(paired)})`);
    callback();
  });

  bridge.on("listening", (port, address) => {
    log.log(`HAP server listening on ${address}:${String(port)}`);
  });

  bridge.on("advertised", () => {
    log.log("mDNS advertisement active");
  });

  bridge.on("paired", () => {
    log.log("Pairing complete");
  });

  bridge.on("unpaired", () => {
    log.log("Accessory unpaired");
  });

  bridge.on("characteristic-warning", (warning) => {
    log.warn(`Characteristic warning [${warning.type}]: ${warning.message}`);
  });

  await bridge.publish({
    username: config.bridge
      .mac as `${string}:${string}:${string}:${string}:${string}:${string}`,
    pincode: config.bridge.pincode as `${string}-${string}-${string}`,
    port: config.bridge.port,
    category: Categories.BRIDGE,
    ...(config.bridge.bind ? { bind: config.bridge.bind } : {}),
  });

  metricsServer?.setReady();

  // _server is a private hap-nodejs API, but it's the only way to log
  // connection-level events (pair-setup completion, disconnects) not exposed
  // by the public Accessory API. Guarded by an if-check so a future library
  // change that removes the property degrades gracefully (no logging, no crash).
  const server = bridge._server;
  if (server) {
    server.on("pair", (username) => {
      log.log(`Pair-setup finished for ${username}`);
    });

    server.on("connection-closed", (connection) => {
      log.log(
        `HAP connection closed from ${connection.remoteAddress}:${String(connection.remotePort)}`,
      );
    });
  }

  return {
    bridge,
    shutdown: async () => {
      log.log("Shutting down: unpublishing bridge (sending mDNS goodbye)");
      await bridge.unpublish();
      log.log("Shutting down: closing MQTT connection");
      await new Promise<void>((resolve) => {
        mqttClient.end(false, () => {
          resolve();
        });
      });
      const ms = metricsServer;
      if (ms) {
        log.log("Shutting down: stopping metrics server");
        await new Promise<void>((resolve, reject) => {
          ms.server.close((err?: Error) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
      metrics?.dispose();
      log.log("Shutdown complete");
    },
  };
}

function setAccessoryInfo(
  accessory: { getService: typeof Bridge.prototype.getService },
  manufacturer: string,
  model: string,
  serialNumber: string,
  firmwareRevision: string,
): void {
  const info = accessory.getService(Service.AccessoryInformation);
  if (info) {
    info
      .setCharacteristic(Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(Characteristic.Model, model)
      .setCharacteristic(Characteristic.SerialNumber, serialNumber)
      .setCharacteristic(Characteristic.FirmwareRevision, firmwareRevision);
  }
}
