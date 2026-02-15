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
  homeKitBrightnessToZ2M,
  z2mBrightnessToHomeKit,
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

  test("converts 50 to 127", () => {
    expect(homeKitBrightnessToZ2M(50)).toBe(127);
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
