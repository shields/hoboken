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
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  assertMQTTURL,
  credentialOptions,
  displayMQTTURL,
  isMQTTURL,
  loadConfig,
  resolveMQTTCredentials,
  validateConfig,
  withoutErrorMessage,
} from "../src/config.ts";
import type { Config, MqttConfig } from "../src/config.ts";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  INVALID_MQTT_URL,
  MALFORMED_MQTT_URLS,
  SECRET,
  VALID_MQTT_URLS,
  type URLReport,
} from "./mqtt-urls.ts";

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
  ])("rejects unknown heated bedding field %s without its value", (key) => {
    const message = errorMessage(() =>
      validateConfig({
        ...validConfig(),
        heatedBedding: [{ ...heatedBedding, [key]: "never-log-value" }],
      }),
    );
    expect(message).toBe(
      `heatedBedding[0]: unknown field ${JSON.stringify(key)}; supported fields are name, prefix, controller, and zone`,
    );
    expect(message).not.toContain("never-log-value");
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

  describe("mqtt.url", () => {
    function withURL(url: string) {
      return { ...validConfig(), mqtt: { url } };
    }

    test.each(VALID_MQTT_URLS)("accepts %j", (url) => {
      expect(validateConfig(withURL(url)).mqtt).toStrictEqual({ url });
    });

    test.each(MALFORMED_MQTT_URLS)(
      "rejects %j without quoting any of it",
      (url) => {
        let failure: unknown;
        try {
          validateConfig(withURL(url));
        } catch (error) {
          failure = error;
        }
        expect(failure).toStrictEqual(new Error(INVALID_MQTT_URL));
        expect((failure as Error).cause).toBeUndefined();
      },
    );

    test.each([
      "mqtt:user@broker:1883",
      "mqtt:user:pw@broker:1883",
      "//user:pw@broker",
      String.raw`mqtt:\\user:pw@broker:1883`,
      String.raw`mqtt:/\user:pw@broker:1883`,
      String.raw`mqtt:\/user:pw@broker:1883`,
      String.raw`\\user:pw@broker`,
    ])("rejects %j before checking it against mqtt.username", (url) => {
      const data = { ...validConfig(), mqtt: { url, username: "hoboken" } };
      expect(() => validateConfig(data)).toThrow(new Error(INVALID_MQTT_URL));
    });

    describe("in a fresh process", () => {
      let stderr: string;
      let report: URLReport;

      beforeAll(() => {
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(new URL("mqtt-url-report.ts", import.meta.url))],
          {
            encoding: "utf8",
            env: Object.fromEntries(
              Object.entries(process.env).filter(([key]) => key !== "DEBUG"),
            ),
            timeout: 60000,
          },
        );
        expect(result.status).toBe(0);
        stderr = result.stderr;
        report = JSON.parse(result.stdout) as URLReport;
      });

      test("accepts every valid form and rejects every malformed one", () => {
        expect(report.rejectedValid).toStrictEqual([]);
        expect(report.acceptedMalformed).toStrictEqual([]);
      });

      test("mqtt.js builds a client for every valid form but a bare hostname", () => {
        expect(report.mqttJSRejectedValid).toStrictEqual([]);
        expect(report.mqttJSBareHostname).toBe("Missing protocol");
      });

      test("raises no process warning and prints nothing", () => {
        expect(report.warnings).toStrictEqual([]);
        expect(stderr).toBe("");
      });
    });
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
          "mqtt.password is not supported; use mqtt.passwordFile",
        );
        expect(errorMessage(() => validateConfig(data))).not.toContain(
          "hunter2",
        );
      },
    );

    test.each([
      ["user", "never-log-value"],
      ["passwd", "never-log-value"],
      ["userName", "hoboken"],
      ["passwordfile", "/run/secrets/never-log-value"],
      ["password_file", "/run/secrets/never-log-value"],
      ["auth", { username: "hoboken", password: "never-log-value" }],
      ["tls", { ca: "never-log-value" }],
      ["0", "never-log-value"],
    ])("rejects unknown mqtt field %s without its value", (field, value) => {
      const data = withMQTT({ username: "hoboken", [field]: value });
      const message = errorMessage(() => validateConfig(data));
      expect(message).toBe(
        `mqtt: unknown field ${JSON.stringify(field)}; supported fields are url, username, and passwordFile`,
      );
      expect(message).not.toContain("never-log-value");
    });

    test("rejects a login section whose keys are all misspelled", () => {
      const data = withMQTT({ user: "hoboken", passwd: "never-log-value" });
      expect(() => validateConfig(data)).toThrow('unknown field "user"');
    });

    test.each([
      { user: "hoboken", password: "never-log-value" },
      { password: "never-log-value", user: "hoboken" },
    ])("reports mqtt.password rather than an unknown field: %j", (extra) => {
      const message = errorMessage(() => validateConfig(withMQTT(extra)));
      expect(message).toBe(
        "mqtt.password is not supported; use mqtt.passwordFile",
      );
      expect(message).not.toContain("never-log-value");
    });

    test.each([
      "mqtt://user:pw@broker:1883",
      "mqtt://user@broker",
      "mqtt://:pw@broker",
      "mqtts://user:pw@broker/path",
      "mqtt://u:p@ss@broker",
    ])("rejects mqtt.username combined with URL credentials: %s", (url) => {
      const data = withMQTT({ url, username: "hoboken" });
      expect(() => validateConfig(data)).toThrow(
        "mqtt.username cannot be combined with credentials in mqtt.url; use one or the other",
      );
      expect(errorMessage(() => validateConfig(data))).not.toContain("pw");
    });

    test.each([
      "mqtt://broker:1883/a%40b",
      "ws://broker:9001/mqtt?next=%40x",
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

  describe("unknown fields", () => {
    function patched(
      base: Record<string, unknown>,
      changes: Record<string, unknown>,
    ): Record<string, unknown> {
      return Object.fromEntries(
        Object.entries({ ...base, ...changes }).filter(
          ([, value]) => value !== undefined,
        ),
      );
    }

    const secondDevice = {
      name: "Second Light",
      topic: "zigbee2mqtt/second_light",
      capabilities: ["on_off"],
    };
    const secondScene = { name: "Reading", id: 2 };

    const sections: {
      path: string;
      fields: string;
      required: string;
      build: (changes: Record<string, unknown>) => unknown;
    }[] = [
      {
        path: "config",
        fields: "bridge, mqtt, devices, heatedBedding, curtains, and metrics",
        required: "devices",
        build: (changes) => patched(validConfig(), changes),
      },
      {
        path: "bridge",
        fields: "name, mac, pincode, port, and bind",
        required: "port",
        build: (changes) => {
          const config = validConfig();
          return { ...config, bridge: patched(config.bridge, changes) };
        },
      },
      {
        path: "mqtt",
        fields: "url, username, and passwordFile",
        required: "url",
        build: (changes) => {
          const config = validConfig();
          return { ...config, mqtt: patched(config.mqtt, changes) };
        },
      },
      {
        path: "metrics",
        fields: "port and bind",
        required: "port",
        build: (changes) => ({
          ...validConfig(),
          metrics: patched({ port: 9090 }, changes),
        }),
      },
      ...[0, 1].map((index) => ({
        path: `devices[${String(index)}]`,
        fields: "name, type, topic, capabilities, and scenes",
        required: "topic",
        build: (changes: Record<string, unknown>) => {
          const config = validConfig();
          const devices: unknown[] = [config.devices[0], secondDevice].slice(
            0,
            index + 1,
          );
          devices[index] = patched(
            devices[index] as Record<string, unknown>,
            changes,
          );
          return { ...config, devices };
        },
      })),
      ...[0, 1].map((index) => ({
        path: `devices[0].scenes[${String(index)}]`,
        fields: "name and id",
        required: "id",
        build: (changes: Record<string, unknown>) => {
          const config = validConfig();
          const scenes: unknown[] = [
            config.devices[0]!.scenes[0],
            secondScene,
          ].slice(0, index + 1);
          scenes[index] = patched(
            scenes[index] as Record<string, unknown>,
            changes,
          );
          return {
            ...config,
            devices: [{ ...config.devices[0]!, scenes }],
          };
        },
      })),
      ...[0, 1].map((index) => ({
        path: `heatedBedding[${String(index)}]`,
        fields: "name, prefix, controller, and zone",
        required: "zone",
        build: (changes: Record<string, unknown>) => {
          const entries: unknown[] = [
            heatedBedding,
            { ...heatedBedding, controller: "bed2" },
          ].slice(0, index + 1);
          entries[index] = patched(
            entries[index] as Record<string, unknown>,
            changes,
          );
          return { ...validConfig(), heatedBedding: entries };
        },
      })),
      ...[0, 1].map((index) => ({
        path: `curtains[${String(index)}]`,
        fields: "name, prefix, controller, and zone",
        required: "zone",
        build: (changes: Record<string, unknown>) => {
          const entries: unknown[] = [
            heatedBedding,
            { ...heatedBedding, controller: "bed2" },
          ].slice(0, index + 1);
          entries[index] = patched(
            entries[index] as Record<string, unknown>,
            changes,
          );
          return { ...validConfig(), curtains: entries };
        },
      })),
    ];

    test.each(sections)(
      "rejects an unknown field in $path without its value",
      ({ path, fields, build }) => {
        const message = errorMessage(() =>
          validateConfig(build({ typo: "never-log-value" })),
        );
        expect(message).toBe(
          `${path}: unknown field "typo"; supported fields are ${fields}`,
        );
        expect(message).not.toContain("never-log-value");
      },
    );

    test.each(sections)(
      "escapes control characters in an unknown field in $path",
      ({ build }) => {
        const message = errorMessage(() =>
          validateConfig(build({ 'a"\nb': "never-log-value" })),
        );
        expect(message).toContain(String.raw`"a\"\nb"`);
        expect(message).not.toContain("\n");
        expect(message).not.toContain("never-log-value");
      },
    );

    test.each(sections)(
      "rejects fields named like Object.prototype members in $path",
      ({ build }) => {
        for (const key of ["constructor", "toString", "__proto__"]) {
          expect(() =>
            validateConfig(build({ [key]: "never-log-value" })),
          ).toThrow(`unknown field ${JSON.stringify(key)}`);
        }
      },
    );

    test.each(sections)(
      "names a misspelled $required in $path rather than reporting it missing",
      ({ path, required, build }) => {
        const message = errorMessage(() =>
          validateConfig(
            build({
              [required]: undefined,
              [`${required}_typo`]: "never-log-value",
            }),
          ),
        );
        expect(message).toContain(`${path}: unknown field "${required}_typo"`);
        expect(message).not.toContain("never-log-value");
      },
    );

    test("accepts every supported field", () => {
      const config: Config = {
        bridge: {
          name: "Hoboken",
          mac: "0E:42:A1:B2:C3:D4",
          pincode: "031-45-154",
          port: 51826,
          bind: "eno1",
        },
        mqtt: {
          url: MQTT_URL,
          username: "hoboken",
          passwordFile: "/run/secrets/mqtt_password",
        },
        devices: [
          {
            name: "Living Room Light",
            type: "z2m",
            topic: "zigbee2mqtt/living_room_light",
            capabilities: ["on_off", "brightness"],
            scenes: [{ name: "Movie Mode", id: 1 }],
          },
        ],
        heatedBedding: [heatedBedding],
        curtains: [{ ...heatedBedding, controller: "window", zone: "curtain" }],
        metrics: { port: 9090, bind: "127.0.0.1" },
      };
      expect(validateConfig(config)).toStrictEqual(config);
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

  function writeConfig(mqttLines: string, extraLines = ""): string {
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
${extraLines}
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

  test("rejects misspelled login keys in YAML without their values", () => {
    const configPath = writeConfig(
      [
        '  url: "mqtt://localhost:1883"',
        "  user: hoboken",
        "  passwd: never-log-value",
        "  auth:",
        "    password: never-log-value",
      ].join("\n"),
    );
    const message = errorMessage(() => loadConfig(configPath));
    expect(message).toContain('mqtt: unknown field "user"');
    expect(message).not.toContain("never-log-value");
  });

  test("rejects a misspelled metrics key in YAML without its value", () => {
    const configPath = writeConfig(
      '  url: "mqtt://localhost:1883"',
      ["metrics:", "  port: 9090", '  bnd: "127.0.0.1"'].join("\n"),
    );
    const message = errorMessage(() => loadConfig(configPath));
    expect(message).toBe(
      'metrics: unknown field "bnd"; supported fields are port and bind',
    );
    expect(message).not.toContain("127.0.0.1");
  });

  test.each([
    [
      "BAD_DQ_ESCAPE",
      String.raw`  url: "mqtt://svc:pa\s${SECRET}@broker:1883"`,
      22,
    ],
    ["BLOCK_AS_IMPLICIT_KEY", `  url: mqtt://svc:${SECRET}: x@broker:1883`, 8],
    [
      "TAG_RESOLVE_FAILED",
      `  url: !mqtt "mqtt://svc:${SECRET}@broker:1883"`,
      8,
    ],
    ["NON_STRING_KEY", `  ? [ "mqtt://svc:${SECRET}@broker:1883", b ]`, 5],
    ["NON_STRING_KEY", `  ? url: "mqtt://svc:${SECRET}@broker:1883"`, 8],
  ])(
    "reports a YAML %s problem by position, without quoting the line",
    async (code, line, column) => {
      const warnings: string[] = [];
      const record = (warning: Error) => {
        warnings.push(warning.message);
      };
      process.on("warning", record);
      try {
        const configPath = writeConfig(line);
        const message = errorMessage(() => loadConfig(configPath));
        await new Promise((resolve) => setImmediate(resolve));
        expect(message).toBe(
          `${configPath}: invalid YAML (${code} at line 8, column ${String(column)})`,
        );
        expect(warnings).toStrictEqual([]);
      } finally {
        process.off("warning", record);
      }
    },
  );

  test("reports an alias with no anchor without quoting it or chaining its error", () => {
    const configPath = writeConfig(`  url: *mqtt://svc:${SECRET}@broker:1883`);
    let failure: unknown;
    try {
      loadConfig(configPath);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `${configPath}: invalid YAML (alias error)`,
    );
    expect((failure as Error).cause).toBeUndefined();
  });

  test("loads the shipped example configuration", () => {
    const config = loadConfig(
      fileURLToPath(new URL("../config.yaml", import.meta.url)),
    );
    expect(config.devices.length).toBeGreaterThan(0);
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

  function passwordFile(content: string | Uint8Array): string {
    const file = path.join(tmpDir, "password");
    writeFileSync(file, content);
    return file;
  }

  test("returns undefined when nothing is configured", () => {
    expect(resolveMQTTCredentials(mqtt())).toBeUndefined();
  });

  test("returns undefined for credentials embedded in the URL", () => {
    expect(
      resolveMQTTCredentials(mqtt({ url: "mqtt://u:p@h" })),
    ).toBeUndefined();
  });

  test.each([
    ["s3cret", "s3cret"],
    ["s3cret\n", "s3cret"],
    ["s3cret\n\n", "s3cret\n"],
    [" a b \n", " a b "],
    ["multi\nline\n", "multi\nline"],
    ["x\r\n", "x"],
    ["x\r", "x\r"],
    ["x\r\r\n", "x\r"],
    ["x\r\n\r\n", "x\r\n"],
    ["x\n\r\n", "x\n"],
    ["a\r\nb\r\n", "a\r\nb"],
    ["a\n\nb\n", "a\n\nb"],
    ["pässwörd€\n", "pässwörd€"],
    ["pässwörd€\r\n", "pässwörd€"],
    ["🔑\r\n", "🔑"],
    ["a\0b\n", "a\0b"],
  ])("reads password file content %j as %j", (content, expected) => {
    expect(
      resolveMQTTCredentials(
        mqtt({ username: "hoboken", passwordFile: passwordFile(content) }),
      ),
    ).toStrictEqual({ username: "hoboken", password: expected });
  });

  test.each([
    ["no line ending", "\u{FEFF}s3cret", "s3cret"],
    ["a line feed", "\u{FEFF}s3cret\n", "s3cret"],
    ["a carriage return and line feed", "\u{FEFF}s3cret\r\n", "s3cret"],
    ["non-ASCII text", "\u{FEFF}pässwörd€\r\n", "pässwörd€"],
    ["a second one", "\u{FEFF}\u{FEFF}s3cret\n", "\u{FEFF}s3cret"],
    ["one before the line ending", "s3cret\u{FEFF}\n", "s3cret\u{FEFF}"],
  ])(
    "reads a password file with a byte order mark and %s",
    (_case, content, expected) => {
      expect(
        resolveMQTTCredentials(
          mqtt({ username: "hoboken", passwordFile: passwordFile(content) }),
        ),
      ).toStrictEqual({ username: "hoboken", password: expected });
    },
  );

  test("requires a password file for a username", () => {
    expect(() => resolveMQTTCredentials(mqtt({ username: "hoboken" }))).toThrow(
      "mqtt.username requires mqtt.passwordFile",
    );
  });

  test("requires a username for a password file", () => {
    expect(() =>
      resolveMQTTCredentials(mqtt({ passwordFile: passwordFile("x") })),
    ).toThrow("mqtt.passwordFile requires mqtt.username");
  });

  test("requires a username for a password file before reading it", () => {
    expect(() =>
      resolveMQTTCredentials(
        mqtt({ passwordFile: path.join(tmpDir, "missing") }),
      ),
    ).toThrow("mqtt.passwordFile requires mqtt.username");
  });

  describe("with MQTT_PASSWORD set in the environment", () => {
    const original = process.env.MQTT_PASSWORD;

    afterEach(() => {
      if (original === undefined) delete process.env.MQTT_PASSWORD;
      else process.env.MQTT_PASSWORD = original;
    });

    test.each([[PASSWORD], [""]])(
      "does not take the password of a username from %j",
      (value) => {
        process.env.MQTT_PASSWORD = value;
        const message = errorMessage(() =>
          resolveMQTTCredentials(mqtt({ username: "hoboken" })),
        );
        expect(message).toBe("mqtt.username requires mqtt.passwordFile");
      },
    );

    test.each([[PASSWORD], [""]])(
      "does not count %j as a password for a missing username",
      (value) => {
        process.env.MQTT_PASSWORD = value;
        expect(resolveMQTTCredentials(mqtt())).toBeUndefined();
      },
    );

    test.each([[`other-${PASSWORD}`], [""]])(
      "reads the password file rather than %j",
      (value) => {
        process.env.MQTT_PASSWORD = value;
        expect(
          resolveMQTTCredentials(
            mqtt({
              username: "hoboken",
              passwordFile: passwordFile(`${PASSWORD}\n`),
            }),
          ),
        ).toStrictEqual({ username: "hoboken", password: PASSWORD });
      },
    );
  });

  test("limits a password file to 65535 bytes after its trailing newline", () => {
    const username = "hoboken";
    expect(
      resolveMQTTCredentials(
        mqtt({
          username,
          passwordFile: passwordFile("a".repeat(65535) + "\n"),
        }),
      ),
    ).toStrictEqual({ username, password: "a".repeat(65535) });
    expect(() =>
      resolveMQTTCredentials(
        mqtt({ username, passwordFile: passwordFile("a".repeat(65536)) }),
      ),
    ).toThrow("mqtt.passwordFile must be at most 65535 bytes");
  });

  test("limits a password file to 65535 bytes after its byte order mark and CRLF", () => {
    const username = "hoboken";
    expect(
      resolveMQTTCredentials(
        mqtt({
          username,
          passwordFile: passwordFile("\u{FEFF}" + "€".repeat(21845) + "\r\n"),
        }),
      ),
    ).toStrictEqual({ username, password: "€".repeat(21845) });
    expect(() =>
      resolveMQTTCredentials(
        mqtt({
          username,
          passwordFile: passwordFile("\u{FEFF}" + "€".repeat(21846) + "\r\n"),
        }),
      ),
    ).toThrow("mqtt.passwordFile must be at most 65535 bytes");
  });

  test.each([
    ["no content", ""],
    ["only a line feed", "\n"],
    ["only a carriage return and line feed", "\r\n"],
    ["only a byte order mark", "\u{FEFF}"],
    ["only a byte order mark and line feed", "\u{FEFF}\n"],
    ["only a byte order mark and CRLF", "\u{FEFF}\r\n"],
  ])("rejects a password file with %s", (_case, content) => {
    expect(() =>
      resolveMQTTCredentials(
        mqtt({ username: "hoboken", passwordFile: passwordFile(content) }),
      ),
    ).toThrow("mqtt.passwordFile is empty");
  });

  describe("rejects a password file that is not valid UTF-8", () => {
    const secret = Buffer.from(PASSWORD);

    test.each([
      [
        "UTF-16LE with a byte order mark",
        Buffer.from("\u{FEFF}s3cret\n", "utf16le"),
      ],
      [
        "UTF-16BE with a byte order mark",
        Buffer.from("\u{FEFF}s3cret\n", "utf16le").swap16(),
      ],
      ["a lone continuation byte", Buffer.from([0x80])],
      ["a truncated sequence", Buffer.from([0x61, 0xe2, 0x82])],
      ["an overlong encoding", Buffer.from([0xc0, 0xaf])],
      ["an encoded surrogate", Buffer.from([0xed, 0xa0, 0x80])],
      ["a Latin-1 byte", Buffer.from([0x70, 0xe4, 0x73, 0x73, 0x0a])],
      [
        "an invalid byte after the secret",
        Buffer.concat([secret, Buffer.from([0xff, 0x0a])]),
      ],
      [
        "an invalid byte after a byte order mark",
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          secret,
          Buffer.from([0xff]),
        ]),
      ],
    ])("with %s", (_description, content) => {
      const file = passwordFile(content);
      const message = errorMessage(() =>
        resolveMQTTCredentials(
          mqtt({ username: "hoboken", passwordFile: file }),
        ),
      );
      expect(message).toBe("mqtt.passwordFile is not valid UTF-8");
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain(file);
    });

    test("before applying the size limit", () => {
      expect(() =>
        resolveMQTTCredentials(
          mqtt({
            username: "hoboken",
            passwordFile: passwordFile(
              Buffer.concat([Buffer.alloc(65536, 0x61), Buffer.from([0xff])]),
            ),
          }),
        ),
      ).toThrow("mqtt.passwordFile is not valid UTF-8");
    });
  });

  test("does not name the password file in the empty file message", () => {
    const file = passwordFile("");
    expect(
      errorMessage(() =>
        resolveMQTTCredentials(
          mqtt({ username: "hoboken", passwordFile: file }),
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
      ),
    ).toThrow("ENOENT");
  });

  test("propagates the error for a password file that is a directory", () => {
    expect(() =>
      resolveMQTTCredentials(
        mqtt({ username: "hoboken", passwordFile: tmpDir }),
      ),
    ).toThrow("EISDIR");
  });

  test("error messages never contain the password", () => {
    const file = passwordFile(`${PASSWORD}\n`);
    expect(
      errorMessage(() => resolveMQTTCredentials(mqtt({ passwordFile: file }))),
    ).not.toContain(PASSWORD);
  });

  test("does not modify or retain the password in its input", () => {
    const input = Object.freeze(
      mqtt({
        username: "hoboken",
        passwordFile: passwordFile(`${PASSWORD}\n`),
      }),
    );
    const before = JSON.stringify(input);
    expect(resolveMQTTCredentials(input)).toStrictEqual({
      username: "hoboken",
      password: PASSWORD,
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(before).not.toContain(PASSWORD);
  });
});

describe("credentialOptions", () => {
  test("adds an empty auth to the login", () => {
    expect(
      credentialOptions({ username: "hoboken", password: PASSWORD }),
    ).toStrictEqual({ username: "hoboken", password: PASSWORD, auth: "" });
  });
});

describe("assertMQTTURL", () => {
  test.each(VALID_MQTT_URLS)("accepts %j", (url) => {
    expect(isMQTTURL(url)).toBe(true);
    expect(() => {
      assertMQTTURL(url);
    }).not.toThrow();
  });

  test.each(MALFORMED_MQTT_URLS)("rejects %j without quoting it", (url) => {
    expect(isMQTTURL(url)).toBe(false);
    expect(() => {
      assertMQTTURL(url);
    }).toThrow(new Error(INVALID_MQTT_URL));
  });
});

describe("isMQTTURL while Node.js ignores deprecations", () => {
  const original = Object.getOwnPropertyDescriptor(process, "noDeprecation");

  afterEach(() => {
    if (original) Object.defineProperty(process, "noDeprecation", original);
    else Reflect.deleteProperty(process, "noDeprecation");
  });

  test("reads a URL although --no-deprecation makes noDeprecation read-only", () => {
    Object.defineProperty(process, "noDeprecation", {
      value: true,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    expect(isMQTTURL(MQTT_URL)).toBe(true);
    expect(displayMQTTURL(MQTT_URL)).toBe(MQTT_URL);
    expect(process.noDeprecation).toBe(true);
  });

  test("leaves deprecation warnings enabled", () => {
    process.noDeprecation = false;
    expect(isMQTTURL(MQTT_URL)).toBe(true);
    expect(process.noDeprecation).toBe(false);
  });

  test("leaves noDeprecation absent when it was absent", () => {
    Reflect.deleteProperty(process, "noDeprecation");
    expect(isMQTTURL(MQTT_URL)).toBe(true);
    expect(Object.hasOwn(process, "noDeprecation")).toBe(false);
  });

  test("puts back a truthy value other than true", () => {
    Reflect.set(process, "noDeprecation", 1);
    expect(isMQTTURL(MQTT_URL)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(process, "noDeprecation")?.value,
    ).toBe(1);
  });
});

describe("displayMQTTURL", () => {
  test.each([
    ["mqtt://user:pw@broker:1883", "mqtt://broker:1883"],
    ["mqtt://user@broker", "mqtt://broker"],
    ["mqtts://user:pw@broker/path", "mqtts://broker"],
    ["mqtt://u:p@ss@broker", "mqtt://broker"],
    ["ws://user:pw@broker:9001/mqtt", "ws://broker:9001"],
    ["MQTT://Broker:1883", "mqtt://broker:1883"],
    ["mqtt://broker:1883", "mqtt://broker:1883"],
    ["mqtt://[::1]:1883", "mqtt://[::1]:1883"],
    ["mqtt://broker:1883/a%40b", "mqtt://broker:1883"],
    ["wss://broker/mqtt?token=a%20b", "wss://broker"],
  ])("shows %s as %s", (url, expected) => {
    expect(displayMQTTURL(url)).toBe(expected);
  });

  test("shows only the host of a URL with a token in its query", () => {
    expect(displayMQTTURL(`wss://broker/mqtt?token=${SECRET}`)).toBe(
      "wss://broker",
    );
  });

  test("shows the broker alone for every accepted URL that has userinfo", () => {
    const alphabet = ["@", ":", "/", "?", "#", "\\", "%", "2", "q"];
    const passwords = [""];
    for (let start = 0, length = 0; length < 4; length++) {
      const end = passwords.length;
      for (const prefix of passwords.slice(start, end)) {
        for (const character of alphabet) passwords.push(prefix + character);
      }
      start = end;
    }
    const leaks: string[] = [];
    let accepted = 0;
    for (const scheme of ["mqtt", "ws"]) {
      for (const user of ["hoboken", ""]) {
        for (const password of passwords) {
          const url = `${scheme}://${user}:${password}@broker:1883`;
          if (!isMQTTURL(url)) continue;
          accepted++;
          if (displayMQTTURL(url) !== `${scheme}://broker:1883`)
            leaks.push(url);
        }
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(leaks).toStrictEqual([]);
  });

  test.each(MALFORMED_MQTT_URLS)("shows %j as a placeholder", (url) => {
    expect(displayMQTTURL(url)).toBe("(not shown)");
  });
});

describe("withoutErrorMessage", () => {
  function failureOf(fn: () => unknown): Error & { code?: unknown } {
    try {
      withoutErrorMessage(fn);
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the call to throw");
  }

  test("returns the result of the operation", () => {
    expect(withoutErrorMessage(() => 42)).toBe(42);
  });

  test("keeps only the code of an error that quotes the URL", () => {
    const quoted = Object.assign(
      new Error(`The argument 'url' mqtt://user:${SECRET}@h:1x`, {
        cause: new Error(SECRET),
      }),
      { code: "ERR_INVALID_ARG_VALUE" },
    );
    const failure = failureOf(() => {
      throw quoted;
    });
    expect(failure).not.toBe(quoted);
    expect(failure.message).toBe("MQTT client could not be started");
    expect(failure.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(failure.cause).toBeUndefined();
    expect(failure.stack).not.toContain(SECRET);
  });

  test.each([
    `mqtt://user:${SECRET}@h`,
    42,
    null,
    undefined,
    { code: 5 },
    Object.assign(new Error(SECRET), { code: { url: SECRET } }),
    new Error(SECRET),
  ])("drops everything but a string code from the thrown %j", (thrown) => {
    const failure = failureOf(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- mqtt.js and Node can throw anything.
      throw thrown;
    });
    expect(failure.message).toBe("MQTT client could not be started");
    expect("code" in failure).toBe(false);
    expect(failure.stack).not.toContain(SECRET);
  });
});
