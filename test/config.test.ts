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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  credentialOptions,
  loadConfig,
  resolveMQTTCredentials,
  stripMQTTUserinfo,
  validateConfig,
} from "../src/config.ts";
import type { MqttConfig } from "../src/config.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const PASSWORD = "correct-horse-9f3a";
const MQTT_URL = "mqtt://localhost:1883";

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

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
    },
    devices: [
      {
        name: "Living Room Light",
        topic: "zigbee2mqtt/living_room_light",
        capabilities: ["on_off", "brightness"],
        scenes: [{ name: "Movie Mode", id: 1 }],
      },
    ],
  };
}

describe("validateConfig", () => {
  const heatedBedding = {
    name: "Bed Side A",
    prefix: "tuya",
    controller: "bed",
    zone: "side_a",
  };

  test("accepts heated bedding zones alongside existing devices", () => {
    const data = {
      ...validConfig(),
      heatedBedding: [
        heatedBedding,
        { ...heatedBedding, name: "Bed Side B", zone: "side_b" },
      ],
    };
    const config = validateConfig(data);
    expect(config.heatedBedding).toEqual(data.heatedBedding);
    expect(config.devices[0]!.type).toBe("z2m");
  });

  test.each([[undefined], [[]]])(
    "accepts a bridge with only heated bedding with devices %j",
    (devices) => {
      const config = validateConfig({
        ...validConfig(),
        devices,
        heatedBedding: [heatedBedding],
      });
      expect(config.devices).toEqual([]);
      expect(config.heatedBedding).toEqual([heatedBedding]);
    },
  );

  test("empty heated bedding configuration is optional alongside devices", () => {
    expect(
      validateConfig({ ...validConfig(), heatedBedding: [] }).heatedBedding,
    ).toEqual([]);
    expect(validateConfig(validConfig()).heatedBedding).toBeUndefined();
    expect(() =>
      validateConfig({ ...validConfig(), devices: [], heatedBedding: [] }),
    ).toThrow("devices must be a non-empty array");
  });

  test.each([null, false, "pad", {}])(
    "rejects a non-array heated bedding list: %j",
    (heatedBedding) => {
      expect(() => validateConfig({ ...validConfig(), heatedBedding })).toThrow(
        "heatedBedding must be an array",
      );
    },
  );

  test.each([[null], [false], ["pad"], [[]], [{}]])(
    "rejects an invalid heated bedding entry: %j",
    (entry) => {
      expect(() =>
        validateConfig({ ...validConfig(), heatedBedding: [entry] }),
      ).toThrow("heatedBedding[0]");
    },
  );

  test.each(["", " ", "\0", "x".repeat(257), false])(
    "rejects invalid heated bedding display names: %j",
    (name) => {
      expect(() =>
        validateConfig({
          ...validConfig(),
          heatedBedding: [{ ...heatedBedding, name }],
        }),
      ).toThrow("heatedBedding[0].name");
    },
  );

  test.each([
    "",
    "/tuya",
    "tuya/",
    "tuya//bed",
    "tuya/+",
    "tuya/#",
    "Tuya",
    "x".repeat(257),
    false,
  ])("rejects invalid heated bedding prefixes: %j", (prefix) => {
    expect(() =>
      validateConfig({
        ...validConfig(),
        heatedBedding: [{ ...heatedBedding, prefix }],
      }),
    ).toThrow("heatedBedding[0].prefix");
  });

  test.each(["controller", "zone"])(
    "rejects invalid heated bedding %s identifiers",
    (field) => {
      for (const value of [
        "",
        "Uppercase",
        "with space",
        "with/slash",
        "+",
        "#",
        "x".repeat(65),
        false,
      ]) {
        expect(() =>
          validateConfig({
            ...validConfig(),
            heatedBedding: [{ ...heatedBedding, [field]: value }],
          }),
        ).toThrow(`heatedBedding[0].${field}`);
      }
    },
  );

  test.each([
    { ...heatedBedding, controller: "bridge" },
    { ...heatedBedding, zone: "availability" },
  ])("rejects reserved heated bedding identities: %j", (entry) => {
    expect(() =>
      validateConfig({ ...validConfig(), heatedBedding: [entry] }),
    ).toThrow("reserved Tucson topic");
  });

  test.each([heatedBedding, { ...heatedBedding, prefix: "another/prefix" }])(
    "rejects duplicate accessory identities across prefixes: %j",
    (second) => {
      expect(() =>
        validateConfig({
          ...validConfig(),
          heatedBedding: [heatedBedding, second],
        }),
      ).toThrow("duplicate Tucson identity");
    },
  );

  test.each([
    "device_id",
    "local_key",
    "protocol_version",
    "capabilities",
    "topic",
  ])("rejects unknown Tucson field %s without its value", (key) => {
    try {
      validateConfig({
        ...validConfig(),
        heatedBedding: [{ ...heatedBedding, [key]: "never-log-key" }],
      });
      throw new Error("Unexpected success");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unknown Tucson field");
      expect((error as Error).message).not.toContain("never-log-key");
    }
  });

  test.each([
    "tuya/bridge/availability",
    "tuya/bridge/heartbeat",
    "tuya/bed/availability",
    "tuya/bed/side_a",
    "tuya/bed/side_a/result",
    "tuya/bed/side_a/set",
    "tuya/bed/side_a/get",
  ])(
    "rejects legacy topics colliding with a heated bedding route: %s",
    (topic) => {
      const data = validConfig();
      data.devices[0]!.topic = topic;
      expect(() =>
        validateConfig({ ...data, heatedBedding: [heatedBedding] }),
      ).toThrow("collides with a Tucson topic");
    },
  );

  test.each([
    ["wled", "tuya/bed/side_a/g"],
    ["wled", "tuya/bed/side_a/c"],
    ["wled", "tuya/bed/side_a/api"],
    ["z2m", "tuya/bed/side_a/set"],
    ["z2m", "tuya/bed/side_a/get"],
  ])("rejects a %s derived topic collision: %s", (type, topic) => {
    const data = validConfig();
    data.devices[0]!.topic = "tuya/bed/side_a";
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    (data.devices[0]! as Record<string, unknown>).type = type;
    const [prefix, controller, zone] = topic.split("/", 3);
    const alternate = {
      ...heatedBedding,
      prefix: `${prefix!}/${controller!}`,
      controller: zone!,
      zone: topic.split("/", 4)[3]!,
    };
    expect(() =>
      validateConfig({ ...data, heatedBedding: [alternate] }),
    ).toThrow("collides with a Tucson topic");
  });

  test.each([
    ["result", "tuya/bed/side_a/result"],
    ["set", "tuya/bed/side_a/set"],
    ["get", "tuya/bed/side_a/get"],
  ])(
    "rejects a heated bedding zone whose state topic is another zone's %s route",
    (zone, topic) => {
      const nested = {
        ...heatedBedding,
        prefix: "tuya/bed",
        controller: "side_a",
        zone,
      };
      expect(() =>
        validateConfig({
          ...validConfig(),
          heatedBedding: [heatedBedding, nested],
        }),
      ).toThrow(`Tucson topic "${topic}" is used by both`);
    },
  );

  test.each(["tuya/#", "tuya/+", "#"])(
    "rejects ambiguous legacy subscription %s alongside heated bedding",
    (topic) => {
      const data = validConfig();
      data.devices[0]!.topic = topic;
      expect(() =>
        validateConfig({ ...data, heatedBedding: [heatedBedding] }),
      ).toThrow("wildcard device topics cannot accompany Tucson endpoints");
    },
  );

  test("accepts nested prefixes and maximum-length identifiers", () => {
    const entry = {
      ...heatedBedding,
      prefix: "home/tuya",
      controller: "c".repeat(64),
      zone: "z".repeat(64),
    };
    expect(
      validateConfig({ ...validConfig(), heatedBedding: [entry] })
        .heatedBedding,
    ).toEqual([entry]);
  });

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

  test("rejects color_temp + color_hs combo", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = [
      "on_off",
      "brightness",
      "color_temp",
      "color_hs",
    ];
    expect(() => validateConfig(data)).toThrow(
      "color_temp and color_hs cannot be combined (HAP spec R13 §10.11)",
    );
  });

  test("accepts color_hs without color_temp", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = ["on_off", "brightness", "color_hs"];
    const config = validateConfig(data);
    expect(config.devices[0]!.capabilities).toEqual([
      "on_off",
      "brightness",
      "color_hs",
    ]);
  });

  test("defaults type to z2m when not specified", () => {
    const config = validateConfig(validConfig());
    expect(config.devices[0]!.type).toBe("z2m");
  });

  test("accepts type z2m", () => {
    const data = validConfig();
    (data.devices[0]! as Record<string, unknown>).type = "z2m";
    const config = validateConfig(data);
    expect(config.devices[0]!.type).toBe("z2m");
  });

  test("accepts type wled", () => {
    const data = validConfig();
    (data.devices[0]! as Record<string, unknown>).type = "wled";
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    const config = validateConfig(data);
    expect(config.devices[0]!.type).toBe("wled");
  });

  test("rejects invalid type", () => {
    const data = validConfig();
    (data.devices[0]! as Record<string, unknown>).type = "invalid";
    expect(() => validateConfig(data)).toThrow(
      'devices[0].type must be "z2m" or "wled"',
    );
  });

  test("rejects scenes on WLED devices", () => {
    const data = validConfig();
    (data.devices[0]! as Record<string, unknown>).type = "wled";
    expect(() => validateConfig(data)).toThrow(
      "scenes are not supported for WLED devices",
    );
  });

  test("accepts color_temp without color_hs", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = ["on_off", "brightness", "color_temp"];
    const config = validateConfig(data);
    expect(config.devices[0]!.capabilities).toEqual([
      "on_off",
      "brightness",
      "color_temp",
    ]);
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

  describe("mqtt credentials", () => {
    function withMQTT(mqtt: Record<string, unknown>) {
      return { ...validConfig(), mqtt: { url: MQTT_URL, ...mqtt } };
    }

    test("accepts username and passwordFile", () => {
      const mqtt = {
        url: MQTT_URL,
        username: "hoboken",
        passwordFile: "/run/secrets/mqtt_password",
      };
      expect(validateConfig(withMQTT(mqtt)).mqtt).toStrictEqual(mqtt);
    });

    test("accepts username alone", () => {
      expect(
        validateConfig(withMQTT({ username: "hoboken" })).mqtt,
      ).toStrictEqual({ url: MQTT_URL, username: "hoboken" });
    });

    test("accepts passwordFile alone", () => {
      expect(
        validateConfig(withMQTT({ passwordFile: "/run/secrets/mqtt_password" }))
          .mqtt,
      ).toStrictEqual({
        url: MQTT_URL,
        passwordFile: "/run/secrets/mqtt_password",
      });
    });

    test("omits credentials when not configured", () => {
      expect(validateConfig(validConfig()).mqtt).toStrictEqual({
        url: MQTT_URL,
      });
    });

    test.each([[""], [5], [null], [false], [{}], [[]]])(
      "rejects invalid mqtt.username: %j",
      (username) => {
        expect(() => validateConfig(withMQTT({ username }))).toThrow(
          "mqtt.username must be a non-empty string",
        );
      },
    );

    test.each(["a".repeat(65535), "€".repeat(21845)])(
      "accepts an mqtt.username of 65535 bytes",
      (username) => {
        expect(validateConfig(withMQTT({ username })).mqtt).toStrictEqual({
          url: MQTT_URL,
          username,
        });
      },
    );

    test.each(["a".repeat(65536), "€".repeat(21846)])(
      "rejects an mqtt.username over 65535 bytes",
      (username) => {
        expect(() => validateConfig(withMQTT({ username }))).toThrow(
          "mqtt.username must be at most 65535 bytes",
        );
      },
    );

    test.each([[""], [5], [null], [false], [{}], [[]]])(
      "rejects invalid mqtt.passwordFile: %j",
      (passwordFile) => {
        expect(() => validateConfig(withMQTT({ passwordFile }))).toThrow(
          "mqtt.passwordFile must be a non-empty string",
        );
      },
    );

    test.each([["hunter2"], [null]])(
      "rejects mqtt.password with value %j",
      (password) => {
        const data = withMQTT({ username: "hoboken", password });
        expect(() => validateConfig(data)).toThrow(
          "mqtt.password is not supported; use mqtt.passwordFile or the MQTT_PASSWORD environment variable",
        );
        expect(errorMessage(() => validateConfig(data))).not.toContain(
          "hunter2",
        );
      },
    );

    test.each([
      "mqtt://user:pw@broker:1883",
      "mqtt://user@broker",
      "mqtt://:pw@broker",
      "mqtts://user:pw@broker/path",
      "//user:pw@broker",
      "mqtt:user@broker:1883",
      "mqtt:user:pw@broker:1883",
      String.raw`mqtt:\\user:pw@broker:1883`,
      String.raw`mqtt:/\user:pw@broker:1883`,
      String.raw`mqtt:\/user:pw@broker:1883`,
      String.raw`\\user:pw@broker`,
    ])("rejects mqtt.username combined with URL credentials: %s", (url) => {
      const data = withMQTT({ url, username: "hoboken" });
      expect(() => validateConfig(data)).toThrow(
        "mqtt.username cannot be combined with credentials in mqtt.url; use one or the other",
      );
      expect(errorMessage(() => validateConfig(data))).not.toContain("pw");
    });

    test.each([
      "mqtt://broker:1883/a@b",
      "mqtt://broker:1883?x=a@b",
      "mqtt://broker:1883#a@b",
      "mqtt://broker:1883/a//b@c",
      "ws://broker:9001/mqtt?next=//x@y",
      "mqtt://broker:1883#//x@y",
      "mqtt://[::1]:1883",
      "mqtt://@broker",
    ])("accepts a URL without userinfo: %s", (url) => {
      expect(
        validateConfig(withMQTT({ url, username: "hoboken" })).mqtt,
      ).toStrictEqual({ url, username: "hoboken" });
    });

    test("accepts URL credentials without mqtt.username", () => {
      const url = "mqtt://user:pw@broker";
      expect(validateConfig(withMQTT({ url })).mqtt).toStrictEqual({ url });
    });
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

  test("accepts fan capability", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = ["fan"];
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    const config = validateConfig(data);
    expect(config.devices[0]!.capabilities).toEqual(["fan"]);
  });

  test("accepts fan + fan_speed capabilities", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = ["fan", "fan_speed"];
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    const config = validateConfig(data);
    expect(config.devices[0]!.capabilities).toEqual(["fan", "fan_speed"]);
  });

  test("rejects fan_speed without fan", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = ["fan_speed"];
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    expect(() => validateConfig(data)).toThrow("fan_speed requires fan");
  });

  test("rejects fan + on_off (mutually exclusive)", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = ["fan", "on_off"];
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    expect(() => validateConfig(data)).toThrow(
      "fan and light capabilities are mutually exclusive",
    );
  });

  test("rejects fan + brightness (mutually exclusive)", () => {
    const data = validConfig();
    data.devices[0]!.capabilities = ["fan", "brightness"];
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    expect(() => validateConfig(data)).toThrow(
      "fan and light capabilities are mutually exclusive",
    );
  });

  test("rejects WLED device with fan capabilities", () => {
    const data = validConfig();
    (data.devices[0]! as Record<string, unknown>).type = "wled";
    data.devices[0]!.capabilities = ["fan"];
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    expect(() => validateConfig(data)).toThrow(
      "fan capabilities are not supported for WLED devices",
    );
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
      topic: "zigbee2mqtt/living_room_light",
      capabilities: ["on_off"],
    });
    expect(() => validateConfig(data)).toThrow(
      'duplicate device topic "zigbee2mqtt/living_room_light"',
    );
  });

  test("rejects WLED /g sub-topic colliding with another device topic", () => {
    const data = validConfig();
    (data.devices[0]! as Record<string, unknown>).type = "wled";
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    (data.devices[0]! as Record<string, unknown>).topic = "wled/desk";
    (data.devices as unknown[]).push({
      name: "Shadowed",
      topic: "wled/desk/g",
      capabilities: ["on_off"],
    });
    expect(() => validateConfig(data)).toThrow(
      'WLED device "wled/desk" sub-topic "wled/desk/g" collides with another device topic',
    );
  });

  test("rejects WLED /c sub-topic colliding with another device topic", () => {
    const data = validConfig();
    (data.devices[0]! as Record<string, unknown>).type = "wled";
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    (data.devices[0]! as Record<string, unknown>).topic = "wled/desk";
    (data.devices as unknown[]).push({
      name: "Shadowed",
      topic: "wled/desk/c",
      capabilities: ["on_off"],
    });
    expect(() => validateConfig(data)).toThrow(
      'WLED device "wled/desk" sub-topic "wled/desk/c" collides with another device topic',
    );
  });

  test("accepts WLED device alongside non-colliding topics", () => {
    const data = validConfig();
    (data.devices[0]! as Record<string, unknown>).type = "wled";
    delete (data.devices[0]! as Record<string, unknown>).scenes;
    (data.devices[0]! as Record<string, unknown>).topic = "wled/desk";
    (data.devices as unknown[]).push({
      name: "Other Light",
      topic: "zigbee2mqtt/other",
      capabilities: ["on_off"],
    });
    const config = validateConfig(data);
    expect(config.devices).toHaveLength(2);
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

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "hoboken-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  function writeConfig(mqttLines: string): string {
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
${mqttLines}
devices:
  - name: "Light"
    topic: "light"
    capabilities: [on_off]
`,
    );
    return configPath;
  }

  test("loads valid YAML file", () => {
    const config = loadConfig(writeConfig('  url: "mqtt://localhost:1883"'));
    expect(config.bridge.name).toBe("Test");
  });

  test("loads the broker login and password file path without reading the file", () => {
    const passwordFile = path.join(tmpDir, "password");
    writeFileSync(passwordFile, `${PASSWORD}\n`);
    const config = loadConfig(
      writeConfig(
        [
          '  url: "mqtt://localhost:1883"',
          "  username: hoboken",
          `  passwordFile: ${passwordFile}`,
        ].join("\n"),
      ),
    );
    expect(config.mqtt).toStrictEqual({
      url: MQTT_URL,
      username: "hoboken",
      passwordFile,
    });
    const serialized = JSON.stringify(config);
    expect(serialized).toContain(passwordFile);
    expect(serialized).not.toContain(PASSWORD);
  });

  test("rejects a bare username key", () => {
    const configPath = writeConfig(
      ['  url: "mqtt://localhost:1883"', "  username:"].join("\n"),
    );
    expect(() => loadConfig(configPath)).toThrow(
      "mqtt.username must be a non-empty string",
    );
  });

  test("throws on missing file", () => {
    expect(() => loadConfig("/nonexistent/path.yaml")).toThrow();
  });
});

describe("resolveMQTTCredentials", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "hoboken-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  function mqtt(extra: Partial<MqttConfig> = {}): MqttConfig {
    return { url: MQTT_URL, ...extra };
  }

  function passwordFile(content: string): string {
    const file = path.join(tmpDir, "password");
    writeFileSync(file, content);
    return file;
  }

  test.each([[{}], [{ UNRELATED: "x" }]])(
    "returns undefined when nothing is configured with env %j",
    (env) => {
      expect(resolveMQTTCredentials(mqtt(), env)).toBeUndefined();
    },
  );

  test("returns undefined for credentials embedded in the URL", () => {
    expect(
      resolveMQTTCredentials(mqtt({ url: "mqtt://u:p@h" }), {}),
    ).toBeUndefined();
  });

  test("reads the password from the environment", () => {
    expect(
      resolveMQTTCredentials(mqtt({ username: "hoboken" }), {
        MQTT_PASSWORD: PASSWORD,
      }),
    ).toStrictEqual({ username: "hoboken", password: PASSWORD });
  });

  test.each([["pw\n"], [" a b "], ["pässwörd€"]])(
    "uses the environment password verbatim: %j",
    (value) => {
      expect(
        resolveMQTTCredentials(mqtt({ username: "hoboken" }), {
          MQTT_PASSWORD: value,
        }),
      ).toStrictEqual({ username: "hoboken", password: value });
    },
  );

  test.each([
    ["s3cret", "s3cret"],
    ["s3cret\n", "s3cret"],
    ["s3cret\n\n", "s3cret\n"],
    [" a b \n", " a b "],
    ["multi\nline\n", "multi\nline"],
    ["x\r\n", "x\r"],
    ["a\n\nb\n", "a\n\nb"],
    ["pässwörd€\n", "pässwörd€"],
  ])("reads password file content %j as %j", (content, expected) => {
    expect(
      resolveMQTTCredentials(
        mqtt({ username: "hoboken", passwordFile: passwordFile(content) }),
        {},
      ),
    ).toStrictEqual({ username: "hoboken", password: expected });
  });

  test("ignores an unrelated environment password source when reading the file", () => {
    expect(
      resolveMQTTCredentials(
        mqtt({ username: "hoboken", passwordFile: passwordFile("s3cret\n") }),
        { UNRELATED: "x" },
      ),
    ).toStrictEqual({ username: "hoboken", password: "s3cret" });
  });

  test("requires a password source for a username", () => {
    expect(() =>
      resolveMQTTCredentials(mqtt({ username: "hoboken" }), {}),
    ).toThrow(
      "mqtt.username requires mqtt.passwordFile or the MQTT_PASSWORD environment variable",
    );
  });

  test("requires a username for a password file", () => {
    expect(() =>
      resolveMQTTCredentials(mqtt({ passwordFile: passwordFile("x") }), {}),
    ).toThrow("mqtt.passwordFile requires mqtt.username");
  });

  test.each([["x"], [""]])(
    "requires a username for the environment password %j",
    (value) => {
      expect(() =>
        resolveMQTTCredentials(mqtt(), { MQTT_PASSWORD: value }),
      ).toThrow("MQTT_PASSWORD requires mqtt.username");
    },
  );

  test.each([
    [undefined, PASSWORD],
    [undefined, ""],
    ["hoboken", PASSWORD],
    ["hoboken", ""],
  ])(
    "rejects both password sources before reading the file with username %s and environment password %j",
    (username, envPassword) => {
      const missing = path.join(tmpDir, "missing");
      expect(() =>
        resolveMQTTCredentials(
          mqtt({
            ...(username === undefined ? {} : { username }),
            passwordFile: missing,
          }),
          { MQTT_PASSWORD: envPassword },
        ),
      ).toThrow(
        "mqtt.passwordFile and MQTT_PASSWORD cannot be combined; use one or the other",
      );
    },
  );

  test("requires a username for a password file before reading it", () => {
    expect(() =>
      resolveMQTTCredentials(
        mqtt({ passwordFile: path.join(tmpDir, "missing") }),
        {},
      ),
    ).toThrow("mqtt.passwordFile requires mqtt.username");
  });

  test("rejects an empty environment password", () => {
    expect(() =>
      resolveMQTTCredentials(mqtt({ username: "hoboken" }), {
        MQTT_PASSWORD: "",
      }),
    ).toThrow("MQTT_PASSWORD is empty");
  });

  test.each(["a".repeat(65535), "€".repeat(21845)])(
    "accepts an environment password of 65535 bytes",
    (password) => {
      expect(
        resolveMQTTCredentials(mqtt({ username: "hoboken" }), {
          MQTT_PASSWORD: password,
        }),
      ).toStrictEqual({ username: "hoboken", password });
    },
  );

  test.each(["a".repeat(65536), "€".repeat(21846)])(
    "rejects an environment password over 65535 bytes",
    (password) => {
      expect(() =>
        resolveMQTTCredentials(mqtt({ username: "hoboken" }), {
          MQTT_PASSWORD: password,
        }),
      ).toThrow("MQTT_PASSWORD must be at most 65535 bytes");
    },
  );

  test("limits a password file to 65535 bytes after its trailing newline", () => {
    const username = "hoboken";
    expect(
      resolveMQTTCredentials(
        mqtt({
          username,
          passwordFile: passwordFile("a".repeat(65535) + "\n"),
        }),
        {},
      ),
    ).toStrictEqual({ username, password: "a".repeat(65535) });
    expect(() =>
      resolveMQTTCredentials(
        mqtt({ username, passwordFile: passwordFile("a".repeat(65536)) }),
        {},
      ),
    ).toThrow("mqtt.passwordFile must be at most 65535 bytes");
  });

  test.each([[""], ["\n"]])("rejects password file content %j", (content) => {
    expect(() =>
      resolveMQTTCredentials(
        mqtt({ username: "hoboken", passwordFile: passwordFile(content) }),
        {},
      ),
    ).toThrow("mqtt.passwordFile is empty");
  });

  test("does not name the password file in the empty file message", () => {
    const file = passwordFile("");
    expect(
      errorMessage(() =>
        resolveMQTTCredentials(
          mqtt({ username: "hoboken", passwordFile: file }),
          {},
        ),
      ),
    ).not.toContain(file);
  });

  test("propagates the error for a missing password file", () => {
    expect(() =>
      resolveMQTTCredentials(
        mqtt({
          username: "hoboken",
          passwordFile: path.join(tmpDir, "missing"),
        }),
        {},
      ),
    ).toThrow("ENOENT");
  });

  test("propagates the error for a password file that is a directory", () => {
    expect(() =>
      resolveMQTTCredentials(
        mqtt({ username: "hoboken", passwordFile: tmpDir }),
        {},
      ),
    ).toThrow("EISDIR");
  });

  describe("error messages never contain the password", () => {
    test("with the secret in the file and no username", () => {
      const file = passwordFile(`${PASSWORD}\n`);
      expect(
        errorMessage(() =>
          resolveMQTTCredentials(mqtt({ passwordFile: file }), {}),
        ),
      ).not.toContain(PASSWORD);
    });

    test("with the secret in the environment and no username", () => {
      expect(
        errorMessage(() =>
          resolveMQTTCredentials(mqtt(), { MQTT_PASSWORD: PASSWORD }),
        ),
      ).not.toContain(PASSWORD);
    });

    test("with the secret in both the file and the environment", () => {
      const file = passwordFile(`${PASSWORD}\n`);
      expect(
        errorMessage(() =>
          resolveMQTTCredentials(
            mqtt({ username: "hoboken", passwordFile: file }),
            { MQTT_PASSWORD: PASSWORD },
          ),
        ),
      ).not.toContain(PASSWORD);
    });
  });

  test.each([
    ["file", () => ({ passwordFile: passwordFile(`${PASSWORD}\n`) }), {}],
    ["environment", () => ({}), { MQTT_PASSWORD: PASSWORD }],
  ] as const)(
    "does not modify or retain the %s password in its input",
    (_source, extra, env) => {
      const input = Object.freeze(mqtt({ username: "hoboken", ...extra() }));
      const before = JSON.stringify(input);
      expect(resolveMQTTCredentials(input, env)).toStrictEqual({
        username: "hoboken",
        password: PASSWORD,
      });
      expect(JSON.stringify(input)).toBe(before);
      expect(before).not.toContain(PASSWORD);
    },
  );
});

describe("credentialOptions", () => {
  test("adds an empty auth to the login", () => {
    expect(
      credentialOptions({ username: "hoboken", password: PASSWORD }),
    ).toStrictEqual({ username: "hoboken", password: PASSWORD, auth: "" });
  });
});

describe("stripMQTTUserinfo", () => {
  test.each([
    ["mqtt://user:pw@broker:1883", "mqtt://broker:1883"],
    ["mqtt://user@broker", "mqtt://broker"],
    ["mqtts://user:pw@broker/path", "mqtts://broker/path"],
    ["mqtt://u:p@ss@broker", "mqtt://broker"],
    ["//user:pw@broker", "//broker"],
    ["mqtt:user:pw@broker:1883", "mqtt:broker:1883"],
    [String.raw`mqtt:\\user:pw@broker`, String.raw`mqtt:\\broker`],
  ])("removes the userinfo from %s", (url, expected) => {
    expect(stripMQTTUserinfo(url)).toBe(expected);
  });

  test.each([
    "mqtt://broker:1883",
    "mqtt://broker:1883/a@b",
    "mqtt://broker:1883?x=a@b",
    "mqtt://broker:1883#a@b",
    "mqtt://[::1]:1883",
    "not a valid url",
  ])("leaves %s unchanged", (url) => {
    expect(stripMQTTUserinfo(url)).toBe(url);
  });
});
