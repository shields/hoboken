# Hoboken

Minimal HomeKit bridge for Zigbee2MQTT. Exposes Z2M lights and scenes to Apple
Home for HomePod voice commands.

Built with [`@homebridge/hap-nodejs`](https://github.com/homebridge/HAP-NodeJS)
directly — no Homebridge or Matterbridge framework.

## Why

Matterbridge and Homebridge are too complex to troubleshoot. Hoboken does one
thing: bridge Z2M lights to HomeKit.

## Architecture

```
Apple Home ↔ HomeKit (HAP) ↔ Hoboken ↔ MQTT ↔ Zigbee2MQTT ↔ Zigbee devices
```

### Modules

| Module               | Responsibility                        |
| -------------------- | ------------------------------------- |
| `src/config.ts`      | Load and validate YAML config         |
| `src/convert.ts`     | Value conversion (Z2M ↔ HomeKit)      |
| `src/accessories.ts` | Create HAP accessories and scenes     |
| `src/bridge.ts`      | MQTT client, bridge wiring, lifecycle |
| `src/main.ts`        | Entry point                           |

Modules are split for testability. Each has clear inputs/outputs and minimal
coupling. Accessory creation takes injected `publish`/`getState` functions
rather than an MQTT client directly.

### Capabilities

Devices declare capabilities in `config.yaml`:

| Capability   | HomeKit Characteristic | Conversion                   |
| ------------ | ---------------------- | ---------------------------- |
| `on_off`     | `On`                   | boolean, always present      |
| `brightness` | `Brightness`           | Z2M 0–254 ↔ HomeKit 0–100    |
| `color_temp` | `ColorTemperature`     | mireds, no conversion needed |
| `color_hs`   | `Hue` + `Saturation`   | ranges match, no conversion  |

### Scenes

Scenes are exposed as momentary switches. "Hey Siri, turn on Movie Mode"
publishes `{"scene_recall": <id>}` to Z2M. The switch auto-resets to off after
1 second.

### Failure Handling

- **MQTT disconnect**: `onSet` throws `HapStatusError(SERVICE_COMMUNICATION_FAILURE)`
  → HomeKit shows "No Response"
- **MQTT reconnect**: re-subscribes and refreshes state automatically
- **Config changes**: restart the container (no hot reload)

## Config

```yaml
bridge:
  name: "Hoboken"
  username: "0E:42:A1:B2:C3:D4" # Stable MAC — HomeKit pairing identity
  pincode: "031-45-154"
  port: 51826

mqtt:
  url: "mqtt://mosquitto:1883"
  topic_prefix: "zigbee2mqtt"

devices:
  - name: "Living Room Light"
    topic: "living_room_light"
    capabilities: [on_off, brightness, color_temp]
    scenes:
      - name: "Movie Mode"
        id: 1

  - name: "Bedroom Light"
    topic: "bedroom_light"
    capabilities: [on_off, brightness, color_temp, color_hs]
```

Neither `username` nor `pincode` are secrets. The MAC is broadcast via mDNS.
The PIN is only used during initial pairing and is not reusable afterward.

## Development

### Prerequisites

- [Bun](https://bun.sh/) (package manager and test runner)
- Node.js 24+ (runtime, for TypeScript type stripping)

### Setup

```sh
bun install
```

### Commands

```sh
bun run check    # TypeScript type checking
bun run lint     # ESLint (strict + stylistic)
bun test         # Run tests
bun test --coverage  # Tests with coverage report
bun run start    # Run with Node.js
```

## Deployment

### Container

```sh
docker build -t hoboken .
```

Multi-stage build: Bun installs deps, distroless Node.js 24 runs the app.
Image: `gcr.io/distroless/nodejs24-debian13` (no shell, minimal attack surface).

### Kubernetes

Deployed on k3s via [Flux](https://fluxcd.io/). The manifests in `k8s/` are
reconciled automatically.

- `hostNetwork: true` — required for mDNS (HomeKit device discovery)
- `strategy: Recreate` — single instance (MAC uniqueness)
- PVC at `/persist` — pairing data survives restarts
- ConfigMap at `/config/config.yaml`
