import {
  Bridge,
  Categories,
  HAPStatus,
  HapStatusError,
  uuid,
} from "@homebridge/hap-nodejs";
import { connect } from "mqtt";
import type { Config } from "./config.ts";
import * as log from "./log.ts";
import {
  createLightAccessory,
  createSceneAccessory,
  updateAccessoryState,
} from "./accessories.ts";
import type { PublishFn, Z2MState } from "./accessories.ts";

export async function startBridge(
  config: Config,
): Promise<{ bridge: Bridge; shutdown: () => Promise<void> }> {
  const stateCache = new Map<string, Z2MState>();

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
  });

  mqttClient.on("close", () => {
    log.log("MQTT connection closed");
  });

  mqttClient.on("reconnect", () => {
    log.log("MQTT reconnecting");
  });

  mqttClient.on("offline", () => {
    log.log("MQTT client offline");
  });

  const publish: PublishFn = (topic, payload) => {
    if (!mqttClient.connected) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    mqttClient.publish(
      `${config.mqtt.topic_prefix}/${topic}`,
      JSON.stringify(payload),
    );
  };

  const getState = (topic: string) => stateCache.get(topic);

  const bridge = new Bridge(
    config.bridge.name,
    uuid.generate(config.bridge.mac),
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
    bridge.addBridgedAccessory(accessory);
    accessoryMap.set(device.topic, { accessory, device });

    if (device.scenes) {
      for (const scene of device.scenes) {
        const sceneAccessory = createSceneAccessory(device, scene, publish);
        bridge.addBridgedAccessory(sceneAccessory);
      }
    }
  }

  mqttClient.on("connect", () => {
    log.log("MQTT connected");
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
      await bridge.unpublish();
      await new Promise<void>((resolve) => {
        mqttClient.end(false, () => {
          resolve();
        });
      });
    },
  };
}
