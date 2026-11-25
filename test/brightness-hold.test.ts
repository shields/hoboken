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
import { decideBrightnessHold } from "../src/brightness-hold.ts";

const base = {
  brightness: 50,
  shown: 100,
  held: undefined,
  first: false,
};

describe("decideBrightnessHold", () => {
  test("a brightness that HomeKit already shows is applied", () => {
    expect(decideBrightnessHold({ ...base, brightness: 100 })).toBe("apply");
    expect(decideBrightnessHold({ ...base, brightness: 100, held: 50 })).toBe(
      "apply",
    );
  });

  test("the first report of a device is applied", () => {
    expect(decideBrightnessHold({ ...base, first: true })).toBe("apply");
    expect(decideBrightnessHold({ ...base, first: true, held: 50 })).toBe(
      "apply",
    );
  });

  test("a brightness that differs from what HomeKit shows is held", () => {
    expect(decideBrightnessHold(base)).toBe("hold");
    expect(decideBrightnessHold({ ...base, shown: undefined })).toBe("hold");
  });

  test("a brightness that differs from the held one replaces it", () => {
    expect(decideBrightnessHold({ ...base, held: 30 })).toBe("hold");
  });

  test("a repeat of the held brightness keeps the hold", () => {
    expect(decideBrightnessHold({ ...base, held: 50 })).toBe("keep");
  });
});
