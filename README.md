# Hoboken

Minimal HomeKit bridge for Zigbee2MQTT. Exposes Z2M lights and scenes to Apple
Home for HomePod voice commands.

Built with [`@homebridge/hap-nodejs`](https://github.com/homebridge/HAP-NodeJS)
directly — no Homebridge or Matterbridge framework.

It's called "Hoboken" because that has some of the same letters as
"HomeKit Bridge".

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
  mac: "AA:BB:CC:DD:EE:FF" # generate a unique MAC for your bridge
  pincode: "123-45-678" # change this before pairing
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

### MAC and PIN Generation

The bridge MAC must be a locally-administered unicast address (bit 1 of the
first octet set, bit 0 clear). The PIN is 8 random digits formatted as
`XXX-XX-XXX` and must not be a HAP-excluded value (e.g., `000-00-000`,
`111-11-111`, `123-45-678`).

Generate both with:

```sh
python3 -c "import random; b=random.randbytes(6); print(f'MAC: {b[0]|2&~1:02X}:{b[1]:02X}:{b[2]:02X}:{b[3]:02X}:{b[4]:02X}:{b[5]:02X}'); d=[random.randint(0,9) for _ in range(8)]; print(f'PIN: {d[0]}{d[1]}{d[2]}-{d[3]}{d[4]}-{d[5]}{d[6]}{d[7]}')"
```

### Z2M Groups as Devices

Hoboken can target Z2M groups by using the group's friendly name as the device
topic. Commands are broadcast to all group members at the Zigbee level. Devices
that don't support a given cluster silently ignore it, so capabilities should
match the most capable member. This is preferable to homebridge-z2m's approach
of intersecting capabilities.

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
