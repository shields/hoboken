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

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { tucsonTopic } from "./tucson-profile.ts";
import type { CurtainConfig } from "./curtain-source.ts";
import type { HeatedBeddingZoneConfig } from "./heated-bedding-source.ts";

export type Capability =
  "on_off" | "brightness" | "color_temp" | "color_hs" | "fan" | "fan_speed";
export type DeviceType = "z2m" | "wled";

const VALID_CAPABILITIES = new Set<Capability>([
  "on_off",
  "brightness",
  "color_temp",
  "color_hs",
  "fan",
  "fan_speed",
]);

const LIGHT_CAPABILITIES = new Set<Capability>([
  "on_off",
  "brightness",
  "color_temp",
  "color_hs",
]);

const FAN_CAPABILITIES = new Set<Capability>(["fan", "fan_speed"]);

const VALID_DEVICE_TYPES = new Set<DeviceType>(["z2m", "wled"]);

export interface SceneConfig {
  name: string;
  id: number;
}

export interface DeviceConfig {
  name: string;
  type: DeviceType;
  topic: string;
  capabilities: Capability[];
  scenes?: SceneConfig[];
}

export interface BridgeConfig {
  name: string;
  mac: string;
  pincode: string;
  port: number;
  bind?: string;
}

export interface MqttConfig {
  url: string;
  username?: string;
  passwordFile?: string;
}

export interface MQTTCredentials {
  username: string;
  password: string;
}

export interface MetricsConfig {
  port: number;
  bind?: string;
}

export interface Config {
  bridge: BridgeConfig;
  mqtt: MqttConfig;
  devices: DeviceConfig[];
  heatedBedding?: HeatedBeddingZoneConfig[];
  curtains?: CurtainConfig[];
  metrics?: MetricsConfig;
}

// An MQTT string, such as the username or password in a CONNECT packet, carries
// a two-byte length.
const MQTT_STRING_MAX_BYTES = 65535;
const MQTT_FIELDS = new Set(["url", "username", "passwordFile"]);
const MAC_RE = /^[\dA-Fa-f]{2}(:[\dA-Fa-f]{2}){5}$/;
const PIN_RE = /^\d{3}-\d{2}-\d{3}$/;
// Userinfo as url.parse, which mqtt.js uses, finds it: after a scheme or
// leading slashes, with backslashes as slashes and the "//" optional. The
// capture group is the text before the userinfo.
const MQTT_URL_USERINFO_RE = /^((?:[^/\\?#:]+:[/\\]{0,2}|[/\\]{2}))[^/\\?#]+@/;

export function validateConfig(data: unknown): Config {
  if (typeof data !== "object" || data === null) {
    throw new Error("Config must be an object");
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.bridge !== "object" || obj.bridge === null) {
    throw new Error("Missing required field: bridge");
  }

  const bridge = obj.bridge as Record<string, unknown>;

  if (typeof bridge.name !== "string" || bridge.name.length === 0) {
    throw new Error("bridge.name must be a non-empty string");
  }
  if (typeof bridge.mac !== "string" || !MAC_RE.test(bridge.mac)) {
    throw new Error(
      "bridge.mac must be a MAC address (e.g. AA:BB:CC:DD:EE:FF)",
    );
  }
  if (typeof bridge.pincode !== "string" || !PIN_RE.test(bridge.pincode)) {
    throw new Error("bridge.pincode must match format XXX-XX-XXX");
  }
  if (
    typeof bridge.port !== "number" ||
    bridge.port <= 0 ||
    bridge.port > 65535 ||
    !Number.isInteger(bridge.port)
  ) {
    throw new Error("bridge.port must be an integer between 1 and 65535");
  }

  if (typeof obj.mqtt !== "object" || obj.mqtt === null) {
    throw new Error("Missing required field: mqtt");
  }

  const mqtt = obj.mqtt as Record<string, unknown>;

  if (typeof mqtt.url !== "string" || mqtt.url.length === 0) {
    throw new Error("mqtt.url must be a non-empty string");
  }
  if (
    mqtt.username !== undefined &&
    (typeof mqtt.username !== "string" || mqtt.username.length === 0)
  ) {
    throw new Error("mqtt.username must be a non-empty string");
  }
  if (
    typeof mqtt.username === "string" &&
    Buffer.byteLength(mqtt.username) > MQTT_STRING_MAX_BYTES
  ) {
    throw new Error(
      `mqtt.username must be at most ${String(MQTT_STRING_MAX_BYTES)} bytes`,
    );
  }
  if (
    mqtt.passwordFile !== undefined &&
    (typeof mqtt.passwordFile !== "string" || mqtt.passwordFile.length === 0)
  ) {
    throw new Error("mqtt.passwordFile must be a non-empty string");
  }
  if ("password" in mqtt) {
    throw new Error("mqtt.password is not supported; use mqtt.passwordFile");
  }
  const unknownField = Object.keys(mqtt).find(
    (field) => !MQTT_FIELDS.has(field),
  );
  if (unknownField !== undefined) {
    throw new Error(
      `mqtt: unknown mqtt field ${JSON.stringify(unknownField)}; supported fields are url, username, and passwordFile`,
    );
  }
  if (mqtt.username !== undefined && MQTT_URL_USERINFO_RE.test(mqtt.url)) {
    throw new Error(
      "mqtt.username cannot be combined with credentials in mqtt.url; use one or the other",
    );
  }

  const heatedBedding =
    obj.heatedBedding === undefined
      ? undefined
      : validateTucsonEndpoints(obj.heatedBedding);
  const curtains =
    obj.curtains === undefined
      ? undefined
      : validateTucsonEndpoints(obj.curtains, "curtains");
  const endpoints = [...(heatedBedding ?? []), ...(curtains ?? [])];
  const identities = new Set<string>();
  for (const endpoint of endpoints) {
    const topic = tucsonTopic(endpoint);
    if (identities.has(topic)) throw new Error("Duplicate Tucson endpoint");
    identities.add(topic);
  }
  const rawDevices =
    obj.devices === undefined && endpoints.length ? [] : obj.devices;
  if (
    !Array.isArray(rawDevices) ||
    (rawDevices.length === 0 && !endpoints.length)
  ) {
    throw new Error("devices must be a non-empty array");
  }

  const devices = rawDevices.map((d: unknown, i: number) =>
    validateDevice(d, i),
  );
  if (endpoints.length) validateTucsonTopics(devices, endpoints);

  const topics = new Set<string>();
  for (const device of devices) {
    if (topics.has(device.topic)) {
      throw new Error(`duplicate device topic "${device.topic}"`);
    }
    topics.add(device.topic);
  }

  // WLED devices subscribe to the derived sub-topics `${topic}/g` and
  // `${topic}/c`, which the bridge router resolves before raw device topics.
  // If another device's topic equals one of them, that device's messages are
  // silently routed to the WLED device instead, so reject the collision.
  for (const device of devices) {
    if (device.type !== "wled") continue;
    const gTopic = `${device.topic}/g`;
    const cTopic = `${device.topic}/c`;
    if (topics.has(gTopic)) {
      throw new Error(
        `WLED device "${device.topic}" sub-topic "${gTopic}" collides with another device topic`,
      );
    }
    if (topics.has(cTopic)) {
      throw new Error(
        `WLED device "${device.topic}" sub-topic "${cTopic}" collides with another device topic`,
      );
    }
  }

  if (bridge.bind !== undefined && typeof bridge.bind !== "string") {
    throw new Error("bridge.bind must be a string (interface name or IP)");
  }

  let metrics: MetricsConfig | undefined;
  if (obj.metrics !== undefined) {
    if (typeof obj.metrics !== "object" || obj.metrics === null) {
      throw new Error("metrics must be an object");
    }
    const m = obj.metrics as Record<string, unknown>;
    if (
      typeof m.port !== "number" ||
      !Number.isInteger(m.port) ||
      m.port < 1 ||
      m.port > 65535
    ) {
      throw new Error("metrics.port must be an integer between 1 and 65535");
    }
    if (m.bind !== undefined && typeof m.bind !== "string") {
      throw new Error("metrics.bind must be a string (IP address or hostname)");
    }
    metrics = {
      port: m.port,
      ...(typeof m.bind === "string" ? { bind: m.bind } : {}),
    };
  }

  return {
    bridge: {
      name: bridge.name,
      mac: bridge.mac.toUpperCase(),
      pincode: bridge.pincode,
      port: bridge.port,
      ...(typeof bridge.bind === "string" ? { bind: bridge.bind } : {}),
    },
    mqtt: {
      url: mqtt.url,
      ...(typeof mqtt.username === "string" ? { username: mqtt.username } : {}),
      ...(typeof mqtt.passwordFile === "string"
        ? { passwordFile: mqtt.passwordFile }
        : {}),
    },
    devices,
    ...(heatedBedding ? { heatedBedding } : {}),
    ...(curtains ? { curtains } : {}),
    ...(metrics ? { metrics } : {}),
  };
}

function validateTucsonEndpoints(
  data: unknown,
  field = "heatedBedding",
): HeatedBeddingZoneConfig[] {
  if (!Array.isArray(data)) throw new TypeError(`${field} must be an array`);
  const identities = new Set<string>();
  return data.map((entry: unknown, index: number) => {
    const label = `${field}[${String(index)}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`${label} must be an object`);
    }
    const value = entry as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (field) => !["name", "prefix", "controller", "zone"].includes(field),
      )
    ) {
      throw new Error(`${label}: unknown Tucson field`);
    }
    if (
      typeof value.name !== "string" ||
      value.name.trim().length === 0 ||
      value.name.length > 256 ||
      value.name.includes("\0")
    ) {
      throw new Error(
        `${label}.name must be a non-empty display name of at most 256 characters`,
      );
    }
    if (
      typeof value.prefix !== "string" ||
      value.prefix.length > 256 ||
      !/^[a-z][a-z0-9_]*(\/[a-z][a-z0-9_]*)*$/.test(value.prefix)
    ) {
      throw new Error(`${label}.prefix must be a valid Tucson topic prefix`);
    }
    if (
      typeof value.controller !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(value.controller)
    ) {
      throw new Error(
        `${label}.controller must be a valid Tucson controller name`,
      );
    }
    if (
      typeof value.zone !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(value.zone)
    ) {
      throw new Error(`${label}.zone must be a valid Tucson zone name`);
    }
    if (value.controller === "bridge" || value.zone === "availability") {
      throw new Error(`${label}: reserved Tucson topic`);
    }
    const identity = `${value.controller}/${value.zone}`;
    if (identities.has(identity))
      throw new Error(`${label}: duplicate Tucson identity`);
    identities.add(identity);
    return {
      name: value.name,
      prefix: value.prefix,
      controller: value.controller,
      zone: value.zone,
    };
  });
}

function validateTucsonTopics(
  devices: DeviceConfig[],
  heatedBedding: HeatedBeddingZoneConfig[],
): void {
  const owners = new Map<string, string>();
  const claim = (route: string, owner: string): void => {
    const existing = owners.get(route);
    if (existing !== undefined && existing !== owner) {
      throw new Error(
        `Tucson topic "${route}" is used by both ${existing} and ${owner}`,
      );
    }
    owners.set(route, owner);
  };
  for (const zone of heatedBedding) {
    const { prefix, controller } = zone;
    const topic = tucsonTopic(zone);
    claim(`${prefix}/bridge/availability`, `prefix ${prefix}`);
    claim(`${prefix}/bridge/heartbeat`, `prefix ${prefix}`);
    claim(
      `${prefix}/${controller}/availability`,
      `controller ${prefix}/${controller}`,
    );
    for (const route of [
      topic,
      `${topic}/result`,
      `${topic}/set`,
      `${topic}/get`,
    ])
      claim(route, `zone ${topic}`);
  }
  for (const device of devices) {
    if (device.topic.includes("+") || device.topic.includes("#")) {
      throw new Error(
        "wildcard device topics cannot accompany Tucson endpoints",
      );
    }
    const routes =
      device.type === "wled"
        ? [
            device.topic,
            `${device.topic}/g`,
            `${device.topic}/c`,
            `${device.topic}/api`,
          ]
        : [device.topic, `${device.topic}/set`, `${device.topic}/get`];
    if (routes.some((topic) => owners.has(topic))) {
      throw new Error("device route collides with a Tucson topic");
    }
  }
}

function validateDevice(data: unknown, index: number): DeviceConfig {
  if (typeof data !== "object" || data === null) {
    throw new Error(`devices[${String(index)}] must be an object`);
  }

  const d = data as Record<string, unknown>;

  if (typeof d.name !== "string" || d.name.length === 0) {
    throw new Error(
      `devices[${String(index)}].name must be a non-empty string`,
    );
  }
  const type: DeviceType =
    d.type === undefined ? "z2m" : (d.type as DeviceType);
  if (!VALID_DEVICE_TYPES.has(type)) {
    throw new Error(`devices[${String(index)}].type must be "z2m" or "wled"`);
  }

  if (typeof d.topic !== "string" || d.topic.length === 0) {
    throw new Error(
      `devices[${String(index)}].topic must be a non-empty string`,
    );
  }

  if (!Array.isArray(d.capabilities) || d.capabilities.length === 0) {
    throw new Error(
      `devices[${String(index)}].capabilities must be a non-empty array`,
    );
  }

  const seen = new Set<string>();
  for (const cap of d.capabilities) {
    if (!VALID_CAPABILITIES.has(cap as Capability)) {
      throw new Error(
        `devices[${String(index)}]: unknown capability "${String(cap)}"`,
      );
    }
    if (seen.has(cap as string)) {
      throw new Error(
        `devices[${String(index)}]: duplicate capability "${String(cap)}"`,
      );
    }
    seen.add(cap as string);
  }

  const capabilities = d.capabilities as Capability[];

  if (
    capabilities.includes("color_temp") &&
    capabilities.includes("color_hs")
  ) {
    throw new Error(
      `devices[${String(index)}]: color_temp and color_hs cannot be combined (HAP spec R13 §10.11); use one or the other`,
    );
  }

  if (capabilities.includes("fan_speed") && !capabilities.includes("fan")) {
    throw new Error(`devices[${String(index)}]: fan_speed requires fan`);
  }

  const hasLight = capabilities.some((c) => LIGHT_CAPABILITIES.has(c));
  const hasFan = capabilities.some((c) => FAN_CAPABILITIES.has(c));
  if (hasLight && hasFan) {
    throw new Error(
      `devices[${String(index)}]: fan and light capabilities are mutually exclusive`,
    );
  }

  if (type === "wled" && hasFan) {
    throw new Error(
      `devices[${String(index)}]: fan capabilities are not supported for WLED devices`,
    );
  }

  let scenes: SceneConfig[] | undefined;
  if (d.scenes !== undefined) {
    if (!Array.isArray(d.scenes)) {
      throw new TypeError(`devices[${String(index)}].scenes must be an array`);
    }
    if (type === "wled") {
      throw new Error(
        `devices[${String(index)}]: scenes are not supported for WLED devices`,
      );
    }
    scenes = d.scenes.map((s: unknown, si: number) =>
      validateScene(s, index, si),
    );
  }

  return {
    name: d.name,
    type,
    topic: d.topic,
    capabilities,
    ...(scenes ? { scenes } : {}),
  };
}

function validateScene(
  data: unknown,
  deviceIndex: number,
  sceneIndex: number,
): SceneConfig {
  if (typeof data !== "object" || data === null) {
    throw new Error(
      `devices[${String(deviceIndex)}].scenes[${String(sceneIndex)}] must be an object`,
    );
  }

  const s = data as Record<string, unknown>;

  if (typeof s.name !== "string" || s.name.length === 0) {
    throw new Error(
      `devices[${String(deviceIndex)}].scenes[${String(sceneIndex)}].name must be a non-empty string`,
    );
  }
  if (typeof s.id !== "number" || s.id <= 0 || !Number.isInteger(s.id)) {
    throw new Error(
      `devices[${String(deviceIndex)}].scenes[${String(sceneIndex)}].id must be a positive integer`,
    );
  }

  return { name: s.name, id: s.id };
}

export function loadConfig(path: string): Config {
  const content = readFileSync(path, "utf8");
  const data: unknown = parse(content);
  return validateConfig(data);
}

export function stripMQTTUserinfo(url: string): string {
  return url.replace(MQTT_URL_USERINFO_RE, "$1");
}

function decodePasswordFile(bytes: Uint8Array): string {
  try {
    // TextDecoder drops a leading byte order mark unless ignoreBOM is set.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new Error("mqtt.passwordFile is not valid UTF-8", { cause: error });
  }
}

export function resolveMQTTCredentials(
  mqtt: MqttConfig,
): MQTTCredentials | undefined {
  const { username, passwordFile } = mqtt;
  if (username === undefined) {
    if (passwordFile !== undefined) {
      throw new Error("mqtt.passwordFile requires mqtt.username");
    }
    return undefined;
  }
  if (passwordFile === undefined) {
    throw new Error("mqtt.username requires mqtt.passwordFile");
  }
  const password = decodePasswordFile(readFileSync(passwordFile)).replace(
    /\r?\n$/,
    "",
  );
  if (password.length === 0) throw new Error("mqtt.passwordFile is empty");
  if (Buffer.byteLength(password) > MQTT_STRING_MAX_BYTES) {
    throw new Error(
      `mqtt.passwordFile must be at most ${String(MQTT_STRING_MAX_BYTES)} bytes`,
    );
  }
  return { username, password };
}

// mqtt.js lets userinfo in the broker URL replace the username and password
// options unless auth is empty.
export function credentialOptions(
  credentials: MQTTCredentials,
): MQTTCredentials & { auth: string } {
  return { ...credentials, auth: "" };
}
