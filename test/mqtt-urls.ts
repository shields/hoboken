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

export const SECRET = "pw123";
export const INVALID_MQTT_URL = "mqtt.url is not a valid MQTT URL";

// What test/mqtt-url-report.ts prints, from a fresh process.
export interface URLReport {
  rejectedValid: string[];
  acceptedMalformed: string[];
  mqttJSRejectedValid: string[];
  mqttJSBareHostname: string | undefined;
  warnings: string[];
}

// Every form that the repository's configs, docs, and tests use on purpose,
// plus the other forms that mqtt.js connects with.
export const VALID_MQTT_URLS = [
  "mqtt://mosquitto:1883",
  "mqtt://localhost",
  "mqtt://localhost:1883",
  "mqtt://127.0.0.1:18883",
  "mqtt://zigbee-hub.local:1883",
  "mqtts://broker.example.com:8883",
  "tcp://broker:1883",
  "ssl://broker:8883",
  "tls://broker:8883",
  "ws://broker:9001/mqtt",
  "ws://broker:80/mqtt",
  "wss://broker/mqtt?token=a%20b",
  "wss://broker:443",
  "mqtt://[::1]:1883",
  "mqtt://[0:0:0:0:0:0:0:1]:1883",
  "mqtt://[fe80::1]:1883",
  "MQTT://Broker.Example.com:1883",
  "mqtt://my_host:1883",
  "mqtt://broker:",
  "mqtt://broker:01883",
  "mqtt://1.2.3.4:65535",
  " mqtt://broker:1883 ",
  "mqtt://user:pw@broker:1883",
  "mqtt://user@broker",
  "mqtt://:pw@broker",
  "mqtt://@broker",
  "mqtt://u:p@ss@broker",
  "mqtt://user:p%40ss@broker",
  "mqtts://user:pw@broker/path",
  "mqtt://user:pw@[::1]:1883/some/path?x=1#fragment",
  "mqtt://broker:1883/a@b",
  "mqtt://broker:1883?x=a@b",
  "mqtt://broker:1883#a@b",
  "mqtt://broker:1883/a//b@c",
  "ws://broker:9001/mqtt?next=//x@y",
  "mqtt://broker:1883#//x@y",
];

// Each that has a place for credentials carries SECRET there, so that a
// message, a log line, or a page that quotes any part of the URL shows it.
export const MALFORMED_MQTT_URLS = [
  // Ports that are not 1 to 65535.
  `mqtt://user:${SECRET}@127.0.0.1:18x3`,
  `mqtt://user:${SECRET}@127.0.0.1:99999`,
  `mqtt://user:${SECRET}@127.0.0.1:65536`,
  `mqtt://user:${SECRET}@127.0.0.1:0`,
  `mqtt://user:${SECRET}@127.0.0.1:-1`,
  `mqtt://user:${SECRET}@broker:1883:1883`,
  `mqtts://user:${SECRET}@broker:8883x`,
  `ws://user:${SECRET}@broker:99999/mqtt`,
  // Characters that url.parse ends a host at and moves into the path.
  `mqtt://user:${SECRET}@bro ker:1883`,
  `mqtt://user:${SECRET}@host;x`,
  `mqtt://user:${SECRET}@host%41`,
  `mqtt://user:${SECRET}@ho"st`,
  `mqtt://user:${SECRET}@{host}`,
  `mqtt://user:${SECRET}@ho^st`,
  `mqtt://user:${SECRET}@ho|st`,
  `mqtt://user:${SECRET}@ho<st>`,
  // A host that is not ASCII, which url.parse writes in punycode and a WHATWG
  // URL of this scheme does not.
  `mqtt://user:${SECRET}@bröker`,
  // No host.
  `mqtt://user:${SECRET}@`,
  `mqtt://user:${SECRET}@/`,
  `mqtt://user:${SECRET}@:1883`,
  `mqtt://:${SECRET}@`,
  `mqtt://user:${SECRET}@?x`,
  "mqtt://",
  "mqtt:///path",
  // Forms that url.parse reads differently from a URL parser or without a
  // scheme or a host.
  `mqtt:user:${SECRET}@broker`,
  `mqtt:user:${SECRET}@127.0.0.1:18x3`,
  `//user:${SECRET}@broker`,
  `user:${SECRET}@broker`,
  `user:${SECRET}@broker:1883`,
  String.raw`mqtt:\\user:${SECRET}@broker`,
  String.raw`mqtt://user:${SECRET}\@broker`,
  String.raw`mqtt://u:${SECRET}\@[::1]:1883`,
  `mqtt://user:${SECRET}@[::1`,
  `mqtt://user:${SECRET}@::1`,
  `mqtt://us%er:${SECRET}@broker`,
  `mqtt://user:${SECRET}%zz@broker`,
  // An IPv6 address in a ws or wss URL, which mqtt.js cannot connect to.
  `ws://user:${SECRET}@[::1]:9001/mqtt`,
  `wss://user:${SECRET}@[2001:db8::1]/mqtt`,
  // Not an MQTT scheme.
  `http://user:${SECRET}@broker`,
  `ftp://user:${SECRET}@broker:21`,
  `mqtt+unix://user:${SECRET}@broker`,
  "mqtt+unix:///var/run/mosquitto.sock",
  "broker:1883",
  "broker",
  "not a valid url",
  " ".repeat(3),
];
