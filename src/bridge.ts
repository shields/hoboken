import { Bridge, HapStatusError, uuid } from "@homebridge/hap-nodejs";
import { connect } from "mqtt";
import type { MqttClient } from "mqtt";
import type { Config } from "./config.ts";
import {
  createLightAccessory,
  createSceneAccessory,
  updateAccessoryState,
} from "./accessories.ts";
import type { PublishFn, Z2MState } from "./accessories.ts";

export async function startBridge(
  config: Config,
): Promise<{ shutdown: () => Promise<void> }> {
  const stateCache = new Map<string, Z2MState>();
  let mqttClient: MqttClient | undefined;

  const publish: PublishFn = (topic, payload) => {
    if (!mqttClient?.connected) {
      throw new HapStatusError(
        -70402 /* HAPStatus.SERVICE_COMMUNICATION_FAILURE */,
      );
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

  for (const device of config.devices) {
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

  mqttClient = connect(config.mqtt.url);

  mqttClient.on("error", (err) => {
    console.error("MQTT error:", err.message);
  });

  mqttClient.on("connect", () => {
    const topics = config.devices.map(
      (d) => `${config.mqtt.topic_prefix}/${d.topic}`,
    );
    mqttClient!.subscribe(topics);

    for (const device of config.devices) {
      mqttClient!.publish(
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

    const existing = stateCache.get(deviceTopic);
    stateCache.set(deviceTopic, { ...existing, ...state });

    // Pass the partial update, not the merged state — updateAccessoryState
    // uses "key in state" checks to only push characteristics that changed.
    updateAccessoryState(entry.accessory, state, entry.device.capabilities);
  });

  await bridge.publish({
    username: config.bridge
      .mac as `${string}:${string}:${string}:${string}:${string}:${string}`,
    pincode: config.bridge.pincode as `${string}-${string}-${string}`,
    port: config.bridge.port,
    category: 2 /* Categories.BRIDGE */,
  });

  return {
    shutdown: async () => {
      await bridge.unpublish();
      await new Promise<void>((resolve) => {
        if (mqttClient) {
          mqttClient.end(false, () => {
            resolve();
          });
        } else {
          resolve();
        }
      });
    },
  };
}
