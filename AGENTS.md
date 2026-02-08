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
bun install          # Install dependencies
bun run check        # TypeScript type checking (tsc --noEmit)
bun run lint         # ESLint
bun test             # Run tests
bun test --coverage  # Tests with coverage
bun run start        # Run with Node.js
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

## Capability Mapping

| Capability   | HomeKit Characteristic            | Conversion                |
| ------------ | --------------------------------- | ------------------------- |
| `on_off`     | `Characteristic.On`               | boolean passthrough       |
| `brightness` | `Characteristic.Brightness`       | Z2M 0–254 ↔ HK 0–100      |
| `color_temp` | `Characteristic.ColorTemperature` | mireds, passthrough       |
| `color_hs`   | `Hue` + `Saturation`              | ranges match, passthrough |

## Type Conventions

- Capability type: `"on_off" | "brightness" | "color_temp" | "color_hs"`
- `PublishFn = (topic: string, payload: Record<string, unknown>) => void`
- `GetStateFn = (topic: string) => Z2MState | undefined`
- `Z2MState = Record<string, unknown>` (Z2M state payloads vary by device)

## Testing Requirements

- 100% line/branch/function coverage
- All HAP objects instantiated directly (no mocking hap-nodejs)
- MQTT client is the only mock: use `bun:test` module mocking for `mqtt`
- Use Bun's fake timers for scene auto-reset tests
- Tests must pass: `bun run lint && bun run check && bun test --coverage`

## Config Validation Rules

- `bridge.username`: MAC format `XX:XX:XX:XX:XX:XX` (hex digits)
- `bridge.pincode`: format `XXX-XX-XXX` (digits)
- `bridge.port`: positive integer
- `devices`: non-empty array
- Each device: `name`, `topic`, `capabilities` (non-empty, valid values)
- Scene IDs: positive integers
