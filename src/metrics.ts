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

import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import type { Capability, DeviceType } from "./config.ts";
import {
  clampColorTemp,
  wledBrightnessToHomeKit,
  wledToHomeKit,
  z2mBrightnessToHomeKit,
  z2mToHomeKit,
} from "./convert.ts";
import * as log from "./log.ts";

export interface Metrics {
  mqttConnected: Gauge;
  mqttMessagesReceived: Counter;
  mqttMessagesPublished: Counter;
  mqttErrors: Counter;
  devicesConfigured: Gauge;
  hapConnectionsActive: Gauge;
  hapPairVerify: Counter;
  devicesStateUnknown: Gauge;
  z2mGetRequestsTotal: Counter;
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

  const devicesStateUnknown = new Gauge({
    name: "hoboken_devices_state_unknown",
    help: "Number of configured devices with no cached state",
    registers: [register],
  });

  const z2mGetRequestsTotal = new Counter({
    name: "hoboken_z2m_get_requests_total",
    help: "Total state request messages published to Z2M device /get topics",
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
    devicesStateUnknown,
    z2mGetRequestsTotal,
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
  type: DeviceType;
  capabilities: Capability[];
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
  close: () => Promise<void>;
}

export interface MetricsServerOptions {
  heartbeatMs?: number;
}

export function startMetricsServer(
  port: number,
  register: Registry,
  bind?: string,
  getStatus?: GetStatusFn,
  options?: MetricsServerOptions,
): MetricsServer {
  let ready = false;
  const sseClients = new Set<ServerResponse>();
  const heartbeatMs = options?.heartbeatMs ?? 30000;

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

  const heartbeatInterval = setInterval(() => {
    for (const client of sseClients) {
      if (!client.destroyed) client.write(":heartbeat\n\n");
    }
  }, heartbeatMs);

  server.on("close", () => {
    clearInterval(heartbeatInterval);
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
    close: () => {
      if (!server.listening) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        for (const client of sseClients) {
          client.destroy();
        }
        server.close((err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
        server.closeAllConnections();
      });
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
  capabilities: Capability[],
): Hint | null {
  if (
    key === "brightness" &&
    typeof value === "number" &&
    capabilities.includes("brightness")
  ) {
    return {
      html: `<span class="hint">\u2192 ${String(z2mBrightnessToHomeKit(value))}%</span>`,
      placement: "value",
    };
  }
  if (
    key === "bri" &&
    typeof value === "number" &&
    capabilities.includes("brightness")
  ) {
    return {
      html: `<span class="hint">\u2192 ${String(wledBrightnessToHomeKit(value))}%</span>`,
      placement: "value",
    };
  }
  if (key === "color_temp" && typeof value === "number") {
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
  if (
    key === "col" &&
    Array.isArray(value) &&
    value.length >= 3
  ) {
    const [r, g, b] = value as number[];
    return {
      html: `<span class="swatch" style="background:rgb(${String(r)},${String(g)},${String(b)})"></span>`,
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

interface HomeKitRow {
  capability: string;
  name: string;
  value: string;
  hint?: string | undefined;
}

function computeHomeKitValues(
  state: Record<string, unknown>,
  capabilities: Capability[],
  type: DeviceType,
): HomeKitRow[] {
  let hk: ReturnType<typeof z2mToHomeKit>;
  switch (type) {
    case "z2m":
      hk = z2mToHomeKit(state);
      break;
    case "wled":
      hk = wledToHomeKit(state);
      break;
  }
  const rows: HomeKitRow[] = [];
  for (const cap of capabilities) {
    switch (cap) {
      case "on_off":
        rows.push({
          capability: "on_off",
          name: "On",
          value: hk.on === true ? "true" : "false",
        });
        break;
      case "brightness": {
        const b = hk.brightness;
        rows.push({
          capability: "brightness",
          name: "Brightness",
          value:
            typeof b === "number" ? `${String(b)}%` : "\u2014",
        });
        break;
      }
      case "color_temp": {
        const ct = hk.color_temp;
        const clamped = typeof ct === "number" ? clampColorTemp(ct) : undefined;
        rows.push({
          capability: "color_temp",
          name: "ColorTemperature",
          value:
            clamped === undefined ? "\u2014" : `${String(clamped)} mireds`,
          hint:
            clamped === undefined
              ? undefined
              : `<span class="hint">\u2192 ${String(Math.round(1_000_000 / clamped))} K</span>`,
        });
        break;
      }
      case "color_hs": {
        const h = hk.hue;
        const s = hk.saturation;
        rows.push(
          {
            capability: "color_hs",
            name: "Hue",
            value: typeof h === "number" ? `${String(h)}\u00B0` : "\u2014",
          },
          {
            capability: "color_hs",
            name: "Saturation",
            value: typeof s === "number" ? `${String(s)}%` : "\u2014",
          },
        );
        break;
      }
    }
  }
  return rows;
}

function renderHomeKitSection(
  state: Record<string, unknown> | null,
  capabilities: Capability[],
  vtPrefix: string,
  type: DeviceType,
): string {
  if (state === null) {
    return `<div class="label">HomeKit</div>\n<span class="na">No state received</span>`;
  }
  const rows = computeHomeKitValues(state, capabilities, type);
  const rowsHtml = rows
    .map((r) => {
      const vtName = `${vtPrefix}-hk-${r.name}`;
      const valClass = r.value === "\u2014" ? ' class="na"' : "";
      const hint = r.hint ?? "";
      return `<tr><td class="key">${escapeHtml(r.capability)}</td><td>${escapeHtml(r.name)}</td><td${valClass} data-vt="${vtName}">${escapeHtml(r.value)}${hint}</td></tr>`;
    })
    .join("");
  return `<div class="label">HomeKit</div>\n<table><tbody>${rowsHtml}</tbody></table>`;
}

function renderStatusContent(data: StatusData): string {
  let devicesHtml = "";
  const sortedDevices = data.devices.toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const device of sortedDevices) {
    const vtPrefix = `v-${device.topic.replaceAll(/[^a-zA-Z0-9]/g, "-")}`;

    let scenesHtml = "";
    if (device.scenes?.length) {
      const items = device.scenes
        .map((s) => `<li>${escapeHtml(s.name)} (id: ${String(s.id)})</li>`)
        .join("");
      scenesHtml = `<div class="label">Scenes</div><ul>${items}</ul>`;
    }

    const homeKitHtml = renderHomeKitSection(
      device.state,
      device.capabilities,
      vtPrefix,
      device.type,
    );

    let mqttStateHtml: string;
    if (device.state === null) {
      mqttStateHtml = '<span class="na">No state received</span>';
    } else {
      const rows = Object.entries(device.state)
        .map(([k, v]) => {
          const display = formatValue(v);
          const hint = formatHint(k, v, device.capabilities);
          const keyHint = hint?.placement === "key" ? hint.html : "";
          const valueHint = hint?.placement === "value" ? hint.html : "";
          const vtName = `${vtPrefix}-${k.replaceAll(/[^a-zA-Z0-9]/g, "-")}`;
          return `<tr><td class="key">${escapeHtml(k)}${keyHint}</td><td data-vt="${vtName}">${escapeHtml(display)}${valueHint}</td></tr>`;
        })
        .join("");
      mqttStateHtml = rows
        ? `<table><tbody>${rows}</tbody></table>`
        : '<span class="na">Empty state</span>';
    }

    devicesHtml += `
      <div class="device">
        <h2>${escapeHtml(device.name)} <span class="type-badge">${escapeHtml(device.type)}</span></h2>
        ${scenesHtml}
        ${homeKitHtml}
        <div class="label">MQTT state <span class="topic">${escapeHtml(device.topic)}</span></div>
        ${mqttStateHtml}
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
  .topic { font-weight: normal; font-family: monospace; color: #888; font-size: 0.85em; margin-left: 0.4em; }
  .type-badge { font-size: 0.55em; font-weight: normal; color: #888; background: #f0f0f0; padding: 0.05em 0.4em; border-radius: 3px; vertical-align: middle; margin-left: 0.3em; }
  .label { font-weight: bold; margin-top: 0.5rem; }
  .key { color: #999; }
  .value { font-family: monospace; }
  .na { color: #888; font-style: italic; }
  table { border-collapse: collapse; width: auto; margin-top: 0.25rem; font-family: monospace; font-size: 0.9rem; }
  td { text-align: left; padding: 0.15rem 0.5rem; border-bottom: 1px solid #eee; white-space: pre-line; }
  td:first-child { min-width: 10ch; }
  .hint { color: #888; margin-left: 0.5em; }
  .swatch { display: inline-block; width: 1em; height: 1em; border-radius: 2px; vertical-align: middle; border: 1px solid #ccc; margin-left: 0.5em; }
  .conn-list { list-style: none; margin: 0; padding: 0; font-family: monospace; font-size: 0.9rem; }
  .check { color: #2a2; font-weight: bold; font-size: 0.9rem; }
  #disconnected { background: #c22; color: #fff; text-align: center; padding: 0.5rem; border-radius: 8px; margin-bottom: 1rem; font-weight: bold; }
  #disconnected.reconnected { background: #2a2; }
  ul { margin: 0.25rem 0; padding-left: 1.5rem; }
  /* root has higher specificity (0,0,1) than * (0,0,0) per View Transitions spec */
  ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
  @keyframes flash-out { from { background: #f0f0f0; } }
  ::view-transition-old(*) { display: none; }
  ::view-transition-new(*) { animation: flash-out 1s ease-out; }
  @media (prefers-reduced-motion: reduce) {
    ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 0s; }
  }
</style>
</head>
<body>
<div id="disconnected" hidden>Connection lost. Reconnecting&hellip;</div>
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
var timers = []; // declared here, cleared in scheduleUpdates below
function scheduleUpdates() {
  for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]); // clear all pending
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
var wasDisconnected = false;
var hideTimer;
src.onerror = function() {
  if (hideTimer) clearTimeout(hideTimer);
  wasDisconnected = true;
  var el = document.getElementById("disconnected");
  el.textContent = "Connection lost. Reconnecting\u2026";
  el.className = "";
  el.removeAttribute("hidden");
};
src.onopen = function() {
  if (!wasDisconnected) return;
  if (hideTimer) clearTimeout(hideTimer);
  var el = document.getElementById("disconnected");
  el.textContent = "Reconnected";
  el.className = "reconnected";
  el.removeAttribute("hidden");
  hideTimer = setTimeout(function() { el.setAttribute("hidden", ""); }, 3000);
};
src.onmessage = function(e) {
  var content = document.getElementById("content");
  if (!document.startViewTransition) {
    content.innerHTML = e.data;
    scheduleUpdates();
    return;
  }
  var oldVals = {};
  content.querySelectorAll("[data-vt]").forEach(function(el) {
    oldVals[el.getAttribute("data-vt")] = el.textContent;
  });
  var temp = document.createElement("div");
  temp.innerHTML = e.data;
  var changed = {};
  temp.querySelectorAll("[data-vt]").forEach(function(el) {
    var name = el.getAttribute("data-vt");
    if (oldVals[name] !== el.textContent) changed[name] = true;
  });
  content.querySelectorAll("[data-vt]").forEach(function(el) {
    var name = el.getAttribute("data-vt");
    el.style.viewTransitionName = changed[name] ? name : "";
  });
  document.startViewTransition(function() {
    content.innerHTML = e.data;
    content.querySelectorAll("[data-vt]").forEach(function(el) {
      var name = el.getAttribute("data-vt");
      el.style.viewTransitionName = changed[name] ? name : "";
    });
    scheduleUpdates();
  });
};
</script>
</body>
</html>`;
}
