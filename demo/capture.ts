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

import { Registry } from "prom-client";
import { chromium } from "playwright";
import { startMetricsServer } from "../src/metrics.ts";
import { fixtureData } from "./fixture.ts";

export async function captureStatusPage(): Promise<Buffer> {
  const register = new Registry();
  const ms = startMetricsServer(0, register, "127.0.0.1", () => fixtureData);

  await new Promise<void>((resolve) => {
    ms.server.on("listening", resolve);
  });

  const addr = ms.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const browser = await chromium.launch({
    args: process.env.PLAYWRIGHT_IN_DOCKER ? ["--no-sandbox"] : [],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
    });
    await page.goto(`http://127.0.0.1:${String(port)}/`);

    const contentHeight: number = await page.evaluate(
      "document.documentElement.scrollHeight",
    );
    await page.setViewportSize({ width: 800, height: contentHeight });
    const screenshot = await page.screenshot();
    await page.close();
    return Buffer.from(screenshot);
  } finally {
    await browser.close();
    await ms.close();
  }
}
