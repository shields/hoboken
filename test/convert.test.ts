import { describe, expect, test } from "bun:test";
import {
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

  test("throws on NaN", () => {
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

  test("converts 50 to 127", () => {
    expect(homeKitBrightnessToZ2M(50)).toBe(127);
  });

  test("clamps negative values to 0", () => {
    expect(homeKitBrightnessToZ2M(-10)).toBe(0);
  });

  test("clamps values above 100 to 254", () => {
    expect(homeKitBrightnessToZ2M(200)).toBe(254);
  });

  test("throws on NaN", () => {
    expect(() => homeKitBrightnessToZ2M(NaN)).toThrow(
      "brightness must be a number",
    );
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
