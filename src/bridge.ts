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

import { CurtainMQTT } from "./curtain-mqtt.ts";
import { curtainIdentity } from "./curtain-profile.ts";
import type { CurtainSource } from "./curtain-source.ts";
import {
  createCurtainAccessory,
  type CurtainAccessory,
} from "./curtain-accessories.ts";
import {
  Accessory,
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
import { fileURLToPath } from "node:url";
import { connect, type ISubscriptionGrant } from "mqtt";
import { Registry } from "prom-client";
import {
  assertMQTTURL,
  credentialOptions,
  displayMQTTURL,
  withoutErrorMessage,
  type Config,
  type MQTTCredentials,
} from "./config.ts";
import { HeatedBeddingMQTT } from "./heated-bedding-mqtt.ts";
import { MAX_BACKOFF, MIN_BACKOFF } from "./tucson-mqtt.ts";
import { tucsonTopic } from "./tucson-profile.ts";
import {
  heatedBeddingIdentity,
  heatedBeddingTopics,
} from "./heated-bedding-profile.ts";
import {
  heatedBeddingZoneConfigs,
  type HeatedBeddingSource,
} from "./heated-bedding-source.ts";
import {
  createHeatedBeddingAccessories,
  type HeatedBeddingAccessories,
} from "./heated-bedding-accessories.ts";
import * as log from "./log.ts";
import {
  createFanAccessory,
  createLightAccessory,
  createSceneAccessory,
  updateAccessoryState,
  updateFanAccessoryState,
} from "./accessories.ts";
import type { PublishFn } from "./accessories.ts";
import {
  type RawState,
  homeKitToWled,
  homeKitToZ2m,
  parseWledMessage,
  wledToHomeKit,
  z2mToHomeKit,
} from "./convert.ts";
import { createMetrics, startMetricsServer } from "./metrics.ts";
import type {
  HapConnection,
  HeatedBeddingZoneStatus,
  Metrics,
  MetricsServer,
  StatusData,
} from "./metrics.ts";

const WRITE_BACK_SUPPRESSION_MS = 500;
const GET_RETRY_INITIAL_MS = 2000;
const GET_RETRY_MAX_MS = 1_024_000;
const GET_JITTER_FRACTION = 0.25;
const SUBACK_FAILURE = 0x80;

// A SUBACK carries one code per requested topic, in request order, so its
// codes name topics only when the counts agree.
function deniedTopics(
  grants: readonly ISubscriptionGrant[],
  codes: readonly unknown[] = [],
): string[] {
  const aligned = codes.length === grants.length ? codes : [];
  return grants
    .filter(
      (_, i) => typeof aligned[i] === "number" && aligned[i] >= SUBACK_FAILURE,
    )
    .map(({ topic }) => topic);
}

export function buildStatusData(
  config: Config,
  stateCache: ReadonlyMap<string, RawState>,
  mqtt: { url: string; connected: boolean },
  hapConnections: HapConnection[],
  version: string,
  heatedBedding?: HeatedBeddingSource,
  curtains?: CurtainSource,
): StatusData {
  return {
    mqtt,
    hap: { connections: hapConnections },
    bridge: { name: config.bridge.name, version },
    devices: config.devices.map((d) => ({
      name: d.name,
      topic: d.topic,
      type: d.type,
      capabilities: [...d.capabilities],
      ...(d.scenes ? { scenes: d.scenes } : {}),
      state: stateCache.get(d.topic) ?? null,
    })),
    ...(config.heatedBedding?.length
      ? {
          heatedBedding: config.heatedBedding.map((entry) => {
            const zoneStatus = (topic: string): HeatedBeddingZoneStatus => ({
              topic,
              state: heatedBedding?.usableState(topic) ?? null,
              pending: heatedBedding?.pendingCount(topic) ?? 0,
            });
            return "zones" in entry
              ? {
                  name: entry.name,
                  zones: heatedBeddingTopics(entry).map(zoneStatus),
                }
              : { name: entry.name, ...zoneStatus(tucsonTopic(entry)) };
          }),
        }
      : {}),
    ...(config.curtains?.length
      ? {
          curtains: config.curtains.map((curtain) => {
            const topic = tucsonTopic(curtain);
            return {
              name: curtain.name,
              topic,
              state: curtains?.usableState(topic) ?? null,
              pending: curtains?.pendingCount(topic) ?? 0,
            };
          }),
        }
      : {}),
  };
}

interface BridgeHandle {
  bridge: Bridge;
  hapPort: number;
  metricsPort?: number;
  shutdown: () => Promise<void>;
}

function checkCredentials(
  mqtt: Config["mqtt"],
  credentials: MQTTCredentials | undefined,
): void {
  if (mqtt.username === undefined) {
    if (credentials) throw new Error("credentials require mqtt.username");
    if (mqtt.passwordFile !== undefined) {
      throw new Error("mqtt.passwordFile requires mqtt.username");
    }
  } else if (!credentials) {
    throw new Error("mqtt.username requires credentials");
  } else if (credentials.username !== mqtt.username) {
    throw new Error("credentials.username must match mqtt.username");
  }
}

export function readVersion(): string {
  let version = "unknown";
  try {
    version = readFileSync(
      new URL("../VERSION", import.meta.url),
      "utf8",
    ).trim();
  } catch {
    try {
      version = execFileSync(
        fileURLToPath(new URL("../scripts/gitcalver.sh", import.meta.url)),
        ["--dirty", "-dev"],
        { encoding: "utf8" },
      ).trim();
    } catch {
      /* version stays "unknown" */
    }
  }
  return version;
}

export async function startBridge(
  config: Config,
  version: string,
  credentials?: MQTTCredentials,
): Promise<BridgeHandle> {
  checkCredentials(config.mqtt, credentials);
  assertMQTTURL(config.mqtt.url);
  const stateCache = new Map<string, RawState>();
  const lastColorPublish = new Map<string, number>();
  const pendingGetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let heatedBedding: HeatedBeddingMQTT | undefined;
  let curtains: CurtainMQTT | undefined;
  const curtainAccessories: CurtainAccessory[] = [];
  const heatedBeddingAccessories: HeatedBeddingAccessories[] = [];

  function cancelAllRetries(): void {
    for (const timer of pendingGetTimers.values()) {
      clearTimeout(timer);
    }
    pendingGetTimers.clear();
  }

  function publishGet(device: Config["devices"][number]): void {
    prePublishCheck().publish(
      `${device.topic}/get`,
      JSON.stringify({ state: "" }),
    );
    metrics?.z2mGetRequestsTotal.inc();
    metrics?.mqttMessagesPublished.inc();
  }

  function scheduleGetRetry(
    device: Config["devices"][number],
    attempt: number,
  ): void {
    const baseDelay =
      attempt === 0
        ? 0
        : Math.min(
            GET_RETRY_INITIAL_MS * Math.SQRT2 ** (attempt - 1),
            GET_RETRY_MAX_MS,
          );
    const jitter =
      Math.random() *
      GET_JITTER_FRACTION *
      Math.max(baseDelay, GET_RETRY_INITIAL_MS);
    const delay = baseDelay + jitter;
    const timer = setTimeout(() => {
      if (stateCache.has(device.topic) || !mqttClient?.connected) return;
      publishGet(device);
      scheduleGetRetry(device, attempt + 1);
    }, delay);
    pendingGetTimers.set(device.topic, timer);
  }

  let metrics: Metrics | undefined;
  let metricsServer: MetricsServer | undefined;
  let metricsRegister: Registry | undefined;
  const hapConnections = new Map<EventEmitter, HapConnection>();
  if (config.metrics) {
    metricsRegister = new Registry();
    metrics = createMetrics(metricsRegister);
  }

  const displayURL = displayMQTTURL(config.mqtt.url);
  if (config.devices.length) log.log(`Connecting to MQTT at ${displayURL}`);

  const mqttClient = config.devices.length
    ? withoutErrorMessage(() =>
        connect(config.mqtt.url, {
          ...(credentials && credentialOptions(credentials)),
          reconnectPeriod: MIN_BACKOFF,
          // mqtt.js stops reconnecting after the broker refuses a login unless
          // reconnectOnConnackError is set; with it, a corrected broker user
          // list recovers without a restart.
          reconnectOnConnackError: true,
          // mqtt.js resubscribes before the connect handler runs and discards
          // the result, which would hide a denial after a reconnect.
          resubscribe: false,
        }),
      )
    : undefined;

  function mqttConnected(): boolean {
    return (
      (config.devices.length === 0 || mqttClient?.connected === true) &&
      (heatedBedding?.connected ?? (config.heatedBedding?.length ?? 0) === 0) &&
      (curtains?.connected ?? (config.curtains?.length ?? 0) === 0)
    );
  }

  function updateMetrics(): void {
    metrics?.mqttConnected.set(mqttConnected() ? 1 : 0);
    let unknown = config.devices.filter(
      (device) => !stateCache.has(device.topic),
    ).length;
    for (const entry of config.heatedBedding ?? []) {
      if (
        heatedBeddingTopics(entry).some(
          (topic) => heatedBedding?.source.usableState(topic) === undefined,
        )
      )
        unknown++;
    }
    for (const curtain of config.curtains ?? []) {
      if (!curtains?.source.usableState(tucsonTopic(curtain))) unknown++;
    }
    metrics?.devicesStateUnknown.set(unknown);
    metricsServer?.notifyStateChange();
  }

  mqttClient?.on("error", (err) => {
    log.error(`MQTT error: ${err.message}`);
    metrics?.mqttErrors.inc();
  });

  mqttClient?.on("close", () => {
    log.log("MQTT connection closed");
    clearTimeout(stableTimer);
    cancelAllRetries();
    metrics?.mqttConnected.set(0);
    metricsServer?.notifyStateChange();
  });

  // mqtt.js emits reconnect once per attempt however the previous one failed,
  // so doubling here counts each failure once.
  mqttClient?.on("reconnect", () => {
    log.log("MQTT reconnecting");
    mqttClient.options.reconnectPeriod = Math.min(
      MAX_BACKOFF,
      (mqttClient.options.reconnectPeriod ?? MIN_BACKOFF) * 2,
    );
  });

  mqttClient?.on("offline", () => {
    log.log("MQTT client offline");
    cancelAllRetries();
    metrics?.mqttConnected.set(0);
    metricsServer?.notifyStateChange();
  });

  const prePublishCheck = () => {
    if (!mqttClient?.connected) {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return mqttClient;
  };

  const rawPublish = (mqttTopic: string, message: string) => {
    prePublishCheck().publish(mqttTopic, message);
    metrics?.mqttMessagesPublished.inc();
  };

  function makePublish(
    convert: (
      p: Record<string, unknown>,
      raw?: RawState,
    ) => Record<string, unknown>,
    mqttTopic: (topic: string) => string,
  ): PublishFn {
    return (topic, payload) => {
      rawPublish(
        mqttTopic(topic),
        JSON.stringify(convert(payload, stateCache.get(topic))),
      );
      if (
        "hue" in payload ||
        "saturation" in payload ||
        "color_temp" in payload
      ) {
        lastColorPublish.set(topic, Date.now());
      }
    };
  }

  const protocols = {
    z2m: {
      publish: makePublish(homeKitToZ2m, (t) => `${t}/set`),
      toHomeKit: z2mToHomeKit,
    },
    wled: {
      publish: makePublish(homeKitToWled, (t) => `${t}/api`),
      toHomeKit: wledToHomeKit,
    },
  };

  const scenePublish = makePublish(
    (p) => p,
    (t) => `${t}/set`,
  );

  if (metricsRegister && config.metrics) {
    const getStatus = () =>
      buildStatusData(
        config,
        stateCache,
        { url: displayURL, connected: mqttConnected() },
        [...hapConnections.values()],
        version,
        heatedBedding?.source,
        curtains?.source,
      );
    metricsServer = startMetricsServer(
      config.metrics.port,
      metricsRegister,
      // The metrics/status endpoint is meant to be scraped across the pod or
      // host network, so bind all interfaces unless an operator pins an address.
      config.metrics.bind ?? "0.0.0.0",
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

  interface AccessoryEntry {
    accessory: Accessory;
    device: Config["devices"][number];
    updateState: typeof updateAccessoryState;
  }
  const accessoryMap = new Map<string, AccessoryEntry>();
  const wledTopicMap = new Map<string, { device: string; sub: string }>();

  log.log(
    `Configuring bridge "${config.bridge.name}" with ${String(config.devices.length)} device(s)`,
  );

  for (const device of config.devices) {
    log.log(
      `  Adding device "${device.name}" (type: ${device.type}, topic: ${device.topic}, capabilities: ${device.capabilities.join(", ")})`,
    );
    const proto = protocols[device.type];
    const getState = (topic: string) => {
      const raw = stateCache.get(topic);
      if (!raw) return;
      return proto.toHomeKit(raw);
    };

    const isFan = device.capabilities.includes("fan");
    const accessory = isFan
      ? createFanAccessory(device, proto.publish, getState, prePublishCheck)
      : createLightAccessory(device, proto.publish, getState, prePublishCheck);
    setAccessoryInfo(accessory, "Hoboken", device.topic, device.topic, version);
    bridge.addBridgedAccessory(accessory);
    accessoryMap.set(device.topic, {
      accessory,
      device,
      updateState: isFan ? updateFanAccessoryState : updateAccessoryState,
    });
    switch (device.type) {
      case "z2m":
        break;
      case "wled":
        wledTopicMap.set(`${device.topic}/g`, {
          device: device.topic,
          sub: "g",
        });
        wledTopicMap.set(`${device.topic}/c`, {
          device: device.topic,
          sub: "c",
        });
        break;
    }

    if (device.scenes) {
      for (const scene of device.scenes) {
        const sceneAccessory = createSceneAccessory(
          device,
          scene,
          scenePublish,
        );
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

  if (config.heatedBedding?.length) {
    const zones = heatedBeddingZoneConfigs(config.heatedBedding);
    const zoneTopics = new Map(
      zones.flatMap((zone) => {
        const topic = tucsonTopic(zone);
        return [
          [topic, topic],
          [`${topic}/result`, topic],
        ];
      }),
    );
    heatedBedding = new HeatedBeddingMQTT(config.mqtt.url, zones, {
      credentials,
      changed: () => {
        for (const accessories of heatedBeddingAccessories)
          accessories.update();
        updateMetrics();
      },
      received: (topic) => {
        const zone = zoneTopics.get(topic);
        if (zone) metrics?.mqttMessagesReceived.labels(zone).inc();
      },
      published: () => {
        metrics?.mqttMessagesPublished.inc();
      },
      failed: () => {
        metrics?.mqttErrors.inc();
      },
    });
    for (const entry of config.heatedBedding) {
      const accessories = createHeatedBeddingAccessories(
        entry,
        heatedBedding.source,
      );
      for (const [accessory, kind] of [
        [accessories.fan, "Heated Bedding Fan"],
        [accessories.preheat, "Heated Bedding Preheat"],
      ] as const) {
        setAccessoryInfo(
          accessory,
          "Hoboken",
          kind,
          `${heatedBeddingIdentity(entry)}/${kind}`,
          version,
        );
        bridge.addBridgedAccessory(accessory);
      }
      heatedBeddingAccessories.push(accessories);
    }
  }

  if (config.curtains?.length) {
    const topics = new Map(
      config.curtains.flatMap((curtain) => {
        const topic = tucsonTopic(curtain);
        return [
          [topic, topic],
          [`${topic}/result`, topic],
        ];
      }),
    );
    curtains = new CurtainMQTT(config.mqtt.url, config.curtains, {
      credentials,
      changed: () => {
        for (const accessory of curtainAccessories) accessory.update();
        updateMetrics();
      },
      received: (topic) => {
        const curtain = topics.get(topic);
        if (curtain) metrics?.mqttMessagesReceived.labels(curtain).inc();
      },
      published: () => {
        metrics?.mqttMessagesPublished.inc();
      },
      failed: () => {
        metrics?.mqttErrors.inc();
      },
    });
    for (const configCurtain of config.curtains) {
      const curtain = createCurtainAccessory(configCurtain, curtains.source);
      setAccessoryInfo(
        curtain.accessory,
        "Hoboken",
        "Curtain",
        `${curtainIdentity(configCurtain)}/curtain`,
        version,
      );
      bridge.addBridgedAccessory(curtain.accessory);
      curtainAccessories.push(curtain);
    }
  }
  metrics?.devicesConfigured.set(
    config.devices.length +
      (config.heatedBedding?.length ?? 0) +
      (config.curtains?.length ?? 0),
  );
  updateMetrics();

  mqttClient?.on("connect", () => {
    log.log("MQTT connected");
    // A broker that accepts the login and then drops the session keeps backing
    // off unless the connection outlasts the longest delay.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      mqttClient.options.reconnectPeriod = MIN_BACKOFF;
    }, MAX_BACKOFF);
    stableTimer.unref();
    cancelAllRetries();
    const topics = config.devices.flatMap((d) => {
      switch (d.type) {
        case "z2m":
          return [d.topic];
        case "wled":
          return [`${d.topic}/g`, `${d.topic}/c`];
      }
    });
    mqttClient.subscribe(topics, (error, grants = [], packet) => {
      const denied = deniedTopics(grants, packet?.granted);
      if (!error && denied.length === 0) return;
      const refused = denied.length > 0;
      const reason = error ? `: ${error.message}` : "";
      log.error(
        `MQTT subscription ${refused ? "refused" : "failed"} for ${(refused ? denied : topics).join(", ")}${reason}`,
      );
      metrics?.mqttErrors.inc();
    });

    updateMetrics();

    for (const device of config.devices) {
      switch (device.type) {
        case "z2m":
          if (stateCache.has(device.topic)) {
            publishGet(device);
          } else {
            scheduleGetRetry(device, 0);
          }
          break;
        case "wled":
          break;
      }
    }
  });

  function handleStateUpdate(
    deviceTopic: string,
    rawPartial: RawState,
    entry: AccessoryEntry,
  ): void {
    log.log(
      `State update for "${entry.device.name}": ${JSON.stringify(rawPartial)}`,
    );
    const merged = { ...stateCache.get(deviceTopic), ...rawPartial };
    stateCache.set(deviceTopic, merged);
    updateMetrics();
    const pendingTimer = pendingGetTimers.get(deviceTopic);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      pendingGetTimers.delete(deviceTopic);
    }

    const lastPub = lastColorPublish.get(deviceTopic);
    const suppressing =
      lastPub !== undefined && Date.now() - lastPub < WRITE_BACK_SUPPRESSION_MS;
    const hkState = protocols[entry.device.type].toHomeKit(rawPartial);
    if (suppressing) {
      delete hkState.hue;
      delete hkState.saturation;
      delete hkState.color_temp;
    }
    if (Object.keys(hkState).length > 0) {
      entry.updateState(entry.accessory, hkState, entry.device.capabilities);
    }
  }

  mqttClient?.on("message", (topic, payload) => {
    // Try WLED sub-topic lookup first.
    const wled = wledTopicMap.get(topic);
    if (wled !== undefined) {
      const entry = accessoryMap.get(wled.device);
      if (!entry) return;
      metrics?.mqttMessagesReceived.labels(wled.device).inc();
      const wledState = parseWledMessage(wled.sub, payload.toString());
      if (!wledState) return;
      handleStateUpdate(wled.device, wledState, entry);
      return;
    }

    // Z2M message handling
    const entry = accessoryMap.get(topic);
    if (!entry) return;
    metrics?.mqttMessagesReceived.labels(topic).inc();
    let state: RawState;
    try {
      state = JSON.parse(payload.toString()) as RawState;
    } catch {
      return;
    }
    handleStateUpdate(topic, state, entry);
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

  const hapPortPromise = new Promise<number>((resolve) => {
    bridge.once("listening", (port: number) => {
      resolve(port);
    });
  });

  await bridge.publish({
    username: config.bridge.mac,
    pincode: config.bridge.pincode,
    port: config.bridge.port,
    category: Categories.BRIDGE,
    ...(config.bridge.bind ? { bind: config.bridge.bind } : {}),
  });

  const hapPort = await hapPortPromise;

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
      // Only decrement when we actually counted this connection on
      // connection-opened. A connection that opened in the window between the
      // HAP server starting to listen and this listener being attached is not
      // tracked, and decrementing for it would drive the gauge negative.
      if (!hapConnections.delete(connection)) {
        return;
      }

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
    hapPort,
    ...(metricsPort === undefined ? {} : { metricsPort }),
    shutdown: async () => {
      cancelAllRetries();
      let tucsonFailure: { error: unknown } | undefined;
      try {
        const stopped = await Promise.allSettled([
          heatedBedding?.stop(),
          curtains?.stop(),
        ]);
        const failures = stopped.filter(
          (result) => result.status === "rejected",
        );
        const firstFailure = failures[0];
        if (firstFailure)
          throw failures.length === 1
            ? firstFailure.reason
            : new AggregateError(
                failures.map((failure): unknown => failure.reason),
                "Tucson MQTT shutdown failed",
              );
      } catch (error: unknown) {
        tucsonFailure = { error };
      }
      log.log("Shutting down: unpublishing bridge (sending mDNS goodbye)");
      await bridge.unpublish();
      log.log("Shutting down: closing MQTT connection");
      if (mqttClient) {
        await new Promise<void>((resolve) => {
          mqttClient.end(false, () => {
            resolve();
          });
        });
        clearTimeout(stableTimer);
      }
      const ms = metricsServer;
      if (ms) {
        log.log("Shutting down: stopping metrics server");
        await ms.close();
      }
      metrics?.dispose();
      if (tucsonFailure) throw tucsonFailure.error;
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
