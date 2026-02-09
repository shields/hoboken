import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Capability = "on_off" | "brightness" | "color_temp" | "color_hs";

const VALID_CAPABILITIES = new Set<Capability>([
  "on_off",
  "brightness",
  "color_temp",
  "color_hs",
]);

export interface SceneConfig {
  name: string;
  id: number;
}

export interface DeviceConfig {
  name: string;
  topic: string;
  capabilities: Capability[];
  scenes?: SceneConfig[];
}

export interface BridgeConfig {
  name: string;
  mac: string;
  pincode: string;
  port: number;
}

export interface MqttConfig {
  url: string;
  topic_prefix: string;
}

export interface Config {
  bridge: BridgeConfig;
  mqtt: MqttConfig;
  devices: DeviceConfig[];
}

const MAC_RE = /^[\dA-Fa-f]{2}(:[\dA-Fa-f]{2}){5}$/;
const PIN_RE = /^\d{3}-\d{2}-\d{3}$/;

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
  if (typeof mqtt.topic_prefix !== "string" || mqtt.topic_prefix.length === 0) {
    throw new Error("mqtt.topic_prefix must be a non-empty string");
  }

  if (!Array.isArray(obj.devices) || obj.devices.length === 0) {
    throw new Error("devices must be a non-empty array");
  }

  const devices = obj.devices.map((d: unknown, i: number) =>
    validateDevice(d, i),
  );

  const topics = new Set<string>();
  for (const device of devices) {
    if (topics.has(device.topic)) {
      throw new Error(`duplicate device topic "${device.topic}"`);
    }
    topics.add(device.topic);
  }

  return {
    bridge: {
      name: bridge.name,
      mac: (bridge.mac).toUpperCase(),
      pincode: bridge.pincode,
      port: bridge.port,
    },
    mqtt: {
      url: mqtt.url,
      topic_prefix: mqtt.topic_prefix,
    },
    devices,
  };
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

  let scenes: SceneConfig[] | undefined;
  if (d.scenes !== undefined) {
    if (!Array.isArray(d.scenes)) {
      throw new Error(`devices[${String(index)}].scenes must be an array`);
    }
    scenes = d.scenes.map((s: unknown, si: number) =>
      validateScene(s, index, si),
    );
  }

  return { name: d.name, topic: d.topic, capabilities, scenes };
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
  const content = readFileSync(path, "utf-8");
  const data: unknown = parse(content);
  return validateConfig(data);
}
