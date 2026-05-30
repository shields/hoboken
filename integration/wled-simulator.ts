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

import { connect, type MqttClient } from "mqtt";

export interface WledState {
  bri: number;
  briLast: number;
  col: [number, number, number];
}

// Brightness is a 0–255 quantity (WLED-MQTT-SPEC.md §2); clamp parsed inbound
// values into range rather than letting out-of-range input corrupt the state.
function clampBri(n: number): number {
  return Math.min(255, Math.max(0, n));
}

export class WledSimulator {
  private bri = 128;
  private briLast = 128;
  private col: [number, number, number] = [255, 160, 0];
  private client: MqttClient;
  private prefix: string;

  constructor(brokerUrl: string, topic: string) {
    this.prefix = topic;
    this.client = connect(brokerUrl, {
      will: {
        topic: `${topic}/status`,
        payload: Buffer.from("offline"),
        qos: 0,
        retain: true,
      },
    });

    this.client.on("connect", () => {
      this.client.subscribe([topic, `${topic}/col`, `${topic}/api`]);
      this.publishState();
    });

    this.client.on("message", (msgTopic: string, payload: Buffer) => {
      const suffix = msgTopic.slice(this.prefix.length);
      switch (suffix) {
        case "":
          this.handleBriPayload(payload.toString());
          break;
        case "/col":
          this.handleColPayload(payload.toString());
          break;
        case "/api":
          this.handleApiPayload(payload.toString());
          break;
      }
    });
  }

  get state(): WledState {
    return { bri: this.bri, briLast: this.briLast, col: [...this.col] };
  }

  setBrightness(n: number): void {
    if (n === 0 && this.bri > 0) {
      this.briLast = this.bri;
    }
    this.bri = n;
    this.publishState();
  }

  setColor(rgb: [number, number, number]): void {
    this.col = [...rgb];
    this.publishState();
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.client.end(false, () => {
        resolve();
      });
    });
  }

  private toggle(): void {
    if (this.bri === 0) {
      this.bri = this.briLast;
    } else {
      this.briLast = this.bri;
      this.bri = 0;
    }
  }

  private handleBriPayload(payload: string): void {
    if (payload.includes("ON") || payload.includes("on") || payload.includes("true")) {
      this.bri = this.briLast;
    } else if (payload.includes("T") || payload.includes("t")) {
      this.toggle();
    } else {
      const val = Number.parseInt(payload, 10);
      if (!Number.isNaN(val)) {
        const bri = clampBri(val);
        if (bri === 0 && this.bri > 0) {
          this.briLast = this.bri;
        }
        this.bri = bri;
      }
    }
    this.publishState();
  }

  private handleColPayload(payload: string): void {
    const first = payload[0];
    const num =
      first === "#" || first === "h" || first === "H"
        ? Number.parseInt(payload.slice(1), 16)
        : Number.parseInt(payload, 10);
    if (Number.isNaN(num)) return;

    // Decompose uint32 into WRGB: bits 23-16=R, 15-8=G, 7-0=B
    const r = (num >>> 16) & 0xFF;
    const g = (num >>> 8) & 0xFF;
    const b = num & 0xFF;
    this.col = [r, g, b];
    this.publishState();
  }

  private handleApiPayload(payload: string): void {
    if (!payload.startsWith("{")) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }

    const briOld = this.bri;
    let stateChanged = false;

    // Snapshot on-state before bri changes for toggle guard
    const onBefore = this.bri > 0;

    // Process bri first
    if (typeof data.bri === "number") {
      const bri = clampBri(data.bri);
      if (bri === 0 && this.bri > 0) {
        this.briLast = this.bri;
      }
      this.bri = bri;
    }

    // Process on second
    if ("on" in data) {
      switch (data.on) {
        case true:
          if (this.bri === 0) {
            this.bri = this.briLast;
          }
          break;
        case false:
          if (this.bri > 0) {
            this.briLast = this.bri;
            this.bri = 0;
          }
          break;
        case "t":
          // Toggle guard: if bri field already turned us on, don't toggle off
          if (onBefore || this.bri === 0) {
            this.toggle();
          }
          break;
      }
    }

    // Process seg[0].col (primary color slot)
    if (Array.isArray(data.seg)) {
      const seg0 = data.seg[0] as Record<string, unknown> | undefined;
      if (seg0 && Array.isArray(seg0.col)) {
        const colSlot0 = (seg0.col as unknown[])[0];
        if (this.parseSegColor(colSlot0)) {
          stateChanged = true;
        }
      }
    }

    // Only publish if state actually changed (spec section 5.7).
    // An empty {} is a no-op: stateUpdated() is called but the guard
    // (bri != briOld || stateChanged) fails, so no outbound messages.
    if (this.bri !== briOld || stateChanged) {
      this.publishState();
    }
  }

  // Parse one seg[].col slot. Per WLED-MQTT-SPEC.md §3c a slot may be an
  // [R,G,B] (or [R,G,B,W]) array, an "RRGGBB"/"RRGGBBWW" hex string, or an
  // {r,g,b} object (each channel optional, defaulting to its current value).
  // Returns whether a recognized color was applied.
  private parseSegColor(entry: unknown): boolean {
    if (Array.isArray(entry)) {
      if (entry.length < 3) return false;
      const [r, g, b] = entry as unknown[];
      if (
        typeof r !== "number" ||
        typeof g !== "number" ||
        typeof b !== "number"
      ) {
        return false;
      }
      this.col = [r, g, b];
      return true;
    }
    if (typeof entry === "string") {
      // colorFromHexString uses standard RRGGBB[WW] byte order: take the first
      // three bytes as R, G, B and ignore any trailing white byte.
      if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(entry)) return false;
      this.col = [
        Number.parseInt(entry.slice(0, 2), 16),
        Number.parseInt(entry.slice(2, 4), 16),
        Number.parseInt(entry.slice(4, 6), 16),
      ];
      return true;
    }
    if (typeof entry === "object" && entry !== null) {
      const o = entry as Record<string, unknown>;
      this.col = [
        typeof o.r === "number" ? o.r : this.col[0],
        typeof o.g === "number" ? o.g : this.col[1],
        typeof o.b === "number" ? o.b : this.col[2],
      ];
      return true;
    }
    return false;
  }

  private publishState(): void {
    this.client.publish(`${this.prefix}/g`, String(this.bri));
    const hex =
      "#" +
      ((this.col[0] << 16) | (this.col[1] << 8) | this.col[2])
        .toString(16)
        .toUpperCase()
        .padStart(6, "0");
    this.client.publish(`${this.prefix}/c`, hex);
    this.client.publish(`${this.prefix}/status`, "online", { retain: true });

    if (this.bri > 0) {
      this.briLast = this.bri;
    }
  }
}
