import { createServer } from "node:http";
import type { Server } from "node:http";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import * as log from "./log.ts";

export interface Metrics {
  mqttConnected: Gauge;
  mqttMessagesReceived: Counter;
  mqttMessagesPublished: Counter;
  mqttErrors: Counter;
  devicesConfigured: Gauge;
  hapConnectionsActive: Gauge;
  hapPairVerify: Counter;
  dispose: () => void;
}

export function createMetrics(register: Registry): Metrics {
  // prom-client v15: collectDefaultMetrics() returns void (not a stop function).
  // Its internal timers are cleaned up by register.clear() in dispose() below.
  collectDefaultMetrics({ register });

  const mqttConnected = new Gauge({
    name: "hoboken_mqtt_connected",
    help: "Whether the MQTT client is currently connected (1=connected, 0=disconnected)",
    registers: [register],
  });

  const mqttMessagesReceived = new Counter({
    name: "hoboken_mqtt_messages_received_total",
    help: "Total MQTT messages received from device topics",
    labelNames: ["device"] as const,
    registers: [register],
  });

  const mqttMessagesPublished = new Counter({
    name: "hoboken_mqtt_messages_published_total",
    help: "Total MQTT messages published",
    registers: [register],
  });

  const mqttErrors = new Counter({
    name: "hoboken_mqtt_errors_total",
    help: "Total MQTT errors",
    registers: [register],
  });

  const devicesConfigured = new Gauge({
    name: "hoboken_devices_configured",
    help: "Number of devices configured",
    registers: [register],
  });

  const hapConnectionsActive = new Gauge({
    name: "hoboken_hap_connections_active",
    help: "Number of active HAP connections from HomeKit controllers",
    registers: [register],
  });

  const hapPairVerify = new Counter({
    name: "hoboken_hap_pair_verify_total",
    help: "Total successful HAP pair-verify handshakes",
    registers: [register],
  });

  return {
    mqttConnected,
    mqttMessagesReceived,
    mqttMessagesPublished,
    mqttErrors,
    devicesConfigured,
    hapConnectionsActive,
    hapPairVerify,
    dispose() {
      register.clear();
    },
  };
}

export interface MetricsServer {
  server: Server;
  setReady: () => void;
}

export function startMetricsServer(
  port: number,
  register: Registry,
  bind?: string,
): MetricsServer {
  let ready = false;

  const server = createServer((req, res) => {
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200);
      res.end("ok");
    } else if (req.url === "/readyz" && req.method === "GET") {
      res.writeHead(ready ? 200 : 503);
      res.end(ready ? "ok" : "not ready");
    } else if (req.url === "/metrics" && req.method === "GET") {
      void register
        .metrics()
        .then((body) => {
          res.writeHead(200, { "Content-Type": register.contentType });
          res.end(body);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          res.writeHead(500);
          res.end(message);
        });
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  // Fail fast: if the configured metrics port is unavailable, the process
  // should exit rather than silently running without observability.
  server.on("error", (err) => {
    log.error(`Metrics server error: ${err.message}`);
    process.exit(1);
  });

  const host = bind ?? "0.0.0.0";
  server.listen(port, host, () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    log.log(`Metrics server listening on ${host}:${String(boundPort)}`);
  });

  return {
    server,
    setReady: () => {
      ready = true;
    },
  };
}
