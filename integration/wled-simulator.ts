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

export type WledColor = [number, number, number, number];

export interface WledSegment {
  on: boolean;
  sel: boolean;
  col: WledColor;
}

type SimulatedSegment = WledSegment & { fx: number };

// Brightness is a 0–255 quantity (WLED-MQTT-SPEC.md §2); clamp parsed inbound
// values into range rather than letting out-of-range input corrupt the state.
function clampBri(n: number): number {
  return Math.min(255, Math.max(0, n));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function channel(value: unknown): number {
  return typeof value === "number" ? Math.trunc(value) & 0xff : 0;
}

function isByte(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 255
  );
}

function boolOrToggle(value: unknown, current: boolean): boolean {
  if (typeof value === "string" && value.startsWith("t")) return !current;
  return typeof value === "boolean" ? value : current;
}

export class WledSimulator {
  private bri = 128;
  private briLast = 128;
  private segs: SimulatedSegment[];
  private main: SimulatedSegment;
  private client: MqttClient;
  private prefix: string;

  constructor(brokerUrl: string, topic: string, segmentCount = 1) {
    this.prefix = topic;
    const newSegment = (sel: boolean): SimulatedSegment => ({
      on: true,
      sel,
      col: [255, 160, 0, 0],
      fx: 0,
    });
    this.main = newSegment(true);
    this.segs = [
      this.main,
      ...Array.from({ length: Math.max(segmentCount - 1, 0) }, () =>
        newSegment(false),
      ),
    ];
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
    const [r, g, b] = this.primary().col;
    return { bri: this.bri, briLast: this.briLast, col: [r, g, b] };
  }

  get segments(): WledSegment[] {
    return this.segs.map(({ on, sel, col }) => ({ on, sel, col: [...col] }));
  }

  get effects(): number[] {
    return this.segs.map((seg) => seg.fx);
  }

  setEffect(id: number, fx: number): void {
    const seg = this.segs[id];
    if (seg) seg.fx = fx;
  }

  setBrightness(n: number): void {
    if (n === 0 && this.bri > 0) {
      this.briLast = this.bri;
    }
    this.bri = n;
    this.publishState();
  }

  setColor(rgb: [number, number, number]): void {
    const targets = this.segs.filter((seg) => seg.sel);
    for (const seg of targets.length > 0 ? targets : [this.main]) {
      seg.col = [rgb[0], rgb[1], rgb[2], 0];
    }
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
    if (
      payload.includes("ON") ||
      payload.includes("on") ||
      payload.includes("true")
    ) {
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

    const col: WledColor = [
      (num >>> 16) & 0xff,
      (num >>> 8) & 0xff,
      num & 0xff,
      (num >>> 24) & 0xff,
    ];
    for (const seg of this.segs) {
      if (seg.sel) seg.col = [...col];
    }
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

    if (this.applySeg(data.seg)) {
      stateChanged = true;
    }

    // Only publish if state actually changed (spec section 5.7).
    // An empty {} is a no-op: stateUpdated() is called but the guard
    // (bri != briOld || stateChanged) fails, so no outbound messages.
    if (this.bri !== briOld || stateChanged) {
      this.publishState();
    }
  }

  // Mirrors deserializeState's "seg" handling: an object without a numeric
  // id applies to every selected segment, an array element without a numeric
  // id addresses its own index. Returns whether anything other than selection
  // changed (WLED's stateChanged).
  private applySeg(seg: unknown): boolean {
    const before = JSON.stringify(
      this.segs.map(({ on, col, fx }) => ({ on, col, fx })),
    );
    if (Array.isArray(seg)) {
      for (const [index, elem] of (seg as unknown[]).entries()) {
        if (!isRecord(elem)) continue;
        this.applySegElement(elem, isByte(elem.id) ? elem.id : index);
      }
    } else if (isRecord(seg)) {
      if (Number.isInteger(seg.id) && (seg.id as number) >= 0) {
        this.applySegElement(seg, seg.id as number);
      } else {
        for (let i = 0; i < this.segs.length; i++) {
          if (this.segs[i]?.sel) this.applySegElement(seg, i);
        }
      }
    }
    return (
      before !==
      JSON.stringify(this.segs.map(({ on, col, fx }) => ({ on, col, fx })))
    );
  }

  private applySegElement(elem: Record<string, unknown>, id: number): void {
    const seg = this.segs[id];
    if (!seg) return;
    seg.on = boolOrToggle(elem.on, seg.on);
    seg.sel = boolOrToggle(elem.sel, seg.sel);
    if (isByte(elem.fx)) seg.fx = elem.fx;
    if (Array.isArray(elem.col)) {
      seg.col = this.parseSegColor(elem.col[0], seg.col) ?? seg.col;
    }
  }

  // Mirrors the first color slot of deserializeSegment: an array of up to four
  // channels (missing ones are 0, so [R,G,B] zeroes white), an "RRGGBB" or
  // "RRGGBBWW" string, or an object whose omitted channels keep their value.
  // Returns undefined for a slot WLED leaves alone.
  private parseSegColor(
    entry: unknown,
    current: WledColor,
  ): WledColor | undefined {
    if (Array.isArray(entry)) {
      if (entry.length === 0) return undefined;
      const rgbw: WledColor = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) rgbw[i] = channel(entry[i]);
      return rgbw;
    }
    if (typeof entry === "string") {
      if (entry.length !== 6 && entry.length !== 8) return undefined;
      const c = Number.parseInt(entry, 16) || 0;
      return entry.length === 6
        ? [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff, 0]
        : [(c >>> 24) & 0xff, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
    }
    if (isRecord(entry)) {
      const keys = ["r", "g", "b", "w"] as const;
      const rgbw: WledColor = [...current];
      for (const [i, key] of keys.entries()) {
        const v = entry[key];
        if (isByte(v)) rgbw[i] = v;
      }
      return rgbw;
    }
    return undefined;
  }

  private primary(): WledSegment {
    return this.segs.find((seg) => seg.sel) ?? this.main;
  }

  private publishState(): void {
    this.client.publish(`${this.prefix}/g`, String(this.bri));
    const [r, g, b, w] = this.primary().col;
    const hex =
      "#" +
      (((w << 24) | (r << 16) | (g << 8) | b) >>> 0)
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
