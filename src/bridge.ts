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

import { createVacuumAccessory } from "./vacuum-accessory.ts";
import { vacuumStatus, vacuumTopics } from "./vacuum-profile.ts";
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
  type DeviceConfig,
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
  type AdaptiveRequest,
  showsColor,
  shouldPublishAdaptiveTemperature,
  zigbeeOffTemperatureMessage,
  fadeTemperature,
  withAdaptiveTemperature,
} from "./adaptive-lighting.ts";
import {
  BRIGHTNESS_SETTLE_MS,
  decideBrightnessHold,
} from "./brightness-hold.ts";
import {
  changedGroups,
  CONFIRMATION_MS,
  expireWrites,
  groupValues,
  nextDeadline,
  overlayOf,
  recordWrite,
  settleReport,
  type Unconfirmed,
  withoutWritten,
  writtenGroups,
} from "./write-confirmation.ts";
import {
  adaptiveLightingController,
  createFanAccessory,
  createLightAccessory,
  createSceneAccessory,
  updateAccessoryState,
  updateFanAccessoryState,
} from "./accessories.ts";
import type { PublishFn } from "./accessories.ts";
import {
  type HomeKitState,
  type RawState,
  clampColorTemp,
  homeKitToWled,
  homeKitToZ2m,
  parseWledMessage,
  wledToHomeKit,
  wledWrite,
  z2mToHomeKit,
  z2mWriteToHomeKit,
} from "./convert.ts";
import { createMetrics, startMetricsServer } from "./metrics.ts";
import type {
  HapConnection,
  HeatedBeddingZoneStatus,
  Metrics,
  MetricsServer,
  StatusData,
} from "./metrics.ts";

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
  vacuumReports: ReadonlyMap<string, string> = new Map(),
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
      ...(d.whiteChannels ? { light: d } : {}),
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
    ...(config.vacuums?.length
      ? {
          vacuums: config.vacuums.map((config) =>
            vacuumStatus(config, vacuumReports),
          ),
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
  const adaptiveTemperatures = new Map<string, number>();
  const adaptiveRequests = new Map<string, AdaptiveRequest>();
  const offTemperatures = new Map<string, number>();
  const unconfirmedWrites = new Map<string, Unconfirmed>();
  const confirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const heldBrightness = new Map<
    string,
    { brightness: number; timer: ReturnType<typeof setTimeout> }
  >();
  const recentlyWritten = (topic: string): HomeKitState =>
    overlayOf(unconfirmedWrites.get(topic) ?? {});
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

  const vacuums = config.vacuums ?? [];
  const vacuumReports = new Map<string, string>();
  const vacuumRoutes = new Map<
    string,
    { label: string; updates: (() => void)[] }
  >();
  const vacuumAccessories: ReturnType<typeof createVacuumAccessory>[] = [];
  const pendingVacuumSends = new Set<(error: Error) => void>();

  const useSharedClient = config.devices.length + vacuums.length > 0;
  const displayURL = displayMQTTURL(config.mqtt.url);
  if (useSharedClient) log.log(`Connecting to MQTT at ${displayURL}`);

  const mqttClient = useSharedClient
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
      (!useSharedClient || mqttClient?.connected === true) &&
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
    for (const config of vacuums) {
      if (vacuumStatus(config, vacuumReports).on === undefined) unknown++;
    }
    metrics?.devicesStateUnknown.set(unknown);
    metricsServer?.notifyStateChange();
  }

  mqttClient?.on("error", (err) => {
    log.error(`MQTT error: ${err.message}`);
    metrics?.mqttErrors.inc();
  });

  function disconnected(): void {
    // MQTT.js can wait for drain to finish a QoS 0 publish. A closed stream never drains.
    for (const reject of pendingVacuumSends)
      reject(new Error("MQTT disconnected"));
    vacuumReports.clear();
    for (const vacuum of vacuumAccessories) vacuum.update();
    cancelAllRetries();
    updateMetrics();
  }

  mqttClient?.on("close", () => {
    log.log("MQTT connection closed");
    clearTimeout(stableTimer);
    disconnected();
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
    disconnected();
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

  function setUnconfirmed(topic: string, pending: Unconfirmed): void {
    unconfirmedWrites.set(topic, pending);
    clearTimeout(confirmationTimers.get(topic));
    const deadline = nextDeadline(pending);
    if (deadline === undefined) return;
    const timer = setTimeout(() => {
      giveUpOnWrites(topic);
    }, deadline - Date.now());
    timer.unref();
    confirmationTimers.set(topic, timer);
  }

  // A write that no report has shown by its deadline had no effect, so HomeKit
  // takes the device's state back.
  function giveUpOnWrites(topic: string): void {
    const { expired, pending } = expireWrites(
      unconfirmedWrites.get(topic) ?? {},
      Date.now(),
    );
    setUnconfirmed(topic, pending);
    const entry = accessoryMap.get(topic);
    const raw = stateCache.get(topic);
    if (!entry || !raw) return;
    const values = groupValues(
      protocols[entry.device.type].toHomeKit(raw, raw, entry.device),
      expired,
    );
    const changed = changedGroups(
      expired,
      values.color_temp === undefined
        ? values
        : { ...values, color_temp: clampColorTemp(values.color_temp) },
      shownState(entry),
    );
    if (changed.length > 0) {
      log.log(
        `No report confirmed the ${changed.join(", ")} written to "${entry.device.name}" within ${String(CONFIRMATION_MS)} ms; HomeKit shows the reported state`,
      );
    }
    applyToHomeKit(entry, values, false);
  }

  // Only the characteristics that the light has: getCharacteristic adds the
  // others.
  function shownState(entry: AccessoryEntry): HomeKitState {
    const service = entry.accessory.getService(Service.Lightbulb);
    const shown: HomeKitState = {};
    if (!service) return shown;
    const read = (type: typeof Characteristic.On) =>
      service.testCharacteristic(type)
        ? service.getCharacteristic(type).value
        : undefined;
    const on = read(Characteristic.On);
    if (typeof on === "boolean") shown.on = on;
    for (const [key, type] of [
      ["brightness", Characteristic.Brightness],
      ["hue", Characteristic.Hue],
      ["saturation", Characteristic.Saturation],
      ["color_temp", Characteristic.ColorTemperature],
    ] as const) {
      const value = read(type);
      if (typeof value === "number") shown[key] = value;
    }
    return shown;
  }

  function dropHeldBrightness(topic: string): void {
    clearTimeout(heldBrightness.get(topic)?.timer);
    heldBrightness.delete(topic);
  }

  function holdBrightness(entry: AccessoryEntry, brightness: number): void {
    const topic = entry.device.topic;
    dropHeldBrightness(topic);
    const timer = setTimeout(() => {
      heldBrightness.delete(topic);
      applyToHomeKit(entry, { brightness }, true);
    }, BRIGHTNESS_SETTLE_MS);
    timer.unref();
    heldBrightness.set(topic, { brightness, timer });
  }

  // A Zigbee2MQTT light's brightness reaches HomeKit once it has stood, so the
  // values that a group passes through before settling never show.
  function withHeldBrightness(
    entry: AccessoryEntry,
    applied: HomeKitState,
    first: boolean,
  ): HomeKitState {
    const topic = entry.device.topic;
    const { brightness, ...rest } = applied;
    if (
      entry.device.type !== "z2m" ||
      brightness === undefined ||
      !entry.device.capabilities.includes("brightness")
    )
      return applied;
    const decision = decideBrightnessHold({
      brightness,
      shown: shownState(entry).brightness,
      held: heldBrightness.get(topic)?.brightness,
      first,
    });
    if (decision === "keep") return rest;
    if (decision === "hold") {
      holdBrightness(entry, brightness);
      return rest;
    }
    dropHeldBrightness(topic);
    return applied;
  }

  function publishRememberedTemperature(entry: AccessoryEntry): void {
    const topic = entry.device.topic;
    const temperature = adaptiveTemperatures.get(topic);
    if (
      temperature === undefined ||
      adaptiveLightingController(
        entry.accessory,
      )?.isAdaptiveLightingActive() !== true ||
      !entry.acceptsAdaptiveTemperature(temperature)
    )
      return;
    entry.publish(topic, { color_temp: temperature }, "adaptive-lighting-now");
  }

  // `outside` is whether the state is a report of something that HomeKit did
  // not write: a write that is undone turns no light on.
  function applyToHomeKit(
    entry: AccessoryEntry,
    hkState: HomeKitState,
    outside: boolean,
  ): void {
    if (showsColor(hkState, entry.device))
      disableAdaptiveLighting(entry, "the light shows a color");
    const adaptive =
      adaptiveLightingController(
        entry.accessory,
      )?.isAdaptiveLightingActive() === true;
    const service = adaptive
      ? entry.accessory.getService(Service.Lightbulb)
      : undefined;
    const on = service?.getCharacteristic(Characteristic.On);
    const wasOn = on?.value;
    if (Object.keys(hkState).length > 0) {
      entry.updateState(entry.accessory, hkState, entry.device.capabilities);
    }
    // A turn-on that HomeKit wrote has the characteristic on already; a light
    // turned on elsewhere is not at the temperature it was left at.
    if (outside && on && wasOn !== true && on.value === true)
      publishRememberedTemperature(entry);
  }

  function makePublish(
    device: DeviceConfig,
    convert: (
      p: Record<string, unknown>,
      raw?: RawState,
    ) => Record<string, unknown>,
    mqttTopic: (topic: string) => string,
    follow?: (converted: Record<string, unknown>) => {
      homeKit: HomeKitState;
      raw?: RawState;
    },
    fade?: (converted: Record<string, unknown>) => Record<string, unknown>,
  ): PublishFn {
    return (topic, written, source) => {
      const entry = accessoryMap.get(topic);
      const adaptiveController =
        entry && adaptiveLightingController(entry.accessory);
      const cachedRaw = stateCache.get(topic);
      const adaptive = adaptiveController?.isAdaptiveLightingActive() === true;
      const reported =
        adaptive && cachedRaw
          ? protocols[device.type].toHomeKit(cachedRaw, cachedRaw, device)
          : undefined;
      const payload = withAdaptiveTemperature(
        written,
        adaptiveTemperatures.get(topic),
        adaptive,
        adaptive ? { ...reported, ...recentlyWritten(topic) } : {},
      );
      offTemperatures.delete(topic);
      const converted = convert(payload, cachedRaw);
      // A light that has not yet reported that it is on was turned on by a
      // write a moment ago, and takes its temperature at once.
      const message = JSON.stringify(
        fade && source === "adaptive-lighting" && reported?.on === true
          ? fade(converted)
          : converted,
      );
      rawPublish(mqttTopic(topic), message);
      const origin = source
        ? `Adaptive Lighting for "${device.name}"`
        : `HomeKit write for "${device.name}"`;
      log.log(
        `${origin}: ${JSON.stringify(written)}${payload === written ? "" : " with the temperature of Adaptive Lighting"} published to ${mqttTopic(topic)} as ${message}`,
      );
      // What the light showed for a temperature that Adaptive Lighting asked
      // for says nothing once HomeKit has set its color or temperature.
      if (
        !source &&
        ("hue" in payload || "saturation" in payload || "color_temp" in payload)
      )
        adaptiveRequests.delete(topic);
      if ("brightness" in payload) dropHeldBrightness(topic);
      setUnconfirmed(
        topic,
        recordWrite(unconfirmedWrites.get(topic) ?? {}, payload, Date.now()),
      );
      if (!follow || !entry) return;
      const { homeKit, raw } = follow(converted);
      const cached = stateCache.get(topic);
      if (raw && cached) stateCache.set(topic, { ...cached, ...raw });
      // The controller's own values stand for what it wrote: a white is
      // published as a temperature, but the write was a hue and saturation.
      const state = Object.fromEntries(
        Object.entries(homeKit).filter(([key]) => !(key in payload)),
      );
      entry.updateState(entry.accessory, state, device.capabilities);
    };
  }

  const z2mSetTopic = (topic: string) => `${topic}/set`;
  const protocols = {
    z2m: {
      publish: (device: DeviceConfig) =>
        makePublish(
          device,
          (p, raw) => homeKitToZ2m(p, raw, device),
          z2mSetTopic,
          (message) => ({ homeKit: z2mWriteToHomeKit(message) }),
          fadeTemperature,
        ),
      toHomeKit: (raw: RawState, merged: RawState, device: DeviceConfig) =>
        z2mToHomeKit(raw, merged, device.capabilities),
    },
    wled: {
      publish: (device: DeviceConfig) =>
        makePublish(
          device,
          (p, raw) => homeKitToWled(p, raw, device),
          (t) => `${t}/api`,
          (message) => {
            const state = wledWrite(message, device);
            return state
              ? {
                  homeKit: wledToHomeKit(state, state, device),
                  raw: { white: state.white },
                }
              : { homeKit: {} };
          },
        ),
      toHomeKit: wledToHomeKit,
    },
  };

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
        vacuumReports,
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
    publish: PublishFn;
    acceptsAdaptiveTemperature: (temperature: number) => boolean;
  }
  const accessoryMap = new Map<string, AccessoryEntry>();

  function disableAdaptiveLighting(
    entry: AccessoryEntry,
    reason: string,
  ): void {
    const adaptive = adaptiveLightingController(entry.accessory);
    if (adaptive?.isAdaptiveLightingActive() !== true) return;
    log.log(`Adaptive Lighting off for "${entry.device.name}": ${reason}`);
    adaptive.disableAdaptiveLighting();
  }
  const wledTopicMap = new Map<string, { device: string; sub: string }>();

  const deviceCount =
    config.devices.length +
    vacuums.length +
    (config.heatedBedding?.length ?? 0) +
    (config.curtains?.length ?? 0);
  log.log(
    `Configuring bridge "${config.bridge.name}" with ${String(deviceCount)} device(s)`,
  );

  for (const device of config.devices) {
    log.log(
      `  Adding device "${device.name}" (type: ${device.type}, topic: ${device.topic}, capabilities: ${device.capabilities.join(", ")})`,
    );
    const proto = protocols[device.type];
    const publish = proto.publish(device);
    const getState = (topic: string) => {
      const raw = stateCache.get(topic);
      if (!raw) return;
      const state = withoutWritten(
        proto.toHomeKit(raw, raw, device),
        unconfirmedWrites.get(topic) ?? {},
      );
      if (heldBrightness.has(topic)) delete state.brightness;
      return state;
    };

    const acceptsAdaptiveTemperature = (temperature: number) => {
      if (mqttClient?.connected !== true) return false;
      const reported = getState(device.topic);
      const state = { ...reported, ...recentlyWritten(device.topic) };
      // A light that reports the temperature has taken it, so a later change
      // to what it shows is a new one to correct.
      if (reported?.color_temp === temperature)
        adaptiveRequests.delete(device.topic);
      const last = adaptiveRequests.get(device.topic);
      if (
        !shouldPublishAdaptiveTemperature(
          state,
          temperature,
          last,
          device.type === "wled",
        )
      )
        return false;
      adaptiveRequests.set(device.topic, {
        temperature,
        shown: last?.temperature === temperature ? state.color_temp : undefined,
      });
      return true;
    };
    const publishTemperatureWhileOff = (temperature: number) => {
      if (
        device.type !== "z2m" ||
        mqttClient?.connected !== true ||
        offTemperatures.get(device.topic) === temperature ||
        { ...getState(device.topic), ...recentlyWritten(device.topic) }.on !==
          false
      )
        return;
      const message = JSON.stringify(zigbeeOffTemperatureMessage(temperature));
      rawPublish(z2mSetTopic(device.topic), message);
      offTemperatures.set(device.topic, temperature);
      log.log(
        `Adaptive Lighting for "${device.name}" while off: ${JSON.stringify({ color_temp: temperature })} published to ${z2mSetTopic(device.topic)} as ${message}`,
      );
    };
    const adaptiveTemperature = (temperature: number) => {
      adaptiveTemperatures.set(device.topic, temperature);
      const accepted = acceptsAdaptiveTemperature(temperature);
      publishTemperatureWhileOff(temperature);
      return accepted;
    };

    const isFan = device.capabilities.includes("fan");
    const accessory = isFan
      ? createFanAccessory(device, publish, getState, prePublishCheck)
      : createLightAccessory(
          device,
          publish,
          getState,
          prePublishCheck,
          adaptiveTemperature,
        );
    setAccessoryInfo(accessory, "Hoboken", device.topic, device.topic, version);
    bridge.addBridgedAccessory(accessory);
    const entry: AccessoryEntry = {
      accessory,
      device,
      updateState: isFan ? updateFanAccessoryState : updateAccessoryState,
      publish,
      acceptsAdaptiveTemperature,
    };
    accessoryMap.set(device.topic, entry);
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
      const publishScene = makePublish(device, (p) => p, z2mSetTopic);
      const scenePublish: PublishFn = (topic, payload, source) => {
        publishScene(topic, payload, source);
        disableAdaptiveLighting(entry, "a scene was recalled");
      };
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
  const publishVacuumCommand = async (topic: string, command: string) => {
    const client = prePublishCheck();
    const closed = Promise.withResolvers<never>();
    pendingVacuumSends.add(closed.reject);
    try {
      await Promise.race([
        client.publishAsync(topic, command, { qos: 0, retain: false }),
        closed.promise,
      ]);
    } catch {
      metrics?.mqttErrors.inc();
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      pendingVacuumSends.delete(closed.reject);
    }
    metrics?.mqttMessagesPublished.inc();
  };
  for (const config of vacuums) {
    const topics = vacuumTopics(config);
    const vacuum = createVacuumAccessory(
      config,
      () => vacuumStatus(config, vacuumReports).on,
      publishVacuumCommand,
    );
    setAccessoryInfo(
      vacuum.accessory,
      "Rockville",
      "Vacuum",
      topics.base,
      version,
    );
    bridge.addBridgedAccessory(vacuum.accessory);
    vacuumAccessories.push(vacuum);
    for (const topic of [
      topics.state,
      topics.availability,
      topics.bridgeAvailability,
    ]) {
      const route = vacuumRoutes.get(topic) ?? {
        label: topic === topics.bridgeAvailability ? topic : topics.base,
        updates: [],
      };
      route.updates.push(vacuum.update);
      vacuumRoutes.set(topic, route);
    }
  }
  metrics?.devicesConfigured.set(deviceCount);
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
    topics.push(...vacuumRoutes.keys());
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
    const previousRaw = stateCache.get(deviceTopic);
    const merged = { ...previousRaw, ...rawPartial };
    stateCache.set(deviceTopic, merged);
    updateMetrics();
    const pendingTimer = pendingGetTimers.get(deviceTopic);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      pendingGetTimers.delete(deviceTopic);
    }

    const protocol = protocols[entry.device.type];
    const before = unconfirmedWrites.get(deviceTopic) ?? {};
    const previous =
      previousRaw && protocol.toHomeKit(previousRaw, previousRaw, entry.device);
    const { applied, pending } = settleReport(
      before,
      protocol.toHomeKit(rawPartial, merged, entry.device),
      previous,
    );
    setUnconfirmed(deviceTopic, pending);
    if (applied.on === true) offTemperatures.delete(deviceTopic);
    const awaited = writtenGroups(before);
    applyToHomeKit(
      entry,
      withHeldBrightness(entry, applied, previous?.brightness === undefined),
      !awaited.includes("power") && !awaited.includes("brightness"),
    );
  }

  mqttClient?.on("message", (topic, payload) => {
    const vacuumRoute = vacuumRoutes.get(topic);
    if (vacuumRoute) {
      metrics?.mqttMessagesReceived.labels(vacuumRoute.label).inc();
      vacuumReports.set(topic, payload.toString());
      for (const update of vacuumRoute.updates) update();
      updateMetrics();
      return;
    }
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

    // HAP-NodeJS refuses a value outside a characteristic's range before any
    // onSet handler runs, so only the request shows what a controller sent.
    server.on("set-characteristics", (connection, request) => {
      const accessories = [bridge, ...bridge.bridgedAccessories];
      const writes = request.characteristics
        .filter((write) => write.value !== undefined)
        .map(({ aid, iid, value }) => {
          const accessory = accessories.find((a) => a.aid === aid);
          const characteristic = accessory?.services
            .flatMap((service) => service.characteristics)
            .find((c) => c.iid === iid);
          const target =
            accessory && characteristic
              ? `"${accessory.displayName}" ${characteristic.displayName}`
              : `${String(aid)}.${String(iid)}`;
          return `${target}=${JSON.stringify(value)}`;
        });
      if (writes.length > 0) {
        log.log(
          `HAP write from ${connection.remoteAddress}: ${writes.join(", ")}`,
        );
      }
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
      for (const timer of [
        ...confirmationTimers.values(),
        ...[...heldBrightness.values()].map(({ timer }) => timer),
      ])
        clearTimeout(timer);
      confirmationTimers.clear();
      heldBrightness.clear();
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
