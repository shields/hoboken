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

// Runs in a fresh process because Node warns about a deprecated url.parse call
// and about an invalid port once per process, and a test process may already
// have used them.

import { connect } from "mqtt";
import { validateConfig } from "../src/config.ts";
import {
  MALFORMED_MQTT_URLS,
  VALID_MQTT_URLS,
  type URLReport,
} from "./mqtt-urls.ts";

const warnings: string[] = [];
process.on("warning", (warning) => {
  warnings.push(`${warning.name}: ${warning.message}`);
});

function validates(url: string): boolean {
  try {
    validateConfig({
      bridge: {
        name: "Hoboken",
        mac: "0E:42:A1:B2:C3:D4",
        pincode: "031-45-154",
        port: 51826,
      },
      mqtt: { url },
      devices: [
        { name: "Light", topic: "zigbee2mqtt/light", capabilities: ["on_off"] },
      ],
    });
    return true;
  } catch {
    return false;
  }
}

function mqttJSError(url: string): string | undefined {
  try {
    connect(url, { manualConnect: true });
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

const report: URLReport = {
  rejectedValid: VALID_MQTT_URLS.filter((url) => !validates(url)),
  acceptedMalformed: MALFORMED_MQTT_URLS.filter(validates),
  mqttJSRejectedValid: VALID_MQTT_URLS.filter(
    (url) => mqttJSError(url) !== undefined,
  ),
  mqttJSBareHostname: mqttJSError("broker"),
  warnings,
};

// process.emitWarning delivers on the next tick.
await new Promise((resolve) => {
  setImmediate(resolve);
});
console.log(JSON.stringify(report));
