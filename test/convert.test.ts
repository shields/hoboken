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
  colorTempRange,
  wledUnrememberedWhite,
  homeKitToWled,
  homeKitToZ2m,
  COOL_WHITE_COLOR_TEMP,
  colorTempToHueSaturation,
  DEFAULT_WHITE_COLOR_TEMP,
  hueSaturationToColorTemp,
  z2mWriteToHomeKit,
  isSiriWhite,
  isWhite,
  homeKitBrightnessToZ2M,
  homeKitBrightnessToWled,
  homeKitSpeedToZ2mFanMode,
  hsToRgb,
  parseWledHexColor,
  parseWledMessage,
  rgbToHs,
  wledBrightnessToHomeKit,
  wledRgb,
  wledWrite,
  wledToHomeKit,
  z2mBrightnessToHomeKit,
  z2mFanModeToHomeKit,
  z2mToHomeKit,
} from "../src/convert.ts";

describe("isWhite", () => {
  test("H=0/S=0 is white", () => {
    expect(isWhite(0, 0)).toBe(true);
  });

  test("H=228/S=56 is white", () => {
    expect(isWhite(228, 56)).toBe(true);
  });

  test("zero saturation is white at any hue", () => {
    expect(isWhite(228, 0)).toBe(true);
    expect(isWhite(359, 0)).toBe(true);
  });

  test("zero saturation is white without a hue", () => {
    expect(isWhite(undefined, 0)).toBe(true);
  });

  test("other values are not white", () => {
    expect(isWhite(240, 80)).toBe(false);
    expect(isWhite(0, 56)).toBe(false);
    expect(isWhite(228, 55)).toBe(false);
    expect(isWhite(0, 1)).toBe(false);
  });

  test("a hue without a saturation is not white", () => {
    expect(isWhite(0, undefined)).toBe(false);
    expect(isWhite(228, undefined)).toBe(false);
  });
});

describe("isSiriWhite", () => {
  test("Hue 0 with Saturation 0 is Siri's white", () => {
    expect(isSiriWhite({ hue: 0, saturation: 0 })).toBe(true);
    expect(
      isSiriWhite({ on: true, brightness: 78, hue: 0, saturation: 0 }),
    ).toBe(true);
  });

  test("other whites are not Siri's", () => {
    expect(isSiriWhite({ saturation: 0 })).toBe(false);
    expect(isSiriWhite({ hue: 0 })).toBe(false);
    expect(isSiriWhite({ hue: 30, saturation: 0 })).toBe(false);
    expect(isSiriWhite({ hue: 0, saturation: 1 })).toBe(false);
    expect(isSiriWhite({ hue: 228, saturation: 56 })).toBe(false);
  });

  test("a write with a temperature as well is not Siri's white", () => {
    expect(isSiriWhite({ hue: 0, saturation: 0, color_temp: 250 })).toBe(false);
  });
});

describe("colorTempToHueSaturation", () => {
  test.each([
    [100, 221.786, 20.21],
    [150, 290.99, 2.544],
    [160, 0.218, 3.632],
    [250, 29.433, 35.651],
    [370, 29.918, 66.52],
    [500, 29.479, 90.55],
  ])("%d mireds is the Home app's color", (mireds, hue, saturation) => {
    const color = colorTempToHueSaturation(mireds);
    expect(color.hue).toBeCloseTo(hue, 2);
    expect(color.saturation).toBeCloseTo(saturation, 2);
  });
});

describe("hueSaturationToColorTemp", () => {
  test.each([
    [222, 20, 101],
    [251, 5, 142],
    [28, 23, 211],
    [30, 48, 293],
    [30, 67, 372],
  ])(
    "the Home app's swatch H=%d S=%d is %d mireds",
    (hue, saturation, mireds) => {
      expect(Math.round(hueSaturationToColorTemp(hue, saturation)!)).toBe(
        mireds,
      );
    },
  );

  test("recovers every whole temperature from its rounded color", () => {
    for (let mireds = 140; mireds <= 500; mireds++) {
      const color = colorTempToHueSaturation(mireds);
      const recovered = hueSaturationToColorTemp(
        Math.round(color.hue),
        Math.round(color.saturation),
      );
      expect(recovered).toBeDefined();
      expect(Math.abs(recovered! - mireds)).toBeLessThan(3.5);
    }
  });

  test("recovers a temperature exactly from its unrounded color", () => {
    const color = colorTempToHueSaturation(300);
    expect(hueSaturationToColorTemp(color.hue, color.saturation)).toBeCloseTo(
      300,
      6,
    );
  });

  test.each([
    [240, 100],
    [0, 100],
    [120, 100],
    [30, 100],
    [60, 50],
    [255, 68],
    [228, 56],
    [45, 80],
    [57, 18],
    [27, 42],
  ])("H=%d S=%d is a color, not a temperature", (hue, saturation) => {
    expect(hueSaturationToColorTemp(hue, saturation)).toBeUndefined();
  });
});

describe("z2mWriteToHomeKit", () => {
  test("a color_temp write shows the temperature and the Home app's color for it", () => {
    expect(z2mWriteToHomeKit({ state: "ON", color_temp: 250 })).toEqual({
      color_temp: 250,
      hue: 29,
      saturation: 36,
    });
  });

  test("a color write shows the color and the minimum temperature", () => {
    expect(z2mWriteToHomeKit({ color: { hue: 240, saturation: 100 } })).toEqual(
      { color_temp: 140, hue: 240, saturation: 100 },
    );
  });

  test("a hue or a saturation alone still shows the minimum temperature", () => {
    expect(z2mWriteToHomeKit({ color: { hue: 240 } })).toEqual({
      color_temp: 140,
      hue: 240,
    });
    expect(z2mWriteToHomeKit({ color: { saturation: 50 } })).toEqual({
      color_temp: 140,
      saturation: 50,
    });
  });

  test.each([
    { state: "ON", brightness: 254 },
    { color_temp: "warm" },
    { scene_recall: 3 },
  ])("%j says nothing about the color", (message) => {
    expect(z2mWriteToHomeKit(message)).toEqual({});
  });
});

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
    expect(() => z2mBrightnessToHomeKit(NaN)).toThrow(
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
    expect(() => homeKitBrightnessToZ2M(NaN)).toThrow(
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
    expect(() => wledBrightnessToHomeKit(NaN)).toThrow(
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
    expect(() => homeKitBrightnessToWled(NaN)).toThrow(
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

describe("wledRgb", () => {
  test("returns the color when the white channel is dark", () => {
    expect(wledRgb(255, 128, 0)).toEqual([255, 128, 0]);
  });

  test("adds the white channel to each color channel", () => {
    expect(wledRgb(100, 0, 0, 50)).toEqual([150, 50, 50]);
  });

  test("stops at 255", () => {
    expect(wledRgb(255, 200, 0, 128)).toEqual([255, 255, 128]);
  });
});

describe("parseWledHexColor", () => {
  test("parses #RRGGBB format", () => {
    expect(parseWledHexColor("#FF0000")).toEqual([255, 0, 0]);
  });

  test("parses without hash prefix", () => {
    expect(parseWledHexColor("00FF00")).toEqual([0, 255, 0]);
  });

  test("parses #WWRRGGBB with the white channel last", () => {
    expect(parseWledHexColor("#CCFF8000")).toEqual([255, 128, 0, 204]);
  });

  test("parses white alone", () => {
    expect(parseWledHexColor("#FF000000")).toEqual([0, 0, 0, 255]);
  });

  test("parses a white channel below 16, which has one digit", () => {
    expect(parseWledHexColor("#A123456")).toEqual([18, 52, 86, 10]);
  });

  test("returns undefined on more than eight digits", () => {
    expect(parseWledHexColor("#FF00000000")).toBeUndefined();
  });

  test("returns undefined on trailing non-hex characters", () => {
    expect(parseWledHexColor("#FF0000zz")).toBeUndefined();
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

describe("a WLED device with white segments", () => {
  const LINEAR = {
    colorSegments: [0],
    whiteSegments: [1, 2],
    whiteChannels: { r: 5500, g: 2400, b: 5500, w: 2400 },
  };
  const NOOK = { ...LINEAR, gamma: 2.2 };
  const dark = { id: 0, on: false, sel: false };
  const white = (col: number[]) => [
    dark,
    { id: 1, on: true, sel: true, col: [col], fx: 0 },
    { id: 2, on: true, sel: true, col: [col], fx: 0 },
  ];
  const color = (col: number[]) => [
    { id: 1, on: false, sel: false },
    { id: 2, on: false, sel: false },
    { id: 0, on: true, sel: true, col: [col], fx: 0 },
  ];

  test("its ColorTemperature range is what the strips span, in whole mireds", () => {
    expect(colorTempRange(NOOK)).toEqual([182, 416]);
  });

  test("the end without a lit w channel reads as a color when it is not remembered", () => {
    expect(wledUnrememberedWhite(NOOK)).toEqual({ hue: 300, saturation: 100 });
    const light = (whiteChannels: {
      r: number;
      g: number;
      b: number;
      w: number;
    }) => ({
      ...NOOK,
      whiteChannels,
    });
    expect(
      wledUnrememberedWhite(light({ r: 2400, g: 5500, b: 2400, w: 5500 })),
    ).toEqual({ hue: 300, saturation: 100 });
    expect(
      wledUnrememberedWhite(light({ r: 2400, g: 2400, b: 2400, w: 5500 })),
    ).toEqual({ hue: 0, saturation: 0 });
    expect(wledToHomeKit({ col: [255, 0, 255, 0] }, undefined, NOOK)).toEqual({
      hue: 300,
      saturation: 100,
      color_temp: 182,
    });
    expect(wledUnrememberedWhite({})).toBeUndefined();
  });

  test("a device without white segments has HomeKit's range", () => {
    expect(colorTempRange({})).toEqual([140, 500]);
  });

  test.each([
    [416, [0, 255, 0, 255]],
    [370, [167, 255, 167, 255]],
    [299, [255, 255, 255, 255]],
    [250, [255, 199, 255, 199]],
    [182, [255, 0, 255, 0]],
  ])(
    "%d mireds lights the white segments with %j and darkens the color segment",
    (mireds, col) => {
      expect(homeKitToWled({ color_temp: mireds }, undefined, NOOK)).toEqual({
        seg: white(col),
      });
    },
  );

  test("without gamma the blend is linear in the channel values", () => {
    expect(homeKitToWled({ color_temp: 370 }, undefined, LINEAR)).toEqual({
      seg: white([100, 255, 100, 255]),
    });
  });

  test("a temperature beyond the strips is the nearer strip alone", () => {
    expect(homeKitToWled({ color_temp: 500 }, undefined, NOOK)).toEqual({
      seg: white([0, 255, 0, 255]),
    });
    expect(homeKitToWled({ color_temp: 140 }, undefined, NOOK)).toEqual({
      seg: white([255, 0, 255, 0]),
    });
  });

  test.each([
    ["white", 0, 0, [167, 255, 167, 255]],
    ["warm white", 31, 33, [167, 255, 167, 255]],
    ["cool white", 208, 17, [255, 199, 255, 199]],
    ["a Home app temperature swatch", 30, 48, [255, 249, 255, 249]],
  ])("%s lights the white segments", (_, hue, saturation, col) => {
    expect(homeKitToWled({ hue, saturation }, undefined, NOOK)).toEqual({
      seg: white(col),
    });
  });

  test("white uses whiteColorTemp", () => {
    expect(
      homeKitToWled({ hue: 0, saturation: 0 }, undefined, {
        ...NOOK,
        whiteColorTemp: 299,
      }),
    ).toEqual({ seg: white([255, 255, 255, 255]) });
  });

  test("a color lights the color segment and darkens the white segments", () => {
    expect(
      homeKitToWled({ hue: 240, saturation: 100 }, undefined, NOOK),
    ).toEqual({ seg: color([0, 0, 255]) });
  });

  test("a color or temperature that is not solid leaves the effect", () => {
    expect(
      homeKitToWled({ hue: 240, saturation: 100 }, undefined, NOOK, false),
    ).toEqual({
      seg: [
        { id: 1, on: false, sel: false },
        { id: 2, on: false, sel: false },
        { id: 0, on: true, sel: true, col: [[0, 0, 255]] },
      ],
    });
    expect(
      homeKitToWled({ color_temp: 299 }, undefined, NOOK, false).seg,
    ).toEqual([
      dark,
      { id: 1, on: true, sel: true, col: [[255, 255, 255, 255]] },
      { id: 2, on: true, sel: true, col: [[255, 255, 255, 255]] },
    ]);
    expect(
      homeKitToWled({ hue: 0, saturation: 100 }, undefined, {}, false),
    ).toEqual({ seg: [{ col: [[255, 0, 0]] }] });
  });

  test("on and brightness go with the segments", () => {
    expect(
      homeKitToWled(
        { on: true, brightness: 100, hue: 0, saturation: 0 },
        undefined,
        NOOK,
      ),
    ).toEqual({ on: true, bri: 255, seg: white([167, 255, 167, 255]) });
    expect(homeKitToWled({ on: false }, undefined, NOOK)).toEqual({
      on: false,
    });
  });

  test("a temperature wins over a color in the same write", () => {
    expect(
      homeKitToWled(
        { color_temp: 299, hue: 240, saturation: 100 },
        undefined,
        NOOK,
      ),
    ).toEqual({ seg: white([255, 255, 255, 255]) });
  });

  test("the minimum temperature with a hue and saturation is the color", () => {
    expect(
      homeKitToWled(
        { color_temp: 182, hue: 240, saturation: 100 },
        undefined,
        NOOK,
      ),
    ).toEqual({ seg: color([0, 0, 255]) });
  });

  test("a saturation alone takes the hue from the reported color", () => {
    expect(
      homeKitToWled({ saturation: 100 }, { col: [0, 0, 255] }, NOOK),
    ).toEqual({ seg: color([0, 0, 255]) });
  });

  test("a device without white segments ignores a color temperature", () => {
    expect(homeKitToWled({ color_temp: 370 })).toEqual({});
  });

  test("reads a white segment's color as a temperature and the Home app's color for it", () => {
    expect(
      wledToHomeKit({ col: [167, 255, 167, 255] }, undefined, NOOK),
    ).toEqual({ color_temp: 370, hue: 30, saturation: 67 });
  });

  test("gives every temperature of the range back from its channel values", () => {
    for (const light of [NOOK, LINEAR]) {
      for (let mireds = 182; mireds <= 416; mireds++) {
        const col = (
          homeKitToWled({ color_temp: mireds }, undefined, light).seg as {
            col?: number[][];
          }[]
        ).at(-1)!.col![0]!;
        expect(
          Math.abs(
            wledToHomeKit({ col }, undefined, light).color_temp! - mireds,
          ),
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  test("reads the color segment's color with the minimum temperature", () => {
    expect(wledToHomeKit({ col: [0, 0, 255] }, undefined, NOOK)).toEqual({
      color_temp: 182,
      hue: 240,
      saturation: 100,
    });
  });

  test("cool strips alone are a temperature only when that white was written", () => {
    const col = [255, 0, 255, 0];
    expect(wledToHomeKit({ col }, { col, white: col }, NOOK)).toEqual({
      color_temp: 182,
      hue: 24,
      saturation: 12,
    });
    expect(wledToHomeKit({ col }, { col, white: false }, NOOK)).toEqual({
      color_temp: 182,
      hue: 300,
      saturation: 100,
    });
    expect(wledToHomeKit({ col }, undefined, NOOK)).toMatchObject({
      hue: 300,
    });
    expect(
      wledToHomeKit({ col }, { col, white: [0, 255, 0, 255] }, NOOK),
    ).toMatchObject({ hue: 300 });
  });

  test("a color written after a white is not read as a temperature", () => {
    const col = [0, 0, 255];
    expect(
      wledToHomeKit({ col }, { col, white: [255, 0, 255, 0] }, NOOK),
    ).toMatchObject({
      hue: 240,
      saturation: 100,
    });
  });

  test("dark white segments read as no temperature", () => {
    const col = [0, 0, 0, 0];
    expect(wledToHomeKit({ col }, { col, white: col }, NOOK)).toEqual({
      color_temp: 182,
      hue: 0,
      saturation: 0,
    });
  });

  test("an update without a color reports none", () => {
    expect(
      wledToHomeKit({ bri: 128 }, { bri: 128, col: [0, 0, 255] }, NOOK),
    ).toEqual({ brightness: 50 });
  });

  test("an update is read against the merged state", () => {
    const col = [255, 0, 255, 0];
    expect(
      wledToHomeKit({ col }, { on: true, col, white: col }, NOOK),
    ).toMatchObject({ color_temp: 182 });
  });

  test("ignores a malformed color", () => {
    expect(wledToHomeKit({ col: [1, 2] }, undefined, NOOK)).toEqual({});
    expect(wledToHomeKit({ col: "red" }, undefined, NOOK)).toEqual({});
  });

  describe("wledWrite", () => {
    test("a white write leaves the white segments' color", () => {
      expect(
        wledWrite(homeKitToWled({ color_temp: 299 }, undefined, NOOK), NOOK),
      ).toEqual({ col: [255, 255, 255, 255], white: [255, 255, 255, 255] });
    });

    test("a color write leaves the color segment's color", () => {
      expect(
        wledWrite(
          homeKitToWled({ hue: 240, saturation: 100 }, undefined, NOOK),
          NOOK,
        ),
      ).toEqual({ col: [0, 0, 255], white: false });
    });

    test("a write without segments leaves the color as it was", () => {
      expect(wledWrite({ on: true, bri: 255 }, NOOK)).toBeUndefined();
    });

    test("a device without white segments has no such state", () => {
      expect(wledWrite({ seg: [{ col: [[255, 0, 0]] }] }, {})).toBeUndefined();
    });
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

  test("parses /c hex color with a white channel", () => {
    expect(parseWledMessage("c", "#80FF0000")).toEqual({
      col: [255, 0, 0, 128],
    });
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

  test("in color_temp mode, reports the Home app's hue and saturation for the temperature", () => {
    expect(
      z2mToHomeKit({
        color: { hue: 32, saturation: 82, x: 0.4599, y: 0.4106 },
        color_mode: "color_temp",
        color_temp: 370,
      }),
    ).toEqual({ color_temp: 370, hue: 30, saturation: 67 });
  });

  test("in color_temp mode, a temperature outside HomeKit's range uses the nearest", () => {
    expect(z2mToHomeKit({ color_mode: "color_temp", color_temp: 574 })).toEqual(
      { color_temp: 574, hue: 29, saturation: 91 },
    );
  });

  test.each(["hs", "xy"])(
    "in %s mode, reports the minimum in place of the color_temp derived from the color",
    (mode) => {
      expect(
        z2mToHomeKit({
          color: { hue: 240, saturation: 100, x: 0.1355, y: 0.0399 },
          color_mode: mode,
          color_temp: 574,
        }),
      ).toEqual({ color_temp: 140, hue: 240, saturation: 100 });
    },
  );

  test("in a color mode, a light without color_hs gets no color_temp", () => {
    const blue = {
      color: { hue: 240, saturation: 100 },
      color_mode: "xy",
      color_temp: 574,
    };
    expect(z2mToHomeKit(blue, blue, ["on_off", "color_temp"])).toEqual({
      hue: 240,
      saturation: 100,
    });
    expect(
      z2mToHomeKit(blue, blue, ["on_off", "color_temp", "color_hs"]),
    ).toEqual({ color_temp: 140, hue: 240, saturation: 100 });
  });

  test("in color_temp mode without a numeric color_temp, passes the color through", () => {
    expect(
      z2mToHomeKit({
        color: { hue: 10, saturation: 20 },
        color_mode: "color_temp",
        color_temp: null,
      }),
    ).toEqual({ hue: 10, saturation: 20 });
  });

  describe("with the merged state", () => {
    const white = {
      brightness: 254,
      color: { hue: 32, saturation: 82 },
      color_mode: "color_temp",
      color_temp: 370,
    };

    test("an update without color fields reports no color", () => {
      expect(z2mToHomeKit({ brightness: 254 }, white)).toEqual({
        brightness: 100,
      });
    });

    test.each([
      { color_mode: "color_temp" },
      { color_temp: 370 },
      { color: { hue: 32, saturation: 82 } },
    ])("an update with only %j reports the whole color state", (partial) => {
      expect(z2mToHomeKit(partial, white)).toEqual({
        color_temp: 370,
        hue: 30,
        saturation: 67,
      });
    });

    test("an update takes the color mode from the merged state", () => {
      expect(
        z2mToHomeKit(
          { color: { hue: 240, saturation: 100 } },
          {
            color: { hue: 240, saturation: 100 },
            color_mode: "hs",
            color_temp: 574,
          },
        ),
      ).toEqual({ color_temp: 140, hue: 240, saturation: 100 });
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

  test("converts fan_state ON to active: 1", () => {
    expect(z2mToHomeKit({ fan_state: "ON" })).toEqual({ active: 1 });
  });

  test("converts fan_state OFF to active: 0", () => {
    expect(z2mToHomeKit({ fan_state: "OFF" })).toEqual({ active: 0 });
  });

  test("converts fan_mode medium to rotation_speed and target_fan_state", () => {
    expect(z2mToHomeKit({ fan_mode: "medium" })).toEqual({
      rotation_speed: 67,
      target_fan_state: 0,
    });
  });

  test("converts fan_mode smart to target_fan_state: 1", () => {
    expect(z2mToHomeKit({ fan_mode: "smart" })).toEqual({
      target_fan_state: 1,
    });
  });

  test("converts fan_mode on to empty (resume)", () => {
    expect(z2mToHomeKit({ fan_mode: "on" })).toEqual({});
  });

  test("converts fan_state and fan_mode together", () => {
    expect(z2mToHomeKit({ fan_state: "ON", fan_mode: "high" })).toEqual({
      active: 1,
      rotation_speed: 100,
      target_fan_state: 0,
    });
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

  test("reads a lit white channel alone as white", () => {
    expect(wledToHomeKit({ col: [0, 0, 0, 255] })).toEqual({
      hue: 0,
      saturation: 0,
    });
  });

  test("a white channel desaturates the color", () => {
    expect(wledToHomeKit({ col: [255, 0, 0, 128] })).toEqual({
      hue: 0,
      saturation: 50,
    });
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
    expect(homeKitToZ2m({ saturation: 80 })).toEqual({
      color: { saturation: 80 },
    });
  });

  test("wraps hue and saturation together", () => {
    expect(homeKitToZ2m({ hue: 240, saturation: 80 })).toEqual({
      color: { hue: 240, saturation: 80 },
    });
  });

  test("H=0/S=0 with cached color_temp sends the default white", () => {
    expect(
      homeKitToZ2m({ hue: 0, saturation: 0 }, { color_temp: 300 }),
    ).toEqual({
      color_temp: DEFAULT_WHITE_COLOR_TEMP,
    });
  });

  test("the default white is 2700 K", () => {
    expect(DEFAULT_WHITE_COLOR_TEMP).toBe(370);
  });

  test("white ignores the color_temp that Zigbee2MQTT derives from a color", () => {
    const blue = {
      color: { hue: 240, saturation: 100, x: 0.1355, y: 0.0399 },
      color_mode: "xy",
      color_temp: 574,
    };
    expect(homeKitToZ2m({ hue: 0, saturation: 0 }, blue)).toEqual({
      color_temp: DEFAULT_WHITE_COLOR_TEMP,
    });
  });

  test("white sends the configured color temperature", () => {
    expect(
      homeKitToZ2m(
        { hue: 0, saturation: 0 },
        { color_temp: 574 },
        { whiteColorTemp: 250 },
      ),
    ).toEqual({ color_temp: 250 });
  });

  test("a configured white needs no cached color_temp", () => {
    expect(
      homeKitToZ2m({ hue: 0, saturation: 0 }, undefined, {
        whiteColorTemp: 250,
      }),
    ).toEqual({
      color_temp: 250,
    });
    expect(
      homeKitToZ2m({ hue: 228, saturation: 56 }, {}, { whiteColorTemp: 250 }),
    ).toEqual({
      color_temp: 250,
    });
  });

  test("zero saturation at any hue is white", () => {
    expect(
      homeKitToZ2m({ hue: 120, saturation: 0 }, { color_temp: 300 }),
    ).toEqual({ color_temp: DEFAULT_WHITE_COLOR_TEMP });
  });

  test("zero saturation alone is white", () => {
    expect(homeKitToZ2m({ saturation: 0 }, { color_temp: 300 })).toEqual({
      color_temp: DEFAULT_WHITE_COLOR_TEMP,
    });
  });

  test("zero saturation alone without cached color_temp sends color object", () => {
    expect(homeKitToZ2m({ saturation: 0 })).toEqual({
      color: { saturation: 0 },
    });
  });

  test("hue alone is a color even when it is zero", () => {
    expect(
      homeKitToZ2m({ hue: 0 }, { color_temp: 300 }, { whiteColorTemp: 250 }),
    ).toEqual({
      color: { hue: 0 },
    });
  });

  test("a color near white stays a color", () => {
    expect(
      homeKitToZ2m(
        { hue: 30, saturation: 5 },
        { color_temp: 300 },
        { whiteColorTemp: 250 },
      ),
    ).toEqual({ color: { hue: 30, saturation: 5 } });
  });

  test("warm white (H=31/S=33) sends 2700 K", () => {
    expect(
      homeKitToZ2m({ hue: 31, saturation: 33 }, { color_temp: 300 }),
    ).toEqual({ color_temp: 370 });
  });

  test("cool white (H=208/S=17) sends 4000 K", () => {
    expect(COOL_WHITE_COLOR_TEMP).toBe(250);
    expect(
      homeKitToZ2m({ hue: 208, saturation: 17 }, { color_temp: 300 }),
    ).toEqual({ color_temp: COOL_WHITE_COLOR_TEMP });
  });

  test.each([
    ["halogen", 33, 12, 313],
    ["warm fluorescent", 35, 10, 333],
    ["standard fluorescent", 153, 4, COOL_WHITE_COLOR_TEMP],
    ["full spectrum fluorescent", 9, 5, 200],
  ])(
    "Siri's %s (H=%d/S=%d) sends %d mireds",
    (_name, hue, saturation, mireds) => {
      expect(homeKitToZ2m({ hue, saturation }, { color_temp: 300 })).toEqual({
        color_temp: mireds,
      });
    },
  );

  test.each([
    ["incandescent", 45, 100],
    ["sunlight", 45, 80],
  ])("Siri's %s (H=%d/S=%d) stays a color", (_name, hue, saturation) => {
    expect(homeKitToZ2m({ hue, saturation }, { color_temp: 300 })).toEqual({
      color: { hue, saturation },
    });
  });

  test("a named light source ignores whiteColorTemp", () => {
    expect(
      homeKitToZ2m({ hue: 33, saturation: 12 }, undefined, {
        whiteColorTemp: 250,
      }),
    ).toEqual({ color_temp: 313 });
  });

  test("a named light source without white LEDs stays a color", () => {
    expect(homeKitToZ2m({ hue: 33, saturation: 12 })).toEqual({
      color: { hue: 33, saturation: 12 },
    });
  });

  test("cool white without white LEDs stays a color", () => {
    expect(homeKitToZ2m({ hue: 208, saturation: 17 })).toEqual({
      color: { hue: 208, saturation: 17 },
    });
  });

  test.each([
    [28, 23, 211],
    [30, 48, 293],
    [30, 67, 372],
    [30, 84, 460],
  ])(
    "H=%d/S=%d on the Home app's temperature curve sends %d mireds",
    (hue, saturation, mireds) => {
      expect(homeKitToZ2m({ hue, saturation }, { color_temp: 300 })).toEqual({
        color_temp: mireds,
      });
    },
  );

  test("a temperature cooler than HomeKit's range sends the coolest", () => {
    expect(
      homeKitToZ2m({ hue: 222, saturation: 20 }, { color_temp: 300 }),
    ).toEqual({ color_temp: 140 });
  });

  test("a color on the temperature curve without white LEDs stays a color", () => {
    expect(homeKitToZ2m({ hue: 30, saturation: 67 })).toEqual({
      color: { hue: 30, saturation: 67 },
    });
  });

  test("warm white ignores whiteColorTemp", () => {
    expect(
      homeKitToZ2m({ hue: 31, saturation: 33 }, undefined, {
        whiteColorTemp: 250,
      }),
    ).toEqual({ color_temp: DEFAULT_WHITE_COLOR_TEMP });
  });

  test("warm white without white LEDs stays a color", () => {
    expect(homeKitToZ2m({ hue: 31, saturation: 33 })).toEqual({
      color: { hue: 31, saturation: 33 },
    });
  });

  test("the color_temp capability shows white LEDs before any state arrives", () => {
    const light = { capabilities: ["on_off", "color_temp", "color_hs"] };
    expect(homeKitToZ2m({ hue: 0, saturation: 0 }, undefined, light)).toEqual({
      color_temp: DEFAULT_WHITE_COLOR_TEMP,
    });
    expect(homeKitToZ2m({ hue: 31, saturation: 33 }, undefined, light)).toEqual(
      { color_temp: DEFAULT_WHITE_COLOR_TEMP },
    );
  });

  test("other capabilities do not show white LEDs", () => {
    expect(
      homeKitToZ2m({ hue: 0, saturation: 0 }, undefined, {
        capabilities: ["on_off", "color_hs"],
      }),
    ).toEqual({ color: { hue: 0, saturation: 0 } });
  });

  test("the minimum color temperature with a hue and saturation is the color", () => {
    expect(
      homeKitToZ2m({ color_temp: 140, hue: 240, saturation: 100 }),
    ).toEqual({ color: { hue: 240, saturation: 100 } });
  });

  test("the minimum color temperature with a white is that white", () => {
    expect(
      homeKitToZ2m(
        { color_temp: 140, hue: 30, saturation: 67 },
        { color_temp: 300 },
      ),
    ).toEqual({ color_temp: 372 });
  });

  test("the minimum color temperature alone, or with a hue alone, is a temperature", () => {
    expect(homeKitToZ2m({ color_temp: 140 })).toEqual({ color_temp: 140 });
    expect(homeKitToZ2m({ color_temp: 140, hue: 240 })).toEqual({
      color_temp: 140,
    });
  });

  test("a color temperature wins over a color in the same write", () => {
    expect(
      homeKitToZ2m(
        { color_temp: 250, hue: 240, saturation: 100 },
        { color_temp: 300 },
      ),
    ).toEqual({ color_temp: 250 });
    expect(homeKitToZ2m({ color_temp: 250, hue: 0, saturation: 0 })).toEqual({
      color_temp: 250,
    });
  });

  test("white keeps the other fields of the write", () => {
    expect(
      homeKitToZ2m(
        { on: true, brightness: 100, hue: 0, saturation: 0 },
        { color_temp: 300 },
      ),
    ).toEqual({
      state: "ON",
      brightness: 254,
      color_temp: DEFAULT_WHITE_COLOR_TEMP,
    });
  });

  test("H=0/S=0 without cached color_temp sends color object", () => {
    expect(homeKitToZ2m({ hue: 0, saturation: 0 })).toEqual({
      color: { hue: 0, saturation: 0 },
    });
  });

  test("H=228/S=56 with cached color_temp sends the default white", () => {
    expect(
      homeKitToZ2m({ hue: 228, saturation: 56 }, { color_temp: 300 }),
    ).toEqual({
      color_temp: DEFAULT_WHITE_COLOR_TEMP,
    });
  });

  test("H=228/S=56 without cached color_temp sends color object", () => {
    expect(homeKitToZ2m({ hue: 228, saturation: 56 })).toEqual({
      color: { hue: 228, saturation: 56 },
    });
  });

  test("converts all fields together", () => {
    expect(
      homeKitToZ2m({ on: true, brightness: 80, hue: 120, saturation: 100 }),
    ).toEqual({
      state: "ON",
      brightness: 203,
      color: { hue: 120, saturation: 100 },
    });
  });

  test("returns empty object for empty input", () => {
    expect(homeKitToZ2m({})).toEqual({});
  });

  test("active: 1 → fan_state: ON", () => {
    expect(homeKitToZ2m({ active: 1 })).toEqual({ fan_state: "ON" });
  });

  test("active: 0 → fan_state: OFF", () => {
    expect(homeKitToZ2m({ active: 0 })).toEqual({ fan_state: "OFF" });
  });

  test("rotation_speed → fan_mode via speed mapping", () => {
    expect(homeKitToZ2m({ rotation_speed: 33 })).toEqual({ fan_mode: "low" });
    expect(homeKitToZ2m({ rotation_speed: 67 })).toEqual({
      fan_mode: "medium",
    });
    expect(homeKitToZ2m({ rotation_speed: 0 })).toEqual({ fan_mode: "off" });
  });

  test("target_fan_state: 1 → fan_mode: smart (overrides rotation_speed)", () => {
    expect(homeKitToZ2m({ target_fan_state: 1, rotation_speed: 50 })).toEqual({
      fan_mode: "smart",
    });
  });

  test("target_fan_state: 0 without rotation_speed converts cached speed back", () => {
    expect(homeKitToZ2m({ target_fan_state: 0 }, { fan_mode: "high" })).toEqual(
      { fan_mode: "high" },
    );
  });

  test("target_fan_state: 0 with cached smart mode defaults to medium", () => {
    expect(
      homeKitToZ2m({ target_fan_state: 0 }, { fan_mode: "smart" }),
    ).toEqual({ fan_mode: "medium" });
  });

  test("target_fan_state: 0 with no cache defaults to medium", () => {
    expect(homeKitToZ2m({ target_fan_state: 0 })).toEqual({
      fan_mode: "medium",
    });
  });

  test("active and rotation_speed together", () => {
    expect(homeKitToZ2m({ active: 1, rotation_speed: 100 })).toEqual({
      fan_state: "ON",
      fan_mode: "high",
    });
  });
});

describe("z2mFanModeToHomeKit", () => {
  test("off → rotation_speed: 0, target_fan_state: 0", () => {
    expect(z2mFanModeToHomeKit("off")).toEqual({
      rotation_speed: 0,
      target_fan_state: 0,
    });
  });

  test("low → rotation_speed: 33, target_fan_state: 0", () => {
    expect(z2mFanModeToHomeKit("low")).toEqual({
      rotation_speed: 33,
      target_fan_state: 0,
    });
  });

  test("medium → rotation_speed: 67, target_fan_state: 0", () => {
    expect(z2mFanModeToHomeKit("medium")).toEqual({
      rotation_speed: 67,
      target_fan_state: 0,
    });
  });

  test("high → rotation_speed: 100, target_fan_state: 0", () => {
    expect(z2mFanModeToHomeKit("high")).toEqual({
      rotation_speed: 100,
      target_fan_state: 0,
    });
  });

  test("smart → target_fan_state: 1 (no rotation_speed)", () => {
    expect(z2mFanModeToHomeKit("smart")).toEqual({ target_fan_state: 1 });
  });

  test("on → empty (resume previous speed)", () => {
    expect(z2mFanModeToHomeKit("on")).toEqual({});
  });

  test("unknown mode → empty", () => {
    expect(z2mFanModeToHomeKit("unknown")).toEqual({});
  });
});

describe("homeKitSpeedToZ2mFanMode", () => {
  test("0 → off", () => {
    expect(homeKitSpeedToZ2mFanMode(0)).toBe("off");
  });

  test("negative → off", () => {
    expect(homeKitSpeedToZ2mFanMode(-5)).toBe("off");
  });

  test("1 → low", () => {
    expect(homeKitSpeedToZ2mFanMode(1)).toBe("low");
  });

  test.each([
    [33, "low"],
    [100 / 3, "low"],
    [49, "low"],
    [50, "medium"],
    [200 / 3, "medium"],
    [83, "medium"],
    [84, "high"],
    [100, "high"],
  ])("%p → %s, the nearest step", (speed, mode) => {
    expect(homeKitSpeedToZ2mFanMode(speed)).toBe(mode);
  });
});

describe("fan speed round-trip", () => {
  const ROUND_TRIP_MODES = ["off", "low", "medium", "high"] as const;

  for (const mode of ROUND_TRIP_MODES) {
    test(`Z2M → HomeKit → Z2M: "${mode}" round-trips`, () => {
      const hk = z2mFanModeToHomeKit(mode);
      expect(hk.rotation_speed).toBeDefined();
      expect(homeKitSpeedToZ2mFanMode(hk.rotation_speed!)).toBe(mode);
    });
  }

  for (let speed = 0; speed <= 100; speed++) {
    test(`HomeKit → Z2M → HomeKit: ${String(speed)}% round-trips to canonical value`, () => {
      const mode = homeKitSpeedToZ2mFanMode(speed);
      const hk = z2mFanModeToHomeKit(mode);
      const canonical = hk.rotation_speed!;
      expect(homeKitSpeedToZ2mFanMode(canonical)).toBe(mode);
    });
  }
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
      seg: [{ col: [[255, 0, 0]], fx: 0 }],
    });
  });

  test("H=0/S=0 sends full white RGB", () => {
    expect(homeKitToWled({ hue: 0, saturation: 0 })).toEqual({
      seg: [{ col: [[255, 255, 255]], fx: 0 }],
    });
  });

  test("H=228/S=56 sends full white RGB", () => {
    expect(homeKitToWled({ hue: 228, saturation: 56 })).toEqual({
      seg: [{ col: [[255, 255, 255]], fx: 0 }],
    });
  });

  test("fills missing hue from cached state", () => {
    const cached = { on: true, bri: 128, col: [255, 0, 0] };
    expect(homeKitToWled({ saturation: 100 }, cached)).toEqual({
      seg: [{ col: [[255, 0, 0]], fx: 0 }],
    });
  });

  test("fills missing saturation from cached state", () => {
    const cached = { on: true, bri: 128, col: [0, 255, 0] };
    expect(homeKitToWled({ hue: 120 }, cached)).toEqual({
      seg: [{ col: [[0, 255, 0]], fx: 0 }],
    });
  });

  test("converts all fields together", () => {
    expect(
      homeKitToWled({ on: true, brightness: 100, hue: 0, saturation: 100 }),
    ).toEqual({
      on: true,
      bri: 255,
      seg: [{ col: [[255, 0, 0]], fx: 0 }],
    });
  });

  test("returns empty object for empty input", () => {
    expect(homeKitToWled({})).toEqual({});
  });
});
