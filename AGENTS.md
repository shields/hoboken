# Hoboken Project Instructions

Minimal HomeKit bridge for Zigbee2MQTT (Z2M), WLED, and the heated bedding
(heated mattress pads and heated blankets) and curtains that the Tucson service
exposes over MQTT. It uses `@homebridge/hap-nodejs` directly, with no
framework.

`README.md` is the overview: what the bridge exposes, configuration,
deployment, and failure handling. The detail is in `doc/`:
`color-coalescing.md` for write coalescing, white and color handling, and WLED
white segments; `mqtt.md` for the broker URL, authentication, topic
permissions, and refusals; `tucson.md` for heated bedding and curtain behavior.
Read the relevant part before changing a feature, and update it with the
change. Keep the README short and put detail in `doc/`. This file holds only
rules and traps that those documents, the code, and the tests do not show;
describe behavior there, not here.

## Commands

```sh
make setup              # Frozen install; Lefthook pre-commit hook (make lint)
make fmt                # ESLint fixes and Prettier
make lint               # Workflow locks, tsc, ESLint, Renovate config, Prettier
make test               # Unit tests with coverage (Bun)
make test-integration   # Round trips through a real broker (Node.js); see README
make test-screenshot    # Full suite and status page golden file (Docker)
make golden-screenshot  # Regenerate the golden file (Docker)
make run                # Run with Node.js
make demo               # Serve the status page with sample data
```

## Toolchain

- Bun installs packages and runs the unit tests. The application and the
  integration tests run on Node.js, which strips types, so TypeScript syntax
  must be erasable.
- Follow the [shared TypeScript guide](https://github.com/shields/right-answers/blob/main/typescript.md).
  Keep its side-by-side aliases (`@typescript/native` for TypeScript 7's `tsc`,
  `typescript` for the TypeScript 6 API that typescript-eslint needs) until
  typescript-eslint supports the native compiler's API.
- `test/toolchain.test.ts` ties `packageManager`, `playwright`, and the
  `@types/node` major in package.json to the image tags in the Dockerfiles and
  `node-version` in `build.yml`. Renovate holds the Playwright npm release for
  3 days but not the image, so the image's PR is red until the npm release
  joins its branch.
- Pin every Docker base image as `image:tag@sha256:digest`. To update one, pull
  it and take the digest from `docker inspect`.

## Code

- Accessory creation takes `PublishFn` and `GetStateFn`, never the MQTT client.
- `tucson-source.ts`, `tucson-mqtt.ts`, and `tucson-profile.ts` own the MQTT
  session, request/result, and wire validation shared by heated bedding and
  curtains. The `heated-bedding-*` and `curtain-*` modules supply state parsing
  and accessory behavior.
- Write "homekit" out in identifiers (`homeKitToZ2m`, `HomeKitState`), not
  "hk", except in function-local variables.
- Do not add a `default: never` arm to a switch over a union such as
  `Capability`. The compiler already reports a missing case, and Bun's coverage
  has no ignore comments, so the unreachable arm fails the coverage threshold.
- New files carry the Apache 2.0 header, copied from an existing file: `//` for
  TypeScript, `#` for shell, after any shebang.

## Testing

- Check tests by mutation. Once a change and its tests pass, break the lines
  that the change added or edited, one small way at a time (invert a condition,
  move a boundary, change a constant, delete a statement or a branch), and run
  the tests that cover them. A mutant that every test passes shows a missing
  assertion, unless it cannot change behavior: add the test, see it fail, then
  restore the code. No mutation tool is installed, so mutate by hand. Stage the
  passing change first, so that `git diff` shows only the mutant and is empty
  again once it is restored.
- `make lint test` must pass before each commit. `bunfig.toml` sets 100%
  thresholds for lines, functions, and statements, with `demo/**` excluded.
  Coverage shows that a line ran, not that a test checks it.
- All verification is automated; no manual browser testing.
- Instantiate HAP-NodeJS objects directly; never mock hap-nodejs. The `mqtt`
  module is the only mock.
- Never load the machine to provoke a race (CPU burners, stress tools, floods
  of parallel runs). Make the ordering deterministic: fake timers or an
  injected clock in unit tests; in integration tests, have the simulated device
  or controller delay, drop, or reorder the specific message, and poll for the
  outcome with a deadline.
- Stop every process a test or probe starts before the command returns.
- `demo/status-page.png` is compared with a fresh screenshot of
  `demo/fixture.ts` at zero pixel tolerance. Regenerate it only with
  `make golden-screenshot`, which runs in the Docker image that CI uses, never
  on the host.

## Lights and fans

- Read `doc/color-coalescing.md` before changing how `src/convert.ts` or
  `makePublish` handles color, white, or WLED segments.
- Never publish the cached `color_temp` as a white. While a bulb shows a color,
  Zigbee2MQTT replaces it with a value computed from that color (574 mireds for
  blue). Whites go through `requestedColorTemp`.
- Convert a temperature to hue and saturation with `colorTempToHueSaturation`,
  the Home app's own curve, never HAP-NodeJS's `ColorUtils` table, which gives
  different colors.
- HAP-NodeJS checks a controller's write against a characteristic's range but
  not its `minStep`. A `fan_speed` device's `RotationSpeed` off the
  `FAN_SPEED_STEP` grid reaches `onSet` and stays on the characteristic until
  the next read or report; one above 100 fails before `onSet` runs.

## MQTT and secrets

- The password exists only in `MQTTCredentials`, which `main.ts` resolves and
  passes to `startBridge`. `Config` and `validateConfig` never hold or read it.
  Every MQTT client builds its options with `credentialOptions`, so that
  userinfo in the broker URL cannot replace the configured login.
- No part of `mqtt.url` is printed except through `displayMQTTURL`, because a
  malformed URL cannot be reliably stripped of its credentials. Every entry
  point checks the URL with `assertMQTTURL`, and every client is created and
  connected through `withoutErrorMessage`. Error messages name fields and never
  echo values.
- Add each new URL case to `test/mqtt-urls.ts`. A malformed URL that has a
  place for credentials carries a secret there, so that any output quoting part
  of it fails.
- A new config key must join its section's allowlist for `rejectUnknownFields`
  and the table in README "Supported keys".

## Tucson heated bedding and curtains

- An invalid heated bedding message tears down the whole heated bedding
  connection, which reconnects with backoff, instead of invalidating one zone,
  because partially invalid state is not trusted.
- A heated bedding group has no source state. It reads every member through
  `usableState` and writes every member through the same
  `writeFan`/`writePreheat` path as the member's own accessory, so writes on a
  group and on a member need no coordination.
- A group's Active on must stay a `{ resume: true }` fan write, which sends
  nothing to a zone that is already on, not `{ active: true }`.
- A successful group write responds with the aggregate of every member's
  `usableState` read after the last member settles, never the states the
  members resolved with, because HAP stores the response as the
  characteristic's value without a notification.
- Tucson rejects a timer alone for a zone that is off, and preheat combined
  with anything, so only a power-on carries `auto_off_seconds`.
- Curtains expose only target position writes. Do not add start/stop commands
  or `HoldPosition` without a separate request.
- Use short zone names such as "Bed Side A".

## Status page

- The `GET /` status page is a diagnostic tool for operators. It deliberately
  shows raw state values, JSON payloads, MQTT topics, and internal IDs.
  Annotations (%, K, color swatches) are hints beside the raw data, not
  replacements for it.
- It targets Chrome/Edge 111+ and Safari 18+. Newer features such as the View
  Transitions API need a fallback.
