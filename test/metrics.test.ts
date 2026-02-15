import { describe, expect, test, afterEach } from "bun:test";
import { Registry } from "prom-client";
import {
  createMetrics,
  msUntilChange,
  startMetricsServer,
} from "../src/metrics.ts";
import type { GetStatusFn, MetricsServer, StatusData } from "../src/metrics.ts";
import type { Server } from "node:http";

function addr(server: Server): number {
  const a = server.address();
  return typeof a === "object" && a ? a.port : 0;
}

async function listening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
}

describe("createMetrics", () => {
  test("registers all custom metrics", async () => {
    const register = new Registry();
    createMetrics(register);

    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toContain("hoboken_mqtt_connected");
    expect(names).toContain("hoboken_mqtt_messages_received_total");
    expect(names).toContain("hoboken_mqtt_messages_published_total");
    expect(names).toContain("hoboken_mqtt_errors_total");
    expect(names).toContain("hoboken_devices_configured");
    expect(names).toContain("hoboken_hap_connections_active");
    expect(names).toContain("hoboken_hap_pair_verify_total");
  });

  test("includes default process metrics", async () => {
    const register = new Registry();
    createMetrics(register);

    const names = (await register.getMetricsAsJSON()).map((m) => m.name);
    expect(names).toContain("process_cpu_seconds_total");
  });

  test("counter and gauge values update correctly", async () => {
    const register = new Registry();
    const metrics = createMetrics(register);

    metrics.mqttConnected.set(1);
    metrics.mqttErrors.inc();
    metrics.mqttErrors.inc();
    metrics.mqttMessagesPublished.inc();
    metrics.mqttMessagesReceived.labels("test_device").inc();
    metrics.devicesConfigured.set(3);

    const connected = await register.getSingleMetricAsString(
      "hoboken_mqtt_connected",
    );
    expect(connected).toContain("1");

    const errors = await register.getSingleMetricAsString(
      "hoboken_mqtt_errors_total",
    );
    expect(errors).toContain("2");

    const published = await register.getSingleMetricAsString(
      "hoboken_mqtt_messages_published_total",
    );
    expect(published).toContain("1");

    const received = await register.getSingleMetricAsString(
      "hoboken_mqtt_messages_received_total",
    );
    expect(received).toContain('device="test_device"');

    const devices = await register.getSingleMetricAsString(
      "hoboken_devices_configured",
    );
    expect(devices).toContain("3");

    metrics.hapConnectionsActive.inc();
    metrics.hapConnectionsActive.inc();
    metrics.hapConnectionsActive.dec();
    const hapConn = await register.getSingleMetricAsString(
      "hoboken_hap_connections_active",
    );
    expect(hapConn).toContain("1");

    metrics.hapPairVerify.inc();
    metrics.hapPairVerify.inc();
    const hapPv = await register.getSingleMetricAsString(
      "hoboken_hap_pair_verify_total",
    );
    expect(hapPv).toContain("2");
  });

  test("dispose clears the registry", async () => {
    const register = new Registry();
    const metrics = createMetrics(register);

    const before = (await register.getMetricsAsJSON()).length;
    expect(before).toBeGreaterThan(0);

    metrics.dispose();

    const after = (await register.getMetricsAsJSON()).length;
    expect(after).toBe(0);
  });
});

describe("startMetricsServer", () => {
  let ms: MetricsServer | undefined;

  afterEach(async () => {
    if (ms) {
      await new Promise<void>((resolve, reject) => {
        ms!.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      ms = undefined;
    }
  });

  test("serves metrics on GET /metrics", async () => {
    const register = new Registry();
    createMetrics(register);
    ms = startMetricsServer(0, register);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain("hoboken_mqtt_connected");
    expect(body).toContain("process_cpu_seconds_total");
  });

  test("returns 404 for other paths", async () => {
    const register = new Registry();
    ms = startMetricsServer(0, register);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/other`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for non-GET requests to /metrics", async () => {
    const register = new Registry();
    ms = startMetricsServer(0, register);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/metrics`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("returns 500 when registry.metrics() rejects", async () => {
    const register = new Registry();
    register.metrics = () => Promise.reject(new Error("boom"));
    ms = startMetricsServer(0, register);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe("boom");
  });

  test("accepts explicit bind address", async () => {
    const register = new Registry();
    createMetrics(register);
    ms = startMetricsServer(0, register, "127.0.0.1");

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(res.status).toBe(200);
  });

  test("exits on server error", async () => {
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    process.exit = ((code: number) => {
      exitCode = code;
    }) as never;

    const origError = console.error;
    console.error = () => {
      /* suppress */
    };

    try {
      const register = new Registry();
      ms = startMetricsServer(0, register);

      await listening(ms.server);

      ms.server.emit("error", new Error("EADDRINUSE"));
      expect(exitCode).toBe(1);
    } finally {
      process.exit = origExit;
      console.error = origError;
    }
  });

  test("healthz returns 200", async () => {
    const register = new Registry();
    ms = startMetricsServer(0, register);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("readyz returns 503 before setReady, 200 after", async () => {
    const register = new Registry();
    ms = startMetricsServer(0, register);

    await listening(ms.server);
    const port = addr(ms.server);

    const before = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
    expect(before.status).toBe(503);
    expect(await before.text()).toBe("not ready");

    ms.setReady();

    const after = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe("ok");
  });
});

function makeStatus(overrides?: Partial<StatusData>): StatusData {
  return {
    mqtt: { url: "mqtt://localhost:1883", connected: true },
    hap: {
      connections: [
        { remoteAddress: "192.168.1.10", authenticated: true },
        { remoteAddress: "192.168.1.20", authenticated: false },
      ],
    },
    bridge: { name: "Test Bridge", version: "1.0.0" },
    devices: [
      {
        name: "Desk Lamp",
        topic: "desk_lamp",
        capabilities: ["on_off", "brightness"],
        state: { state: "ON", brightness: 200 },
      },
    ],
    ...overrides,
  };
}

describe("SSE (GET /events)", () => {
  let ms: MetricsServer | undefined;

  afterEach(async () => {
    if (ms) {
      const s = ms.server;
      ms = undefined;
      if (s.listening) {
        await new Promise<void>((resolve, reject) => {
          s.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        s.closeAllConnections();
      }
    }
  });

  test("startMetricsServer returns notifyStateChange function", () => {
    const register = new Registry();
    ms = startMetricsServer(0, register);
    expect(typeof ms.notifyStateChange).toBe("function");
  });

  test("GET /events returns SSE headers", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${String(port)}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    controller.abort();
  });

  test("GET /events returns 404 without getStatus", async () => {
    const register = new Registry();
    ms = startMetricsServer(0, register);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/events`);
    expect(res.status).toBe(404);
  });

  test("initial SSE event contains current state", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${String(port)}/events`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("data:");
    expect(text).toContain("Desk Lamp");
    expect(text).toContain("mqtt://localhost:1883");
    controller.abort();
  });

  test("notifyStateChange pushes events to connected clients", async () => {
    const register = new Registry();
    let state: Record<string, unknown> = { state: "ON", brightness: 200 };
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Desk Lamp",
            topic: "desk_lamp",
            capabilities: ["on_off", "brightness"],
            state,
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${String(port)}/events`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    // Read and discard initial event
    await reader.read();

    // Update state and notify
    state = { state: "OFF", brightness: 100 };
    ms.notifyStateChange();

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("data:");
    expect(text).toContain("OFF");
    controller.abort();
  });

  test("disconnected clients are cleaned up without error", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${String(port)}/events`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();

    // Disconnect
    controller.abort();
    // Small delay for close event to propagate
    await new Promise((r) => setTimeout(r, 50));

    // Should not throw
    ms.notifyStateChange();
  });

  test("POST /events returns 404", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/events`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});

describe("status page (GET /)", () => {
  let ms: MetricsServer | undefined;

  afterEach(async () => {
    if (ms) {
      await new Promise<void>((resolve, reject) => {
        ms!.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      ms = undefined;
    }
  });

  test("returns HTML status page", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");

    const body = await res.text();
    expect(body).toContain("Test Bridge");
    expect(body).toContain("Version 1.0.0");
    expect(body).toContain("mqtt://localhost:1883");
    expect(body).toContain("\u2713");
    expect(body).toContain("Desk Lamp");
    expect(body).toContain("desk_lamp");
  });

  test("shows 'MQTT state' label", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("MQTT state");
  });

  test("does not render capabilities subtitle", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).not.toContain('class="subtitle"');
  });

  test("HomeKit section shows on_off capability with On characteristic", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            state: { state: "ON" },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("HomeKit");
    expect(body).toContain("on_off");
    expect(body).toContain("On");
    expect(body).toContain("true");
  });

  test("HomeKit On shows false when state is OFF", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            state: { state: "OFF" },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("false");
  });

  test("HomeKit section appears before MQTT state", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    const hkIndex = body.indexOf("HomeKit");
    const mqttIndex = body.indexOf("MQTT state");
    expect(hkIndex).toBeGreaterThan(-1);
    expect(mqttIndex).toBeGreaterThan(-1);
    expect(hkIndex).toBeLessThan(mqttIndex);
  });

  test("HomeKit value cells have data-vt attributes with hk- infix", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "desk/lamp",
            capabilities: ["on_off", "brightness"],
            state: { state: "ON", brightness: 200 },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain('data-vt="v-desk-lamp-hk-On"');
    expect(body).toContain('data-vt="v-desk-lamp-hk-Brightness"');
  });

  test("HomeKit shows en-dash for missing state fields", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off", "brightness", "color_temp", "color_hs"],
            state: { state: "ON" },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    // brightness, color_temp, hue, saturation should all show en-dash
    const enDashCount = (body.match(/\u2014/g) ?? []).length;
    expect(enDashCount).toBeGreaterThanOrEqual(4);
  });

  test("HomeKit Hue and Saturation from color_hs capability", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off", "color_hs"],
            state: { state: "ON", color: { hue: 240, saturation: 80 } },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("Hue");
    expect(body).toContain("240\u00B0");
    expect(body).toContain("Saturation");
    expect(body).toContain("80%");
  });

  test("HomeKit ColorTemperature shows mireds", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off", "color_temp"],
            state: { state: "ON", color_temp: 370 },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("ColorTemperature");
    expect(body).toContain("370 mireds");
  });

  test("HomeKit ColorTemperature clamps out-of-range values", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off", "color_temp"],
            state: { state: "ON", color_temp: 50 },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("140 mireds");
  });

  test("HomeKit Brightness shows percentage", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off", "brightness"],
            state: { state: "ON", brightness: 200 },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    // HomeKit table should show brightness row
    expect(body).toContain("Brightness");
    expect(body).toContain("79%");
  });

  test("HomeKit shows 'No state received' when state is null", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "New Bulb",
            topic: "new_bulb",
            capabilities: ["on_off"],
            state: null,
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    // Both HomeKit and MQTT state sections show "No state received"
    const matches = body.match(/No state received/g);
    expect(matches?.length).toBe(2);
  });

  test("returns 404 when no getStatus provided", async () => {
    const register = new Registry();
    ms = startMetricsServer(0, register);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/`);
    expect(res.status).toBe(404);
  });

  test("includes device state values", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Bulb",
            topic: "bulb",
            capabilities: ["on_off"],
            state: { state: "OFF", brightness: 128 },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("OFF");
    expect(body).toContain("128");
  });

  test("shows null state for uncached devices", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "New Bulb",
            topic: "new_bulb",
            capabilities: ["on_off"],
            state: null,
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("No state received");
  });

  test("includes EventSource script and content wrapper", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain('id="content"');
    expect(body).toContain('EventSource("/events")');
  });

  test("POST / returns 404", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const res = await fetch(`http://127.0.0.1:${String(port)}/`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("escapes HTML in state values", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Evil",
            topic: "evil",
            capabilities: ["on_off"],
            state: { xss: '<script>alert("xss")</script>' },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).not.toContain('<script>alert("xss")</script>');
    expect(body).toContain("&lt;script&gt;");
  });

  test("shows scenes when present", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            scenes: [{ name: "Relax", id: 1 }],
            state: { state: "ON" },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("Relax");
    expect(body).toContain("id: 1");
  });

  test("shows MQTT disconnected status", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({ mqtt: { url: "mqtt://localhost:1883", connected: false } });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("disconnected");
  });

  test("renders connection IPs and auth status", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("192.168.1.10");
    expect(body).toContain("192.168.1.20");
    expect(body).toContain("\u2713");
    expect(body).toContain("pairing");
  });

  test("renders 'none' when no connections", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({ hap: { connections: [] } });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("none");
  });

  test("brightness annotation shows percentage", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off", "brightness"],
            state: { brightness: 200 },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("\u2192 79%");
  });

  test("color_temp annotation shows Kelvin", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off", "color_temp"],
            state: { color_temp: 370 },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("\u2192 2703 K");
  });

  test("color_hs annotation shows swatch", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off", "color_hs"],
            state: { color: { hue: 240, saturation: 80 } },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("hsl(240,80%,50%)");
    expect(body).toContain('class="swatch"');
  });

  test("last_seen annotation shows time ago", async () => {
    const register = new Registry();
    const recent = new Date(Date.now() - 3 * 60000).toISOString();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            state: { last_seen: recent },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("\u2192 3m ago");
  });

  test("last_seen annotation with hours", async () => {
    const register = new Registry();
    const hoursAgo = new Date(
      Date.now() - (2 * 3_600_000 + 15 * 60000),
    ).toISOString();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            state: { last_seen: hoursAgo },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("\u2192 2h 15m ago");
  });

  test("last_seen annotation with exact hours", async () => {
    const register = new Registry();
    const exactHours = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            state: { last_seen: exactHours },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("\u2192 5h ago");
    expect(body).not.toContain("5h 0m");
  });

  test("last_seen annotation with days", async () => {
    const register = new Registry();
    const daysAgo = new Date(
      Date.now() - (3 * 86_400_000 + 7 * 3_600_000),
    ).toISOString();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            state: { last_seen: daysAgo },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("\u2192 3d 7h ago");
  });

  test("last_seen annotation with exact days", async () => {
    const register = new Registry();
    const exactDays = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            state: { last_seen: exactDays },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("\u2192 2d ago");
    expect(body).not.toContain("2d 0h");
  });

  test("last_seen annotation ignores invalid dates", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            state: { last_seen: "not-a-date" },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).not.toContain("data-ts=");
    expect(body).not.toContain('class="hint"');
  });

  test("no annotations for unrecognized keys", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off"],
            state: { state: "ON", custom_key: 42 },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).not.toContain('class="hint"');
    expect(body).not.toContain('class="swatch"');
  });

  test("value cells have data-vt attributes for view transitions", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "desk/lamp",
            capabilities: ["on_off", "brightness"],
            state: { state: "ON", brightness: 200 },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain('data-vt="v-desk-lamp-state"');
    expect(body).toContain('data-vt="v-desk-lamp-brightness"');
  });

  test("does not render Key/Value table header", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).not.toContain("<thead>");
    expect(body).not.toContain("<th>");
  });

  test("includes flip animation CSS keyframes", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("@keyframes flip-out");
    expect(body).toContain("@keyframes flip-in");
    expect(body).toContain("rotateX(90deg)");
    expect(body).toContain("rotateX(-90deg)");
  });

  test("includes prefers-reduced-motion media query", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("prefers-reduced-motion: reduce");
    expect(body).toContain("animation-duration: 0s");
  });

  test("wraps SSE update in startViewTransition with fallback", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain("startViewTransition");
  });

  test("SSE content diff detects only changed values across updates", async () => {
    const register = new Registry();
    let state: Record<string, unknown> = { state: "ON", brightness: 200 };
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Lamp",
            topic: "lamp",
            capabilities: ["on_off", "brightness"],
            state,
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${String(port)}/events`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const event1 = new TextDecoder().decode((await reader.read()).value);

    // Update 1: only brightness changes
    state = { state: "ON", brightness: 100 };
    ms.notifyStateChange();
    const event2 = new TextDecoder().decode((await reader.read()).value);

    // Update 2: only state changes
    state = { state: "OFF", brightness: 100 };
    ms.notifyStateChange();
    const event3 = new TextDecoder().decode((await reader.read()).value);

    controller.abort();

    // Parse data-vt → cell text from SSE payloads
    const parse = (raw: string): Map<string, string> => {
      const html = raw.replaceAll(/^data: /gm, "");
      const map = new Map<string, string>();
      for (const m of html.matchAll(/data-vt="([^"]+)"[^>]*>([^<]*)/g)) {
        if (m[1] && m[2] !== undefined) map.set(m[1], m[2]);
      }
      return map;
    };
    const vals1 = parse(event1);
    const vals2 = parse(event2);
    const vals3 = parse(event3);

    // Between event1 and event2: brightness changed, state did not
    expect(vals1.get("v-lamp-state")).toBe(vals2.get("v-lamp-state"));
    expect(vals1.get("v-lamp-brightness")).not.toBe(
      vals2.get("v-lamp-brightness"),
    );

    // Between event2 and event3: state changed, brightness did not
    expect(vals2.get("v-lamp-state")).not.toBe(vals3.get("v-lamp-state"));
    expect(vals2.get("v-lamp-brightness")).toBe(vals3.get("v-lamp-brightness"));
  });

  test("client JS clears stale viewTransitionName on unchanged cells", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () => makeStatus();
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    // Regression: the buggy version only set viewTransitionName on changed cells
    // (if (changed[name]) set), leaving stale names from previous transitions.
    // The fix assigns to ALL cells, clearing unchanged ones.
    expect(body).toContain('changed[name] ? name : ""');
  });

  test("last_seen hint includes data-ts attribute", async () => {
    const register = new Registry();
    const ts = new Date(Date.now() - 120000).toISOString();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Sensor",
            topic: "sensor",
            capabilities: ["on_off"],
            state: { last_seen: ts },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).toContain(`data-ts="${ts}"`);
    expect(body).toContain("2m ago");
  });

  test("last_seen data-ts attribute escapes HTML in timestamp", async () => {
    const register = new Registry();
    const getStatus: GetStatusFn = () =>
      makeStatus({
        devices: [
          {
            name: "Sensor",
            topic: "sensor",
            capabilities: ["on_off"],
            state: { last_seen: '<script>"xss"</script>' },
          },
        ],
      });
    ms = startMetricsServer(0, register, undefined, getStatus);

    await listening(ms.server);
    const port = addr(ms.server);

    const body = await (
      await fetch(`http://127.0.0.1:${String(port)}/`)
    ).text();
    expect(body).not.toContain('<script>"xss"</script>');
  });
});

describe("msUntilChange", () => {
  test("seconds range: next change in ~1s", () => {
    expect(msUntilChange(0)).toBe(1000);
    expect(msUntilChange(500)).toBe(500);
    expect(msUntilChange(30000)).toBe(1000);
    expect(msUntilChange(59000)).toBe(1000);
    expect(msUntilChange(59500)).toBe(500);
  });

  test("minutes range: next change at minute boundary", () => {
    expect(msUntilChange(60000)).toBe(60000);
    expect(msUntilChange(90000)).toBe(30000);
    expect(msUntilChange(3_540_000)).toBe(60000);
    expect(msUntilChange(3_599_000)).toBe(1000);
  });

  test("hours range: next change at minute boundary", () => {
    expect(msUntilChange(3_600_000)).toBe(60000);
    expect(msUntilChange(7_200_000)).toBe(60000);
    expect(msUntilChange(86_340_000)).toBe(60000);
    expect(msUntilChange(86_399_000)).toBe(1000);
  });

  test("days range: next change at hour boundary", () => {
    expect(msUntilChange(86_400_000)).toBe(3_600_000);
    expect(msUntilChange(91_800_000)).toBe(1_800_000);
    expect(msUntilChange(172_800_000)).toBe(3_600_000);
  });
});
