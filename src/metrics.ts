import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
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

export interface HapConnection {
  remoteAddress: string;
  authenticated: boolean;
}

export interface DeviceStatus {
  name: string;
  topic: string;
  capabilities: string[];
  scenes?: { name: string; id: number }[];
  state: Record<string, unknown> | null;
}

export interface StatusData {
  mqtt: { url: string; connected: boolean };
  hap: { connections: HapConnection[] };
  bridge: { name: string; version: string };
  devices: DeviceStatus[];
}

export type GetStatusFn = () => StatusData;

export interface MetricsServer {
  server: Server;
  setReady: () => void;
  notifyStateChange: () => void;
}

export function startMetricsServer(
  port: number,
  register: Registry,
  bind?: string,
  getStatus?: GetStatusFn,
): MetricsServer {
  let ready = false;
  const sseClients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    if (req.url === "/events" && req.method === "GET" && getStatus) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      // No explicit error handler needed: Node's HTTP server catches response
      // stream errors internally. The req "close" event reliably fires on
      // disconnect and removes the client from sseClients.
      sendSseEvent(res, renderStatusContent(getStatus()));
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
    } else if (req.url === "/" && req.method === "GET" && getStatus) {
      const html = renderStatusPage(getStatus());
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else if (req.url === "/healthz" && req.method === "GET") {
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
    // eslint-disable-next-line unicorn/no-process-exit -- fail-fast in async event handler
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
    notifyStateChange: () => {
      if (!getStatus) return;
      const content = renderStatusContent(getStatus());
      for (const client of sseClients) {
        sendSseEvent(client, content);
      }
    },
  };
}

// No res.writable guard needed: res.write() never throws — it returns false
// on a broken connection. The req "close" handler removes clients from
// sseClients, so stale entries are short-lived (one event loop tick at most).
function sendSseEvent(res: ServerResponse, content: string): void {
  const lines = content.split("\n").map((line) => `data: ${line}`);
  res.write(`${lines.join("\n")}\n\n`);
}

function escapeHtml(str: string): string {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type HintPlacement = "key" | "value";

interface Hint {
  html: string;
  placement: HintPlacement;
}

function formatHint(
  key: string,
  value: unknown,
  capabilities: string[],
): Hint | null {
  if (
    key === "brightness" &&
    typeof value === "number" &&
    capabilities.includes("brightness")
  ) {
    return {
      html: `<span class="hint">\u2192 ${String(Math.round((value / 254) * 100))}%</span>`,
      placement: "value",
    };
  }
  if (
    key === "color_temp" &&
    typeof value === "number" &&
    capabilities.includes("color_temp")
  ) {
    return {
      html: `<span class="hint">\u2192 ${String(Math.round(1_000_000 / value))} K</span>`,
      placement: "value",
    };
  }
  if (
    key === "color" &&
    typeof value === "object" &&
    value !== null &&
    "hue" in value &&
    "saturation" in value &&
    capabilities.includes("color_hs")
  ) {
    const h = (value as Record<string, unknown>).hue;
    const s = (value as Record<string, unknown>).saturation;
    if (typeof h !== "number" || typeof s !== "number") return null;
    return {
      html: `<span class="swatch" style="background:hsl(${String(h)},${String(s)}%,50%)"></span>`,
      placement: "key",
    };
  }
  if (key === "last_seen" && typeof value === "string") {
    const ms = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    return {
      html: `<span class="hint" data-ts="${escapeHtml(value)}">\u2192 ${formatDuration(ms)} ago</span>`,
      placement: "value",
    };
  }
  return null;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${String(hours)}h ${String(remainingMinutes)}m`
      : `${String(hours)}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0
    ? `${String(days)}d ${String(remainingHours)}h`
    : `${String(days)}d`;
}

export function msUntilChange(elapsedMs: number): number {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return 1000 - (elapsedMs % 1000);
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return 60000 - (elapsedMs % 60000);
  return 3_600_000 - (elapsedMs % 3_600_000);
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return JSON.stringify(v);
  }
  return Object.entries(v as Record<string, unknown>)
    .map(([k, val]) => `${k}: ${JSON.stringify(val)}`)
    .join("\n");
}

function renderConnectionsList(connections: HapConnection[]): string {
  if (connections.length === 0) {
    return '<span class="na">none</span>';
  }
  const items = connections
    .map((c) => {
      const auth = c.authenticated
        ? '<span class="check">\u2713</span>'
        : '<span class="na">pairing</span>';
      return `<li>${escapeHtml(c.remoteAddress)} ${auth}</li>`;
    })
    .join("");
  return `<ul class="conn-list">${items}</ul>`;
}

function renderStatusContent(data: StatusData): string {
  let devicesHtml = "";
  const sortedDevices = data.devices.toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const device of sortedDevices) {
    const caps = device.capabilities.map((c) => escapeHtml(c)).join(", ");

    let scenesHtml = "";
    if (device.scenes?.length) {
      const items = device.scenes
        .map((s) => `<li>${escapeHtml(s.name)} (id: ${String(s.id)})</li>`)
        .join("");
      scenesHtml = `<div class="label">Scenes</div><ul>${items}</ul>`;
    }

    let stateHtml: string;
    if (device.state === null) {
      stateHtml = '<span class="na">No state received</span>';
    } else {
      const rows = Object.entries(device.state)
        .map(([k, v]) => {
          const display = formatValue(v);
          const hint = formatHint(k, v, device.capabilities);
          const keyHint = hint?.placement === "key" ? hint.html : "";
          const valueHint = hint?.placement === "value" ? hint.html : "";
          return `<tr><td>${escapeHtml(k)}${keyHint}</td><td>${escapeHtml(display)}${valueHint}</td></tr>`;
        })
        .join("");
      stateHtml = rows
        ? `<table><tbody>${rows}</tbody></table>`
        : '<span class="na">Empty state</span>';
    }

    devicesHtml += `
      <div class="device">
        <h2>${escapeHtml(device.name)} <span class="topic">${escapeHtml(device.topic)}</span></h2>
        <div class="subtitle">${caps}</div>
        ${scenesHtml}
        <div class="label">State</div>
        ${stateHtml}
      </div>`;
  }

  return `<h1>${escapeHtml(data.bridge.name)}</h1>
<div class="version">Version ${escapeHtml(data.bridge.version)}</div>
<div class="status">
  <div class="status-section">
    <div class="status-label">MQTT</div>
    <div class="conn-list">${escapeHtml(data.mqtt.url)} ${data.mqtt.connected ? '<span class="check">\u2713</span>' : '<span class="err">disconnected</span>'}</div>
  </div>
  <div class="status-section">
    <div class="status-label">HAP</div>
    ${renderConnectionsList(data.hap.connections)}
  </div>
</div>
${devicesHtml}`;
}

function renderStatusPage(data: StatusData): string {
  const content = renderStatusContent(data);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.bridge.name)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 1rem; background: #f5f5f5; color: #333; }
  h1 { margin-bottom: 0.25rem; }
  .version { color: #888; font-size: 0.9rem; margin-bottom: 1rem; }
  .status { display: flex; gap: 2rem; align-items: start; margin-bottom: 1.5rem; padding: 1rem; background: #fff; border-radius: 8px; }
  .status-section { }
  .status-label { font-weight: bold; margin-bottom: 0.25rem; }
  .status .ok { color: #2a2; font-weight: bold; }
  .status .err { color: #c22; font-weight: bold; }
  .device { background: #fff; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .device h2 { margin-top: 0; margin-bottom: 0.15rem; }
  .topic { font-weight: normal; font-family: monospace; color: #888; font-size: 0.75em; margin-left: 0.4em; }
  .subtitle { font-family: monospace; font-size: 0.9rem; color: #666; margin-bottom: 0.5rem; }
  .label { font-weight: bold; margin-top: 0.5rem; }
  .value { font-family: monospace; }
  .na { color: #888; font-style: italic; }
  table { border-collapse: collapse; width: auto; margin-top: 0.25rem; font-family: monospace; font-size: 0.9rem; }
  td { text-align: left; padding: 0.15rem 0.5rem; border-bottom: 1px solid #eee; white-space: pre-line; }
  td:first-child { min-width: 10ch; }
  .hint { color: #888; margin-left: 0.5em; }
  .swatch { display: inline-block; width: 1em; height: 1em; border-radius: 2px; vertical-align: middle; border: 1px solid #ccc; margin-left: 0.5em; }
  .conn-list { list-style: none; margin: 0; padding: 0; font-family: monospace; font-size: 0.9rem; }
  .check { color: #2a2; font-weight: bold; font-size: 0.9rem; }
  ul { margin: 0.25rem 0; padding-left: 1.5rem; }
</style>
</head>
<body>
<div id="content">${content}</div>
<script>
function formatDuration(ms) {
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm > 0 ? h + "h " + rm + "m" : h + "h";
  var d = Math.floor(h / 24), rh = h % 24;
  return rh > 0 ? d + "d " + rh + "h" : d + "d";
}
function msUntilChange(ms) {
  var s = Math.floor(ms / 1000);
  if (s < 60) return 1000 - (ms % 1000);
  if (Math.floor(s / 3600) < 24) return 60000 - (ms % 60000);
  return 3600000 - (ms % 3600000);
}
var timers = [];
function scheduleUpdates() {
  for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
  timers = [];
  var els = document.querySelectorAll("[data-ts]");
  for (var j = 0; j < els.length; j++) {
    (function(el) {
      var ts = new Date(el.getAttribute("data-ts")).getTime();
      var update = function() {
        var elapsed = Date.now() - ts;
        if (elapsed < 0 || !isFinite(elapsed)) return;
        el.textContent = "\u2192 " + formatDuration(elapsed) + " ago";
        timers.push(setTimeout(update, msUntilChange(elapsed)));
      };
      var elapsed = Date.now() - ts;
      if (elapsed >= 0 && isFinite(elapsed))
        timers.push(setTimeout(update, msUntilChange(elapsed)));
    })(els[j]);
  }
}
scheduleUpdates();
var src = new EventSource("/events");
src.onmessage = function(e) {
  document.getElementById("content").innerHTML = e.data;
  scheduleUpdates();
};
</script>
</body>
</html>`;
}
