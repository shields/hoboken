import { describe, expect, test, afterEach } from "bun:test";
import { Registry } from "prom-client";
import { createMetrics, startMetricsServer } from "../src/metrics.ts";
import type { MetricsServer } from "../src/metrics.ts";
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
    console.error = () => undefined;

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
