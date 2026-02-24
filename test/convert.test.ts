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
import {
  clampColorTemp,
  homeKitToWled,
  homeKitToZ2m,
  homeKitBrightnessToZ2M,
  homeKitBrightnessToWled,
  hsToRgb,
  parseWledHexColor,
  parseWledMessage,
  rgbToHs,
  wledBrightnessToHomeKit,
  wledToHomeKit,
  z2mBrightnessToHomeKit,
  z2mToHomeKit,
} from "../src/convert.ts";

describe("z2mBrightnessToHomeKit", () => {
  test("converts 0 to 0", () => {
    expect(z2mBrightnessToHomeKit(0)).toBe(0);
  });

  test("converts 254 to 100", () => {
    expect(z2mBrightnessToHomeKit(254)).toBe(100);
  });

  test("converts 127 to 50", () => {
    expect(z2mBrightnessToHomeKit(127)).toBe(50);
  });

  test("clamps negative values to 0", () => {
    expect(z2mBrightnessToHomeKit(-10)).toBe(0);
  });

  test("clamps values above 254 to 100", () => {
    expect(z2mBrightnessToHomeKit(300)).toBe(100);
  });

  test("throws on Number.NaN", () => {
    expect(() => z2mBrightnessToHomeKit(Number.NaN)).toThrow(
      "brightness must be a number",
    );
  });
});

describe("homeKitBrightnessToZ2M", () => {
  test("converts 0 to 0", () => {
    expect(homeKitBrightnessToZ2M(0)).toBe(0);
  });

  test("converts 100 to 254", () => {
    expect(homeKitBrightnessToZ2M(100)).toBe(254);
  });

  test("converts 50 to 126", () => {
    expect(homeKitBrightnessToZ2M(50)).toBe(126);
  });

  test("clamps negative values to 0", () => {
    expect(homeKitBrightnessToZ2M(-10)).toBe(0);
  });

  test("clamps values above 100 to 254", () => {
    expect(homeKitBrightnessToZ2M(200)).toBe(254);
  });

  test("throws on Number.NaN", () => {
    expect(() => homeKitBrightnessToZ2M(Number.NaN)).toThrow(
      "brightness must be a number",
    );
  });
});

describe("clampColorTemp", () => {
  test("passes through values in range", () => {
    expect(clampColorTemp(140)).toBe(140);
    expect(clampColorTemp(300)).toBe(300);
    expect(clampColorTemp(500)).toBe(500);
  });

  test("clamps values below 140", () => {
    expect(clampColorTemp(0)).toBe(140);
    expect(clampColorTemp(100)).toBe(140);
    expect(clampColorTemp(139)).toBe(140);
  });

  test("clamps values above 500", () => {
    expect(clampColorTemp(501)).toBe(500);
    expect(clampColorTemp(1000)).toBe(500);
  });
});

describe("round-trip fidelity", () => {
  test("round-trips common values", () => {
    for (const z2m of [0, 1, 50, 127, 200, 253, 254]) {
      const hk = z2mBrightnessToHomeKit(z2m);
      const back = homeKitBrightnessToZ2M(hk);
      expect(Math.abs(back - z2m)).toBeLessThanOrEqual(1);
    }
  });
});

describe("wledBrightnessToHomeKit", () => {
  test("converts 0 to 0", () => {
    expect(wledBrightnessToHomeKit(0)).toBe(0);
  });

  test("converts 255 to 100", () => {
    expect(wledBrightnessToHomeKit(255)).toBe(100);
  });

  test("converts 128 to 50", () => {
    expect(wledBrightnessToHomeKit(128)).toBe(50);
  });

  test("clamps negative values to 0", () => {
    expect(wledBrightnessToHomeKit(-10)).toBe(0);
  });

  test("clamps values above 255 to 100", () => {
    expect(wledBrightnessToHomeKit(300)).toBe(100);
  });

  test("throws on Number.NaN", () => {
    expect(() => wledBrightnessToHomeKit(Number.NaN)).toThrow(
      "brightness must be a number",
    );
  });
});

describe("homeKitBrightnessToWled", () => {
  test("converts 0 to 0", () => {
    expect(homeKitBrightnessToWled(0)).toBe(0);
  });

  test("converts 100 to 255", () => {
    expect(homeKitBrightnessToWled(100)).toBe(255);
  });

  test("converts 50 to 128", () => {
    expect(homeKitBrightnessToWled(50)).toBe(128);
  });

  test("clamps negative values to 0", () => {
    expect(homeKitBrightnessToWled(-10)).toBe(0);
  });

  test("clamps values above 100 to 255", () => {
    expect(homeKitBrightnessToWled(200)).toBe(255);
  });

  test("throws on Number.NaN", () => {
    expect(() => homeKitBrightnessToWled(Number.NaN)).toThrow(
      "brightness must be a number",
    );
  });
});

describe("WLED brightness round-trip fidelity", () => {
  test("round-trips common values", () => {
    for (const wled of [0, 1, 64, 128, 200, 254, 255]) {
      const hk = wledBrightnessToHomeKit(wled);
      const back = homeKitBrightnessToWled(hk);
      expect(Math.abs(back - wled)).toBeLessThanOrEqual(1);
    }
  });
});

describe("hsToRgb", () => {
  test("converts red (0, 100)", () => {
    expect(hsToRgb(0, 100)).toEqual([255, 0, 0]);
  });

  test("converts green (120, 100)", () => {
    expect(hsToRgb(120, 100)).toEqual([0, 255, 0]);
  });

  test("converts blue (240, 100)", () => {
    expect(hsToRgb(240, 100)).toEqual([0, 0, 255]);
  });

  test("converts white (0, 0)", () => {
    expect(hsToRgb(0, 0)).toEqual([255, 255, 255]);
  });

  test("converts yellow (60, 100)", () => {
    expect(hsToRgb(60, 100)).toEqual([255, 255, 0]);
  });

  test("converts cyan (180, 100)", () => {
    expect(hsToRgb(180, 100)).toEqual([0, 255, 255]);
  });

  test("converts magenta (300, 100)", () => {
    expect(hsToRgb(300, 100)).toEqual([255, 0, 255]);
  });
});

describe("rgbToHs", () => {
  test("converts red", () => {
    expect(rgbToHs(255, 0, 0)).toEqual({ hue: 0, saturation: 100 });
  });

  test("converts green", () => {
    expect(rgbToHs(0, 255, 0)).toEqual({ hue: 120, saturation: 100 });
  });

  test("converts blue", () => {
    expect(rgbToHs(0, 0, 255)).toEqual({ hue: 240, saturation: 100 });
  });

  test("converts white", () => {
    expect(rgbToHs(255, 255, 255)).toEqual({ hue: 0, saturation: 0 });
  });

  test("converts black", () => {
    expect(rgbToHs(0, 0, 0)).toEqual({ hue: 0, saturation: 0 });
  });

  test("converts yellow", () => {
    expect(rgbToHs(255, 255, 0)).toEqual({ hue: 60, saturation: 100 });
  });
});

describe("HSV round-trip fidelity", () => {
  test("round-trips primary and secondary colors", () => {
    const colors: [number, number][] = [
      [0, 100],
      [60, 100],
      [120, 100],
      [180, 100],
      [240, 100],
      [300, 100],
    ];
    for (const [h, s] of colors) {
      const [r, g, b] = hsToRgb(h, s);
      const result = rgbToHs(r, g, b);
      expect(result.hue).toBe(h);
      expect(result.saturation).toBe(s);
    }
  });
});

describe("parseWledHexColor", () => {
  test("parses #RRGGBB format", () => {
    expect(parseWledHexColor("#FF0000")).toEqual([255, 0, 0]);
  });

  test("parses without hash prefix", () => {
    expect(parseWledHexColor("00FF00")).toEqual([0, 255, 0]);
  });

  test("parses #RRGGBBWW format (ignores white channel)", () => {
    expect(parseWledHexColor("#FF8000CC")).toEqual([255, 128, 0]);
  });

  test("parses lowercase hex", () => {
    expect(parseWledHexColor("#ff8040")).toEqual([255, 128, 64]);
  });

  test("returns undefined on too-short string", () => {
    expect(parseWledHexColor("#FFF")).toBeUndefined();
  });

  test("returns undefined on empty string", () => {
    expect(parseWledHexColor("")).toBeUndefined();
  });

  test("returns undefined on non-hex characters", () => {
    expect(parseWledHexColor("xyzxyz")).toBeUndefined();
  });
});

describe("parseWledMessage", () => {
  test("parses /g brightness", () => {
    expect(parseWledMessage("g", "128")).toEqual({ on: true, bri: 128 });
  });

  test("parses /g brightness 0 as off", () => {
    expect(parseWledMessage("g", "0")).toEqual({ on: false, bri: 0 });
  });

  test("returns undefined for invalid /g value", () => {
    expect(parseWledMessage("g", "not-a-number")).toBeUndefined();
  });

  test("parses /c hex color", () => {
    expect(parseWledMessage("c", "#FF0000")).toEqual({ col: [255, 0, 0] });
  });

  test("returns undefined for invalid /c hex", () => {
    expect(parseWledMessage("c", "xyz")).toBeUndefined();
  });

  test("returns undefined for unknown sub-topic", () => {
    expect(parseWledMessage("v", "42")).toBeUndefined();
  });
});

describe("z2mToHomeKit", () => {
  test("converts state ON to on: true", () => {
    expect(z2mToHomeKit({ state: "ON" })).toEqual({ on: true });
  });

  test("converts state OFF to on: false", () => {
    expect(z2mToHomeKit({ state: "OFF" })).toEqual({ on: false });
  });

  test("converts brightness to HomeKit range", () => {
    expect(z2mToHomeKit({ brightness: 254 })).toEqual({ brightness: 100 });
    expect(z2mToHomeKit({ brightness: 127 })).toEqual({ brightness: 50 });
    expect(z2mToHomeKit({ brightness: 0 })).toEqual({ brightness: 0 });
  });

  test("passes color_temp through", () => {
    expect(z2mToHomeKit({ color_temp: 370 })).toEqual({ color_temp: 370 });
  });

  test("extracts hue and saturation from color object", () => {
    expect(z2mToHomeKit({ color: { hue: 240, saturation: 80 } })).toEqual({
      hue: 240,
      saturation: 80,
    });
  });

  test("ignores color object without hue/saturation", () => {
    expect(z2mToHomeKit({ color: { x: 0.3, y: 0.5 } })).toEqual({});
  });

  test("ignores null color", () => {
    expect(z2mToHomeKit({ color: null })).toEqual({});
  });

  test("converts all fields together", () => {
    const result = z2mToHomeKit({
      state: "ON",
      brightness: 200,
      color_temp: 370,
      color: { hue: 240, saturation: 80 },
    });
    expect(result).toEqual({
      on: true,
      brightness: 79,
      color_temp: 370,
      hue: 240,
      saturation: 80,
    });
  });

  test("returns empty object for empty input", () => {
    expect(z2mToHomeKit({})).toEqual({});
  });
});

describe("wledToHomeKit", () => {
  test("converts on: true", () => {
    expect(wledToHomeKit({ on: true })).toEqual({ on: true });
  });

  test("converts on: false", () => {
    expect(wledToHomeKit({ on: false })).toEqual({ on: false });
  });

  test("converts bri to HomeKit brightness", () => {
    expect(wledToHomeKit({ bri: 255 })).toEqual({ brightness: 100 });
    expect(wledToHomeKit({ bri: 128 })).toEqual({ brightness: 50 });
    expect(wledToHomeKit({ bri: 0 })).toEqual({ brightness: 0 });
  });

  test("converts col RGB array to hue and saturation", () => {
    expect(wledToHomeKit({ col: [255, 0, 0] })).toEqual({
      hue: 0,
      saturation: 100,
    });
    expect(wledToHomeKit({ col: [0, 255, 0] })).toEqual({
      hue: 120,
      saturation: 100,
    });
  });

  test("ignores col with fewer than 3 elements", () => {
    expect(wledToHomeKit({ col: [255, 0] })).toEqual({});
  });

  test("ignores non-array col", () => {
    expect(wledToHomeKit({ col: "FF0000" })).toEqual({});
  });

  test("converts all fields together", () => {
    const result = wledToHomeKit({ on: true, bri: 128, col: [255, 0, 0] });
    expect(result).toEqual({
      on: true,
      brightness: 50,
      hue: 0,
      saturation: 100,
    });
  });

  test("returns empty object for empty input", () => {
    expect(wledToHomeKit({})).toEqual({});
  });
});

describe("homeKitToZ2m", () => {
  test("converts on: true to state ON", () => {
    expect(homeKitToZ2m({ on: true })).toEqual({ state: "ON" });
  });

  test("converts on: false to state OFF", () => {
    expect(homeKitToZ2m({ on: false })).toEqual({ state: "OFF" });
  });

  test("converts brightness to Z2M range", () => {
    expect(homeKitToZ2m({ brightness: 100 })).toEqual({ brightness: 254 });
    expect(homeKitToZ2m({ brightness: 50 })).toEqual({ brightness: 126 });
    expect(homeKitToZ2m({ brightness: 0 })).toEqual({ brightness: 0 });
  });

  test("passes through color_temp", () => {
    expect(homeKitToZ2m({ color_temp: 370 })).toEqual({ color_temp: 370 });
  });

  test("wraps hue in color object", () => {
    expect(homeKitToZ2m({ hue: 240 })).toEqual({ color: { hue: 240 } });
  });

  test("wraps saturation in color object", () => {
    expect(homeKitToZ2m({ saturation: 80 })).toEqual({ color: { saturation: 80 } });
  });

  test("wraps hue and saturation together", () => {
    expect(homeKitToZ2m({ hue: 240, saturation: 80 })).toEqual({
      color: { hue: 240, saturation: 80 },
    });
  });

  test("H=0/S=0 with cached color_temp sends color_temp", () => {
    expect(homeKitToZ2m({ hue: 0, saturation: 0 }, { color_temp: 300 })).toEqual({
      color_temp: 300,
    });
  });

  test("H=0/S=0 without cached color_temp sends color object", () => {
    expect(homeKitToZ2m({ hue: 0, saturation: 0 })).toEqual({
      color: { hue: 0, saturation: 0 },
    });
  });

  test("converts all fields together", () => {
    expect(homeKitToZ2m({ on: true, brightness: 80, hue: 120, saturation: 100 }))
      .toEqual({
        state: "ON",
        brightness: 203,
        color: { hue: 120, saturation: 100 },
      });
  });

  test("returns empty object for empty input", () => {
    expect(homeKitToZ2m({})).toEqual({});
  });
});

describe("homeKitToWled", () => {
  test("converts on to api.on", () => {
    expect(homeKitToWled({ on: true })).toEqual({ on: true });
    expect(homeKitToWled({ on: false })).toEqual({ on: false });
  });

  test("converts brightness to bri", () => {
    expect(homeKitToWled({ brightness: 100 })).toEqual({ bri: 255 });
    expect(homeKitToWled({ brightness: 50 })).toEqual({ bri: 128 });
    expect(homeKitToWled({ brightness: 0 })).toEqual({ bri: 0 });
  });

  test("converts hue/saturation to seg col RGB", () => {
    expect(homeKitToWled({ hue: 0, saturation: 100 })).toEqual({
      seg: [{ col: [[255, 0, 0]] }],
    });
  });

  test("H=0/S=0 sends full white RGB", () => {
    expect(homeKitToWled({ hue: 0, saturation: 0 })).toEqual({
      seg: [{ col: [[255, 255, 255]] }],
    });
  });

  test("fills missing hue from cached state", () => {
    const cached = { on: true, bri: 128, col: [255, 0, 0] };
    expect(homeKitToWled({ saturation: 100 }, cached)).toEqual({
      seg: [{ col: [[255, 0, 0]] }],
    });
  });

  test("fills missing saturation from cached state", () => {
    const cached = { on: true, bri: 128, col: [0, 255, 0] };
    expect(homeKitToWled({ hue: 120 }, cached)).toEqual({
      seg: [{ col: [[0, 255, 0]] }],
    });
  });

  test("converts all fields together", () => {
    expect(homeKitToWled({ on: true, brightness: 100, hue: 0, saturation: 100 }))
      .toEqual({
        on: true,
        bri: 255,
        seg: [{ col: [[255, 0, 0]] }],
      });
  });

  test("returns empty object for empty input", () => {
    expect(homeKitToWled({})).toEqual({});
  });
});
