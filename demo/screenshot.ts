import { writeFileSync } from "node:fs";
import { captureStatusPage } from "./capture.ts";

const screenshot = await captureStatusPage();
writeFileSync("demo/status-page.png", screenshot);
