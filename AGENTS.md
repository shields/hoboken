# Hoboken Project Instructions

## Project Overview

Minimal HomeKit bridge for Zigbee2MQTT and WLED. Uses `@homebridge/hap-nodejs`
directly (no framework). Connects to MQTT, reads device config from YAML.
Tucson's MQTT profile adds heated mattress pads and heated blankets, referred
to collectively as heated bedding. Use short zone names such as "Bed Side A".

## Toolchain

- **Runtime**: Node.js 26 with unflagged TypeScript type stripping
- **Package manager**: Bun (`bun install`, `bun.lock`)
- **Bun version**: `packageManager` in package.json, which CI installs; both
  Dockerfiles' `oven/bun` tags must match (`test/toolchain.test.ts`)
- **Playwright version**: `playwright` in package.json; the
  `mcr.microsoft.com/playwright` tag in `Dockerfile.playwright` must match
  (`test/toolchain.test.ts`), because the image bundles the browser revision
  that npm release launches. Renovate holds the npm release for 3 days but not
  the image, so the image's PR is red until the npm release joins its branch.
- **Node.js major**: the final stage's `gcr.io/distroless/nodejs<major>` image in
  `Dockerfile`, `node-version` in `.github/workflows/build.yml`, and the
  `@types/node` major in package.json must agree (`test/toolchain.test.ts`).
  `integration/tucson-roundtrip.ts` requires the workflow's major.
- **Test runner**: Bun test (`bun test`, `bun test --coverage`)
- **TypeScript 6.0**: type checking only (`noEmit`), `erasableSyntaxOnly`
- **ESLint 10**: `typescript-eslint` with `strictTypeChecked` + `stylisticTypeChecked`
- **Container**: `gcr.io/distroless/nodejs26-debian13`

## Commands

```sh
make setup                # Frozen dependencies, Renovate's re2, Lefthook pre-commit checks
make fmt                  # ESLint fixes and Prettier for code and non-code files
bun install               # Install dependencies
make lint                 # tsc --noEmit, ESLint, Renovate config validation, Prettier
make test                 # Unit tests with coverage
make test-broker-deps     # System packages for the pinned Mosquitto build
make test-integration     # WLED, heated bedding, authenticated broker, refused subscription, dropped session, and malformed URL round trips (Node.js)
make test-screenshot      # Compare status page against golden file (Docker)
make run                  # Run with Node.js
make demo                 # Serve the status page with sample data
make golden-screenshot    # Regenerate status page golden file (Docker)
```

Follow the [shared TypeScript guide](https://github.com/shields/right-answers/blob/main/typescript.md)
and its configuration baselines. TypeScript remains at 6.0.3 because the current
typescript-eslint 8.71.2 peer range is `>=4.8.4 <6.1.0`, excluding TypeScript
7.0.2. Recheck compatibility before upgrading the compiler. ESLint 10 is supported
by that parser release.

## Module Architecture

Each module is independently testable with dependency injection:

- `src/config.ts` — Config loading/validation, MQTT URL checks, MQTT credential resolution, type definitions
- `src/convert.ts` — Pure value conversion functions (Z2M ↔ HomeKit)
- `src/accessories.ts` — HAP accessory/scene creation, takes `PublishFn`/`GetStateFn`
- `src/bridge.ts` — MQTT client, bridge wiring, state cache, lifecycle
- `src/heated-bedding-profile.ts` — Pure heated bedding payload parsing, topic naming, and fan write coalescing
- `src/heated-bedding-source.ts` — Heated bedding availability, session, and confirmed-write state machine, injected publish/clock
- `src/heated-bedding-mqtt.ts` — Dedicated MQTT 5 connection and reconnect policy for the heated bedding source
- `src/heated-bedding-accessories.ts` — Fan and preheat accessories backed by the heated bedding source
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
- **Invalid heated bedding messages**: An invalid heated bedding MQTT message
  tears down the whole heated bedding connection, which reconnects with backoff,
  instead of invalidating only the affected zone. Partially invalid state isn't
  trusted, so every zone starts over from a clean MQTT session.
- **No config reload**: restart the container for config changes.
- **MQTT credentials**: `Config` holds only `mqtt.username` and the password
  file path. `main.ts` calls `resolveMQTTCredentials(config.mqtt)` and passes
  the resulting `MQTTCredentials` to `startBridge`, which gives them to both
  MQTT clients, so the status page, metrics, and logs cannot reach the
  password. `validateConfig` stays pure and `startBridge` never reads the
  environment, which keeps tests independent of the developer's shell. Both
  clients build their options with `credentialOptions`, which empties mqtt.js's
  `auth` so userinfo in the broker URL cannot replace the configured login.
  `startBridge` rejects, before creating any client or server, credentials
  whose username differs from `config.mqtt.username`, a configured username
  without credentials, credentials without a configured username, and a
  password file without a username, so a library caller cannot connect
  anonymously or under the wrong name. The messages name the fields but never
  echo values.
- **MQTT URL**: a URL that is not well formed cannot be reliably stripped of its
  credentials, so no part of it is printed anywhere. `isMQTTURL` accepts a URL
  only if mqtt.js can connect with it as written. Node's legacy `url.parse`,
  which mqtt.js uses, must find a scheme that mqtt.js builds a stream for
  (`mqtt`, `mqtts`, `tcp`, `ssl`, `tls`, `ws`, `wss`), a host, and a port of 1
  or more, and the WHATWG `URL` parser must find the same host. The second check
  rejects what `url.parse` truncates without complaint, such as a space, `;`, or
  `%` in the host, where mqtt.js would connect to the text before it. A control
  character in the host fails too, because WHATWG percent-encodes one in the
  host of a non-special scheme and strips a leading or trailing one from the
  whole URL, so the comparison cannot see it. `url.parse` must also find no `@`
  in the path or fragment. A `/`, `?`, or `#` in a password ends the authority
  early, and both parsers then agree on a wrong host, the username or the text
  between a later `@` and the delimiter, which mqtt.js would resolve, connect to
  with the partial credentials, and quote in `MQTT error` lines. Such a URL
  cannot be told from a path, query, or fragment that holds an `@`, so both are
  refused; `%40` writes an `@` there. A bare hostname fails because mqtt.js
  throws "Missing protocol". mqtt.js would map an unknown scheme to `mqtt`, so
  the scheme list is stricter than mqtt.js. A `ws` or `wss` URL with an IPv6
  address fails too, because mqtt.js writes its host without brackets and
  `new WebSocket` rejects the result. `validateConfig`, `startBridge`, and the
  `HeatedBeddingMQTT` constructor call `assertMQTTURL`, which throws "mqtt.url
  is not a valid MQTT URL". The log line and status page use `displayMQTTURL`,
  which shows only the scheme, host, and port, or "(not shown)" for a URL that
  does not pass; `startBridge` has already refused such a URL, so that is a
  second layer. It never shows the path, query, or fragment, which can carry a
  token. `loadConfig` stops on a YAML error or warning, such as an unresolved
  tag, and reports it by code, line, and column only, because the parser's
  messages quote the offending line. It parses with `stringKeys`, so a key that
  is a list or a mapping is a parse error rather than a process warning and an
  unknown-field message that quote it, and it replaces the error that converting
  the document throws for an alias with no anchor, which names the alias, with
  one that has no `cause`, because Node prints the cause of an uncaught error.
  Both clients create and connect through `withoutErrorMessage`, which replaces
  any error that mqtt.js or Node throws synchronously, because Node quotes the
  URL in them, with "MQTT client could not be started" and keeps only a string
  `code`. `isMQTTURL` runs the legacy parser with `process.noDeprecation` set
  and then puts back the value that it found, except that Node has already set
  it, read-only, under `--no-deprecation`. Node 22 and 24 emit DEP0170 with the
  whole URL for a port that `url.parse` finds invalid but `new URL` accepts, as
  in `mqtt:user:pw@host:1x`; Node 26 throws an error that quotes the URL
  instead. Node 24 and 26 emit DEP0169, which does not quote the URL, for any
  `url.parse` call outside `node_modules`. A process emits each warning once, so
  `test/mqtt-url-report.ts` checks the shared lists in `test/mqtt-urls.ts` in a
  fresh process, which `config.test.ts` starts under Bun and
  `integration/mqtt-url-rejection.ts` starts under Node. It also creates and
  connects an mqtt.js client for every valid URL with `net.createConnection`,
  `tls.connect`, and the `createWebsocket` option stubbed, so that the stream
  builders run and no socket opens; `manualConnect` alone never runs them. Every
  malformed URL in those lists that has a place for credentials carries a
  secret there, so any output that quotes part of one fails.
- **Main MQTT reconnect backoff**: the main client sets
  `reconnectOnConnackError` in every configuration, because mqtt.js otherwise
  never retries after a refused login, and starts `reconnectPeriod` at the
  Tucson MQTT client's `MIN_BACKOFF`. Each `reconnect` event, which mqtt.js
  emits once per attempt however that attempt fails, doubles
  `client.options.reconnectPeriod` up to `MAX_BACKOFF`. The doubled period is
  the wait after that attempt fails. Counting `reconnect` rather than `error`,
  `close`, or `offline` counts a failed attempt once. `connect` starts a timer,
  like the heated bedding client's stable-connection timer, that resets the
  period to `MIN_BACKOFF` once the connection has stayed up for `MAX_BACKOFF`;
  `close` and shutdown clear it. A broker that accepts the login and then drops
  the session, such as VerneMQ or EMQX with `deny_action=disconnect` after a
  denied publish, keeps the period, so each drop is followed by a longer wait
  and the bridge does not request every device's state once a second.
- **Main MQTT subscription results**: the main client's connect handler passes
  `subscribe` a callback, and the client sets `resubscribe: false`. With
  mqtt.js's own resubscribe on, it re-sends the earlier subscriptions before the
  handler runs and without a callback, so the handler's call has nothing left to
  send and a refusal after a reconnect goes unreported. mqtt.js reports a SUBACK
  failure code (bit 0x80) as an error whose `packet.granted` holds one code per
  requested topic, while the grants argument still carries the requested QoS; a
  grant of 128 without an error counts as a refusal too. Codes name topics only
  when their count matches the request. A refusal logs the refused topics and
  any other failure logs every requested topic, each as one `log.error` line and
  one `mqttErrors` count per `subscribe` call. The connection stays up.
- **State cache**: `Map<string, Z2MState>` in bridge.ts, keyed by device topic.
- **Dashboard browser support**: The status page targets modern browsers
  (Chrome/Edge 111+, Safari 18+). Features like the View Transitions API are
  used with graceful fallback.
- **Status page audience**: The `GET /` status page is a developer/operator
  diagnostic tool. It intentionally shows raw Z2M state values, JSON payloads,
  MQTT topics, and internal IDs. Annotations (%, K, color swatches) are hints
  alongside the raw data, not replacements for it.

## Capability Mapping

| Capability   | HomeKit Characteristic             | Conversion                |
| ------------ | ---------------------------------- | ------------------------- |
| `on_off`     | `Characteristic.On`                | boolean passthrough       |
| `brightness` | `Characteristic.Brightness`        | Z2M 0–254 ↔ HK 0–100      |
| `color_temp` | `Characteristic.ColorTemperature`  | mireds, passthrough       |
| `color_hs`   | `Hue` + `Saturation`               | ranges match, passthrough |
| `fan`        | `Active` (FanV2 service)           | `fan_state` ON/OFF ↔ 1/0  |
| `fan_speed`  | `RotationSpeed` + `TargetFanState` | speed thirds, smart=AUTO  |

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
- Capability type: `"on_off" | "brightness" | "color_temp" | "color_hs" | "fan" | "fan_speed"`
- `PublishFn = (topic: string, payload: Record<string, unknown>) => void`
- `GetStateFn = (topic: string) => Z2MState | undefined`
- `Z2MState = Record<string, unknown>` (Z2M state payloads vary by device)

## Testing Requirements

- 100% line/branch/function coverage
- All HAP objects instantiated directly (no mocking hap-nodejs)
- MQTT client is the only mock: use `bun:test` module mocking for `mqtt`
- Use Bun's fake timers for scene auto-reset tests
- **Timing**: never load the machine to provoke a race (CPU burners such as
  `yes > /dev/null`, stress tools, floods of parallel runs). Make the ordering
  deterministic instead: fake timers or an injected clock in unit tests; in
  integration tests, have the simulated device or controller delay, drop, or
  reorder the specific message (the heated bedding controller's `mode` drops or
  rejects writes this way), and poll for the outcome with a deadline.
- **Processes**: stop every process a test or probe starts before the command
  returns.
- Tests must pass: `make lint test`
- **Screenshot golden file**: `demo/status-page.png` is a committed screenshot
  of the status page rendered from `demo/fixture.ts` inside a Docker container
  (`Dockerfile.playwright`) for cross-platform determinism. The test in
  `test/screenshot.test.ts` compares a fresh Playwright screenshot against this
  file with zero pixel tolerance. Both golden generation (`make golden-screenshot`)
  and CI testing run inside the same Docker image so fonts and rendering match
  exactly. The `PLAYWRIGHT_IN_DOCKER` env var triggers `--no-sandbox` for
  Chromium inside the container. `make test-screenshot` runs the full Bun suite
  in that image so the shared coverage thresholds cover the application.

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
make lint test
```

## Config Validation Rules

- `bridge.mac`: MAC format `XX:XX:XX:XX:XX:XX` (hex digits)
- `bridge.pincode`: format `XXX-XX-XXX` (digits)
- `bridge.port`: positive integer
- `bridge.bind`: optional string (network interface name or IP for mDNS)
- `mqtt.url`: non-empty string that passes `isMQTTURL`, checked before
  `mqtt.username`; the error never quotes the URL
- `mqtt.username`: optional non-empty string of at most 65535 bytes; cannot
  accompany userinfo in `mqtt.url`
- `mqtt.passwordFile`: optional non-empty path; `mqtt.password` is rejected so
  the password never lives in config.yaml
- Unknown keys: every object the validator accepts rejects keys outside its
  allowlist through one helper, `rejectUnknownFields`. The objects are the top
  level (`bridge`, `mqtt`, `devices`, `heatedBedding`, `curtains`, `metrics`),
  `bridge`, `mqtt`, `metrics`, each `devices` entry (`name`, `type`, `topic`,
  `capabilities`, `scenes`), each `scenes` entry (`name`, `id`), and each
  `heatedBedding` and `curtains` entry. The message gives the section path and the
  JSON-escaped key, never a value, so a misspelled `mqtt.username` cannot
  connect anonymously and a misspelled `metrics.bind` cannot leave the status
  page on every interface. The check runs first in each section, so a
  misspelled required field is named rather than reported missing, except that
  `mqtt.password` is checked before it and keeps its own message. A new config
  key must join its section's allowlist, a `Record` over the interface's keys
  that the compiler requires to be complete.
- MQTT password: only from `mqtt.passwordFile` (strictly decoded UTF-8; a
  leading byte order mark and one trailing line ending, LF or CRLF, removed, so
  a lone trailing CR stays); the environment is never consulted, so a stray
  `MQTT_PASSWORD` is ignored. A username needs a password file, a password file
  needs a username, and an unreadable, invalid UTF-8, empty, or oversized (over
  65535 bytes) password fails startup. Messages never contain the password.
- `devices`: non-empty array unless `heatedBedding` configures at least one zone;
  a configuration with only heated bedding can omit `devices` or use an empty array
- Each device: `name`, `topic`, `capabilities` (non-empty, valid values)
- Scene IDs: positive integers
- `heatedBedding`: optional array of `name`, `prefix`, `controller`, and `zone`
- Heated bedding topics use Tucson's lowercase controller/zone identifiers and prefix
  grammar; `bridge` controllers and `availability` zones are reserved
- Controller/zone pairs are unique across prefixes because they determine HAP
  accessory identities
- Heated bedding routes cannot overlap device routes; wildcard device topics cannot
  accompany heated bedding
- Heated bedding entries contain only logical MQTT names

## Tucson curtains

- `curtains` entries use `name`, `prefix`, `controller`, and `zone`, like
  `heatedBedding`. A curtain-only configuration may omit `devices`.
- `tucson-source.ts`, `tucson-mqtt.ts`, and `tucson-profile.ts` own the shared
  MQTT session, request/result, and wire-validation behavior. Bedding and
  curtain modules supply state parsing and accessory behavior.
- Curtains expose only target position writes. Do not add start/stop commands
  or `HoldPosition` without a separate request.
- Report current position from the device. Infer movement from reported
  current/target positions only when motion telemetry is absent.
- Production Zemismart mapping is pending hardware qualification in Tucson;
  its synthetic curtain profile is test-only.
