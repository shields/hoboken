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

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function poll(
  predicate: () => boolean | Promise<boolean>,
  timeout = 10000,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for integration test state");
}

// Every server stays open until all have a port, so the ports are distinct.
async function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  const ports = await Promise.all(
    servers.map(
      (server) =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            assert(address && typeof address === "object");
            resolve(address.port);
          });
        }),
    ),
  );
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    ),
  );
  return ports;
}

export async function freePortPair(): Promise<[number, number]> {
  const [first, second] = await freePorts(2);
  assert(first !== undefined && second !== undefined);
  return [first, second];
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

export interface BrokerAuth {
  users: Readonly<Record<string, string>>;
  acl: string;
}

// The pinned broker is built without mosquitto_passwd, so password file lines
// are generated here in its PBKDF2-SHA512 format.
function passwordLine(user: string, password: string): string {
  const salt = randomBytes(12);
  const hash = pbkdf2Sync(password, salt, 101, 64, "sha512");
  return `${user}:$7$101$${salt.toString("base64")}$${hash.toString("base64")}\n`;
}

export class TestBroker {
  readonly port: number;
  readonly url: string;
  #binary: string;
  #config: string;
  #process: ChildProcess | undefined;
  #error: Error | undefined;
  #stderr = "";

  constructor(
    binary: string,
    directory: string,
    port: number,
    auth?: BrokerAuth,
  ) {
    this.port = port;
    this.url = `mqtt://127.0.0.1:${String(port)}`;
    this.#binary = binary;
    this.#config = path.join(directory, "mosquitto.conf");
    let access = "allow_anonymous true\n";
    if (auth) {
      const passwords = path.join(directory, "passwd");
      const acl = path.join(directory, "acl");
      writeFileSync(
        passwords,
        Object.entries(auth.users)
          .map(([user, password]) => passwordLine(user, password))
          .join(""),
        { mode: 0o600 },
      );
      writeFileSync(acl, auth.acl, { mode: 0o600 });
      access = `allow_anonymous false\npassword_file ${passwords}\nacl_file ${acl}\n`;
    }
    writeFileSync(
      this.#config,
      `listener ${String(port)} 127.0.0.1\n${access}persistence true\npersistence_location ${directory}/\n`,
    );
  }

  async start(): Promise<void> {
    this.#error = undefined;
    this.#stderr = "";
    this.#process = spawn(this.#binary, ["-c", this.#config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.#process.stderr?.on("data", (data: Buffer) => {
      this.#stderr = (this.#stderr + data.toString()).slice(-8192);
    });
    this.#process.once("error", (error) => {
      this.#error = error;
    });
    this.#process.once("close", (code) => {
      if (code !== 0)
        this.#error = new Error(
          `MQTT test broker exited unsuccessfully: ${this.#stderr.trim()}`,
        );
    });
    // Mosquitto logs this line only once its own listeners are open, so another
    // process that holds the port cannot satisfy the wait.
    await poll(() => {
      if (this.#error) throw this.#error;
      return /mosquitto version \S+ running/.test(this.#stderr);
    });
  }

  async stop(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    if (
      child?.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("MQTT test broker shutdown timed out"));
      }, 5000);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("MQTT test broker shutdown failed"));
      });
      child.kill("SIGTERM");
    });
  }
}
