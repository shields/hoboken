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

  const browser = await chromium.launch();
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
