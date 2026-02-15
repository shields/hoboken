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

import { describe, expect, test } from "bun:test";
import { loadConfig, validateConfig } from "../src/config.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

function validConfig() {
  return {
    bridge: {
      name: "Hoboken",
      mac: "0E:42:A1:B2:C3:D4",
      pincode: "031-45-154",
      port: 51826,
    },
    mqtt: {
      url: "mqtt://localhost:1883",
      topic_prefix: "zigbee2mqtt",
    },
    devices: [
      {
        name: "Living Room Light",
        topic: "living_room_light",
        capabilities: ["on_off", "brightness"],
        scenes: [{ name: "Movie Mode", id: 1 }],
      },
    ],
  };
}

describe("validateConfig", () => {
  test("accepts valid config", () => {
    const config = validateConfig(validConfig());
    expect(config.bridge.name).toBe("Hoboken");
    expect(config.devices).toHaveLength(1);
    expect(config.devices[0]!.scenes).toHaveLength(1);
  });

  test("accepts config without scenes", () => {
    const data = validConfig();
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    const config = validateConfig(data);
    expect(config.devices[0]!.scenes).toBeUndefined();
  });

  test("accepts all capabilities", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = [
      "on_off",
      "brightness",
      "color_temp",
      "color_hs",
    ];
    const config = validateConfig(data);
    expect(config.devices[0]!.capabilities).toHaveLength(4);
  });

  test("rejects non-object config", () => {
    expect(() => validateConfig(null)).toThrow("Config must be an object");
    expect(() => validateConfig("string")).toThrow("Config must be an object");
  });

  test("rejects missing bridge", () => {
    const data = validConfig();
    delete (data as Record<string, unknown>).bridge;
    expect(() => validateConfig(data)).toThrow(
      "Missing required field: bridge",
    );
  });

  test("rejects missing mqtt", () => {
    const data = validConfig();
    delete (data as Record<string, unknown>).mqtt;
    expect(() => validateConfig(data)).toThrow("Missing required field: mqtt");
  });

  test("rejects empty bridge name", () => {
    const data = validConfig();
    data.bridge.name = "";
    expect(() => validateConfig(data)).toThrow(
      "bridge.name must be a non-empty string",
    );
  });

  test("rejects invalid MAC format", () => {
    const data = validConfig();
    data.bridge.mac = "not-a-mac";
    expect(() => validateConfig(data)).toThrow("MAC address");
  });

  test("accepts and normalizes lowercase MAC", () => {
    const data = validConfig();
    data.bridge.mac = "0e:42:a1:b2:c3:d4";
    const config = validateConfig(data);
    expect(config.bridge.mac).toBe("0E:42:A1:B2:C3:D4");
  });

  test("rejects invalid PIN format", () => {
    const data = validConfig();
    data.bridge.pincode = "12345678";
    expect(() => validateConfig(data)).toThrow("pincode must match format");
  });

  test("rejects non-integer port", () => {
    const data = validConfig();
    data.bridge.port = 1.5;
    expect(() => validateConfig(data)).toThrow(
      "bridge.port must be an integer between 1 and 65535",
    );
  });

  test("rejects zero port", () => {
    const data = validConfig();
    data.bridge.port = 0;
    expect(() => validateConfig(data)).toThrow(
      "bridge.port must be an integer between 1 and 65535",
    );
  });

  test("rejects port above 65535", () => {
    const data = validConfig();
    data.bridge.port = 70000;
    expect(() => validateConfig(data)).toThrow(
      "bridge.port must be an integer between 1 and 65535",
    );
  });

  test("rejects non-string bind", () => {
    const data = validConfig();
    (data.bridge as Record<string, unknown>).bind = 123;
    expect(() => validateConfig(data)).toThrow(
      "bridge.bind must be a string (interface name or IP)",
    );
  });

  test("accepts valid bind interface name", () => {
    const data = validConfig();
    (data.bridge as Record<string, unknown>).bind = "eno1";
    const config = validateConfig(data);
    expect(config.bridge.bind).toBe("eno1");
  });

  test("omits bind when not specified", () => {
    const data = validConfig();
    const config = validateConfig(data);
    expect(config.bridge.bind).toBeUndefined();
  });

  test("rejects empty mqtt url", () => {
    const data = validConfig();
    data.mqtt.url = "";
    expect(() => validateConfig(data)).toThrow(
      "mqtt.url must be a non-empty string",
    );
  });

  test("rejects empty topic_prefix", () => {
    const data = validConfig();
    data.mqtt.topic_prefix = "";
    expect(() => validateConfig(data)).toThrow(
      "mqtt.topic_prefix must be a non-empty string",
    );
  });

  test("rejects empty devices array", () => {
    const data = validConfig();
    data.devices = [];
    expect(() => validateConfig(data)).toThrow(
      "devices must be a non-empty array",
    );
  });

  test("rejects missing devices", () => {
    const data = validConfig();
    delete (data as Record<string, unknown>).devices;
    expect(() => validateConfig(data)).toThrow(
      "devices must be a non-empty array",
    );
  });

  test("rejects device with empty name", () => {
    const data = validConfig();
    data.devices[0]!.name = "";
    expect(() => validateConfig(data)).toThrow("devices[0].name");
  });

  test("rejects device with empty topic", () => {
    const data = validConfig();
    data.devices[0]!.topic = "";
    expect(() => validateConfig(data)).toThrow("devices[0].topic");
  });

  test("rejects device with empty capabilities", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = [];
    expect(() => validateConfig(data)).toThrow(
      "devices[0].capabilities must be a non-empty array",
    );
  });

  test("rejects unknown capability", () => {
    const data = validConfig();
    data.devices[0]!.capabilities.push("unknown");
    expect(() => validateConfig(data)).toThrow('unknown capability "unknown"');
  });

  test("rejects duplicate capabilities", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = ["on_off", "brightness", "on_off"];
    expect(() => validateConfig(data)).toThrow('duplicate capability "on_off"');
  });

  test("rejects non-object device", () => {
    const data = validConfig();
    (data.devices as unknown[])[0] = null;
    expect(() => validateConfig(data)).toThrow("devices[0] must be an object");
  });

  test("rejects non-array scenes", () => {
    const data = validConfig();
    (data.devices[0]! as Record<string, unknown>).scenes = "not an array";
    expect(() => validateConfig(data)).toThrow(
      "devices[0].scenes must be an array",
    );
  });

  test("rejects non-object scene", () => {
    const data = validConfig();
    data.devices[0]!.scenes = [null as unknown as { name: string; id: number }];
    expect(() => validateConfig(data)).toThrow("scenes[0] must be an object");
  });

  test("rejects scene with non-positive id", () => {
    const data = validConfig();
    data.devices[0]!.scenes = [{ name: "Bad", id: 0 }];
    expect(() => validateConfig(data)).toThrow("positive integer");
  });

  test("rejects scene with non-integer id", () => {
    const data = validConfig();
    data.devices[0]!.scenes = [{ name: "Bad", id: 1.5 }];
    expect(() => validateConfig(data)).toThrow("positive integer");
  });

  test("rejects scene with empty name", () => {
    const data = validConfig();
    data.devices[0]!.scenes = [{ name: "", id: 1 }];
    expect(() => validateConfig(data)).toThrow(
      "scenes[0].name must be a non-empty string",
    );
  });

  test("rejects duplicate device topics", () => {
    const data = validConfig();
    (data.devices as unknown[]).push({
      name: "Duplicate",
      topic: "living_room_light",
      capabilities: ["on_off"],
    });
    expect(() => validateConfig(data)).toThrow(
      'duplicate device topic "living_room_light"',
    );
  });

  test("accepts config without metrics", () => {
    const config = validateConfig(validConfig());
    expect(config.metrics).toBeUndefined();
  });

  test("accepts valid metrics config", () => {
    const data = validConfig();
    (data as Record<string, unknown>).metrics = { port: 9090 };
    const config = validateConfig(data);
    expect(config.metrics).toEqual({ port: 9090 });
  });

  test("rejects non-object metrics", () => {
    const data = validConfig();
    (data as Record<string, unknown>).metrics = "not an object";
    expect(() => validateConfig(data)).toThrow("metrics must be an object");
  });

  test("rejects metrics with non-integer port", () => {
    const data = validConfig();
    (data as Record<string, unknown>).metrics = { port: 1.5 };
    expect(() => validateConfig(data)).toThrow(
      "metrics.port must be an integer between 1 and 65535",
    );
  });

  test("rejects metrics with port 0", () => {
    const data = validConfig();
    (data as Record<string, unknown>).metrics = { port: 0 };
    expect(() => validateConfig(data)).toThrow(
      "metrics.port must be an integer between 1 and 65535",
    );
  });

  test("rejects metrics with port above 65535", () => {
    const data = validConfig();
    (data as Record<string, unknown>).metrics = { port: 70000 };
    expect(() => validateConfig(data)).toThrow(
      "metrics.port must be an integer between 1 and 65535",
    );
  });

  test("rejects metrics with missing port", () => {
    const data = validConfig();
    (data as Record<string, unknown>).metrics = {};
    expect(() => validateConfig(data)).toThrow(
      "metrics.port must be an integer between 1 and 65535",
    );
  });

  test("accepts metrics with bind address", () => {
    const data = validConfig();
    (data as Record<string, unknown>).metrics = {
      port: 9090,
      bind: "127.0.0.1",
    };
    const config = validateConfig(data);
    expect(config.metrics).toEqual({ port: 9090, bind: "127.0.0.1" });
  });

  test("rejects non-string metrics bind", () => {
    const data = validConfig();
    (data as Record<string, unknown>).metrics = { port: 9090, bind: 123 };
    expect(() => validateConfig(data)).toThrow(
      "metrics.bind must be a string (IP address or hostname)",
    );
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  test("loads valid YAML file", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "hoboken-test-"));
    const configPath = path.join(tmpDir, "config.yaml");
    writeFileSync(
      configPath,
      `
bridge:
  name: "Test"
  mac: "AA:BB:CC:DD:EE:FF"
  pincode: "111-22-333"
  port: 51826
mqtt:
  url: "mqtt://localhost:1883"
  topic_prefix: "z2m"
devices:
  - name: "Light"
    topic: "light"
    capabilities: [on_off]
`,
    );
    const config = loadConfig(configPath);
    expect(config.bridge.name).toBe("Test");
    rmSync(tmpDir, { recursive: true });
  });

  test("throws on missing file", () => {
    expect(() => loadConfig("/nonexistent/path.yaml")).toThrow();
  });
});
