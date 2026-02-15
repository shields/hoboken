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
  Bridge,
  Categories,
  Characteristic,
  HAPStatus,
  HapStatusError,
  Service,
  uuid,
} from "@homebridge/hap-nodejs";
import type { EventEmitter } from "node:events";
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
import type {
  HapConnection,
  Metrics,
  MetricsServer,
  StatusData,
} from "./metrics.ts";

export function buildStatusData(
  config: Config,
  stateCache: ReadonlyMap<string, Z2MState>,
  mqtt: { url: string; connected: boolean },
  hapConnections: HapConnection[],
  version: string,
): StatusData {
  return {
    mqtt,
    hap: { connections: hapConnections },
    bridge: { name: config.bridge.name, version },
    devices: config.devices.map((d) => ({
      name: d.name,
      topic: d.topic,
      capabilities: [...d.capabilities],
      ...(d.scenes ? { scenes: d.scenes } : {}),
      state: stateCache.get(d.topic) ?? null,
    })),
  };
}

interface BridgeHandle {
  bridge: Bridge;
  metricsPort?: number;
  shutdown: () => Promise<void>;
}

export async function startBridge(config: Config): Promise<BridgeHandle> {
  const stateCache = new Map<string, Z2MState>();

  let metrics: Metrics | undefined;
  let metricsServer: MetricsServer | undefined;
  let metricsRegister: Registry | undefined;
  const hapConnections = new Map<EventEmitter, HapConnection>();
  if (config.metrics) {
    metricsRegister = new Registry();
    metrics = createMetrics(metricsRegister);
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
    metricsServer?.notifyStateChange();
  });

  mqttClient.on("reconnect", () => {
    log.log("MQTT reconnecting");
  });

  mqttClient.on("offline", () => {
    log.log("MQTT client offline");
    metrics?.mqttConnected.set(0);
    metricsServer?.notifyStateChange();
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
      "utf8",
    ).trim();
  } catch {
    try {
      version = execFileSync("git", ["describe", "--always", "--dirty"], {
        encoding: "utf8",
      }).trim();
    } catch {
      // Neither VERSION file nor git available
    }
  }

  if (metricsRegister && config.metrics) {
    const getStatus = () =>
      buildStatusData(
        config,
        stateCache,
        { url: sanitizedUrl, connected: mqttClient.connected },
        [...hapConnections.values()],
        version,
      );
    metricsServer = startMetricsServer(
      config.metrics.port,
      metricsRegister,
      config.metrics.bind,
      getStatus,
    );
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
    metricsServer?.notifyStateChange();

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
    metricsServer?.notifyStateChange();

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
      hapConnections.delete(connection as unknown as EventEmitter);
      metrics?.hapConnectionsActive.dec();
      metricsServer?.notifyStateChange();
    });

    // EventedHTTPServer is the internal HTTP layer that emits connection-opened
    // (HAPServer only surfaces connection-closed). Each HAPConnection emits
    // "authenticated" after a successful pair-verify handshake.
    const httpServer = (server as unknown as Record<string, EventEmitter>)
      .httpServer;
    if (httpServer) {
      httpServer.on(
        "connection-opened",
        (connection: EventEmitter & { remoteAddress?: string }) => {
          const addr = connection.remoteAddress ?? "unknown";
          log.log(`HAP connection opened from ${addr}`);
          const entry: HapConnection = {
            remoteAddress: addr,
            authenticated: false,
          };
          hapConnections.set(connection, entry);
          metrics?.hapConnectionsActive.inc();
          metricsServer?.notifyStateChange();

          connection.on("authenticated", () => {
            entry.authenticated = true;
            metrics?.hapPairVerify.inc();
            metricsServer?.notifyStateChange();
          });
        },
      );
    }
  }

  const msAddr = metricsServer?.server.address();
  const metricsPort =
    typeof msAddr === "object" && msAddr ? msAddr.port : undefined;

  return {
    bridge,
    ...(metricsPort === undefined ? {} : { metricsPort }),
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
        await ms.close();
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
