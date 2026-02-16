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
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { captureStatusPage } from "../demo/capture.ts";

const GOLDEN_FILE = "demo/status-page.png";

// Golden file is rendered in Docker for deterministic fonts; skip outside Docker.
describe.skipIf(!process.env.PLAYWRIGHT_IN_DOCKER)("screenshot golden file", () => {
  test(
    "matches demo/status-page.png",
    async () => {
      if (!existsSync(GOLDEN_FILE)) {
        throw new Error(
          `Golden file ${GOLDEN_FILE} not found. Run \`bun run demo:golden-screenshot\` to generate it.`,
        );
      }

      const actualPng = await captureStatusPage();
      const expectedPng = await readFile(GOLDEN_FILE);

      const actual = PNG.sync.read(actualPng);
      const expected = PNG.sync.read(expectedPng);

      expect(actual.width).toBe(expected.width);
      expect(actual.height).toBe(expected.height);

      const diff = new PNG({ width: actual.width, height: actual.height });

      const numDiff = pixelmatch(
        actual.data,
        expected.data,
        diff.data,
        actual.width,
        actual.height,
        { threshold: 0.1 },
      );

      if (numDiff > 0) {
        await writeFile("demo/status-page-actual.png", actualPng);
        await writeFile("demo/status-page-diff.png", PNG.sync.write(diff));
        throw new Error(
          `Screenshot differs by ${String(numDiff)} pixels. ` +
            "Actual and diff saved to demo/. Run `bun run demo:golden-screenshot` to regenerate.",
        );
      }
    },
    30000,
  );
});
