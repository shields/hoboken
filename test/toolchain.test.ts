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

import { expect, test } from "bun:test";

const repoFile = (path: string) =>
  Bun.file(new URL(`../${path}`, import.meta.url));

const dockerBunTag = async (dockerfile: string) =>
  /^FROM oven\/bun:(\S+)@sha256:/m.exec(await repoFile(dockerfile).text())?.[1];

const dockerPlaywrightVersion = async () =>
  /^FROM mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(?:-[^\s@]+)?@sha256:/m.exec(
    await repoFile("Dockerfile.playwright").text(),
  )?.[1];

test("package.json and both Dockerfiles pin the same Bun release", async () => {
  const { packageManager } = (await repoFile("package.json").json()) as {
    packageManager?: unknown;
  };
  expect(packageManager).toMatch(/^bun@\S+$/);
  const version = (packageManager as string).slice("bun@".length);
  expect({
    Dockerfile: await dockerBunTag("Dockerfile"),
    "Dockerfile.playwright": await dockerBunTag("Dockerfile.playwright"),
  }).toEqual({ Dockerfile: version, "Dockerfile.playwright": version });
});

test("package.json and Dockerfile.playwright pin the same Playwright release", async () => {
  const { devDependencies } = (await repoFile("package.json").json()) as {
    devDependencies?: Record<string, string>;
  };
  const version = devDependencies?.playwright;
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(await dockerPlaywrightVersion()).toBe(version);
});

test("the production image, CI, and the Tucson driver use one Node.js major", async () => {
  const image = /^FROM gcr\.io\/distroless\/nodejs(\d+)-/m.exec(
    await repoFile("Dockerfile").text(),
  )?.[1];
  expect(image).toMatch(/^\d+$/);
  expect({
    ci: /^\s*node-version: (\d+)$/m.exec(
      await repoFile(".github/workflows/build.yml").text(),
    )?.[1],
    driver: /process\.versions\.node\.startsWith\("(\d+)\."\)/.exec(
      await repoFile("integration/tucson-roundtrip.ts").text(),
    )?.[1],
  }).toEqual({ ci: image, driver: image });
});
