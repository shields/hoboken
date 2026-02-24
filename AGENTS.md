# Hoboken Project Instructions

## Project Overview

Minimal HomeKit bridge for Zigbee2MQTT. Uses `@homebridge/hap-nodejs` directly
(no framework). Connects to MQTT, reads device config from YAML.

## Toolchain

- **Runtime**: Node.js 24 LTS with unflagged TypeScript type stripping
- **Package manager**: Bun (`bun install`, `bun.lock`)
- **Test runner**: Bun test (`bun test`, `bun test --coverage`)
- **TypeScript 5.9**: type checking only (`noEmit`), `erasableSyntaxOnly`
- **ESLint 10**: `typescript-eslint` with `strictTypeChecked` + `stylisticTypeChecked`
- **Container**: `gcr.io/distroless/nodejs24-debian13`

## Commands

```sh
bun install                       # Install dependencies
bun run check                     # TypeScript type checking (tsc --noEmit)
bun run lint                      # ESLint
bun run test                      # Run all tests with coverage
bun run start                     # Run with Node.js
bun run demo:golden-screenshot    # Regenerate status page golden file (Docker)
```

## Module Architecture

Each module is independently testable with dependency injection:

- `src/config.ts` — Config loading/validation, type definitions
- `src/convert.ts` — Pure value conversion functions (Z2M ↔ HomeKit)
- `src/accessories.ts` — HAP accessory/scene creation, takes `PublishFn`/`GetStateFn`
- `src/bridge.ts` — MQTT client, bridge wiring, state cache, lifecycle
- `src/main.ts` — Entry point (~10 lines)

## Key Design Decisions

- **Dependency injection**: Accessory creation takes `publish` and `getState`
  functions, not MQTT client. This enables testing without mocking hap-nodejs.
- **MQTT is the only mock boundary**: HAP-NodeJS objects (Bridge, Accessory,
  Service, Characteristic) are lightweight enough to instantiate directly in tests.
- **Scenes as momentary switches**: `onSet(true)` publishes `{"scene_recall": id}`,
  then auto-resets to off after 1 second.
- **MQTT disconnect handling**: `onSet` throws
  `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` when MQTT is disconnected.
- **No config reload**: restart the container for config changes.
- **State cache**: `Map<string, Z2MState>` in bridge.ts, keyed by device topic.
- **Dashboard browser support**: The status page targets modern browsers
  (Chrome/Edge 111+, Safari 18+). Features like the View Transitions API are
  used with graceful fallback.
- **Status page audience**: The `GET /` status page is a developer/operator
  diagnostic tool. It intentionally shows raw Z2M state values, JSON payloads,
  MQTT topics, and internal IDs. Annotations (%, K, color swatches) are hints
  alongside the raw data, not replacements for it.

## Capability Mapping

| Capability   | HomeKit Characteristic            | Conversion                |
| ------------ | --------------------------------- | ------------------------- |
| `on_off`     | `Characteristic.On`               | boolean passthrough       |
| `brightness` | `Characteristic.Brightness`       | Z2M 0–254 ↔ HK 0–100      |
| `color_temp` | `Characteristic.ColorTemperature` | mireds, passthrough       |
| `color_hs`   | `Hue` + `Saturation`              | ranges match, passthrough |

## Naming Conventions

- Prefer writing out "homekit" (e.g. `homeKitToZ2m`, `HomeKitState`,
  `HOMEKIT_CONVERTED_KEYS`) over abbreviating to "hk", except in
  function-local variables where brevity aids readability.

## Type Conventions

- **Exhaustive switches**: When switching on a union type like `Capability` or
  `DeviceType`, rely on TypeScript's type narrowing to catch missing cases at
  compile time — do not add a `default: never` arm. Bun's coverage engine does
  not support ignore comments, so unreachable default branches break the 100%
  line coverage requirement.
- Capability type: `"on_off" | "brightness" | "color_temp" | "color_hs"`
- `PublishFn = (topic: string, payload: Record<string, unknown>) => void`
- `GetStateFn = (topic: string) => Z2MState | undefined`
- `Z2MState = Record<string, unknown>` (Z2M state payloads vary by device)

## Testing Requirements

- 100% line/branch/function coverage
- All HAP objects instantiated directly (no mocking hap-nodejs)
- MQTT client is the only mock: use `bun:test` module mocking for `mqtt`
- Use Bun's fake timers for scene auto-reset tests
- Tests must pass: `bun run lint && bun run check && bun run test`
- **Screenshot golden file**: `demo/status-page.png` is a committed screenshot
  of the status page rendered from `demo/fixture.ts` inside a Docker container
  (`Dockerfile.playwright`) for cross-platform determinism. The test in
  `test/screenshot.test.ts` compares a fresh Playwright screenshot against this
  file with zero pixel tolerance. Both golden generation (`bun run demo:golden-screenshot`)
  and CI testing run inside the same Docker image so fonts and rendering match
  exactly. The `PLAYWRIGHT_IN_DOCKER` env var triggers `--no-sandbox` for
  Chromium inside the container.
- **ciao mDNS patch**: `@homebridge/ciao` has a shutdown race condition where
  mDNS probe/announce timers fire after the server socket is closed, throwing
  `ERR_SERVER_CLOSED` as an uncaught exception. A `bun patch` in
  `patches/@homebridge%2Fciao@1.3.5.patch` fixes this by adding early-return
  guards to send methods. See https://github.com/homebridge/ciao/pull/60

## Docker Images

Pin all Docker base images to `sha256` digests for reproducibility. Keep
the version tag alongside the digest for documentation, e.g.
`FROM image:v1.2.3@sha256:abcd...`. When updating an image, pull it,
grab the digest with `docker inspect`, and replace the hash in the
`FROM` line.

## Copyright Notice

All new files must include the Apache 2.0 copyright header. Use `//` comments
for TypeScript and `#` comments for shell scripts, placed immediately after the
shebang line if present. See existing files for the exact format.

## Development Workflow

Follow red-green-refactor TDD:

1. **Red**: Write a failing test first
2. **Green**: Write the minimum code to make the test pass
3. **Refactor**: Clean up while keeping tests green

All verification is automated — no manual browser testing. Run before each
commit:

```sh
bun run lint && bun run check && bun run test
```

## Config Validation Rules

- `bridge.mac`: MAC format `XX:XX:XX:XX:XX:XX` (hex digits)
- `bridge.pincode`: format `XXX-XX-XXX` (digits)
- `bridge.port`: positive integer
- `bridge.bind`: optional string (network interface name or IP for mDNS)
- `devices`: non-empty array
- Each device: `name`, `topic`, `capabilities` (non-empty, valid values)
- Scene IDs: positive integers
