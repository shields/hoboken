# Hoboken

A minimal HomeKit bridge for Zigbee2MQTT and WLED. Exposes Z2M lights, ceiling
fans, smart plugs, scenes, and WLED LED controllers to Apple Home for HomePod
and Siri voice commands.

Tucson's MQTT profile adds support for heated mattress pads and heated blankets
(heated bedding). Each configured zone appears as a ten-level fan and a
separate stateful preheat switch, with short display names such as "Bed Side A"
and "Bed Side A Preheat".

It also provides an HTTP endpoint with a live-updating dashboard presenting all
data in both MQTT and HAP forms, as well as Prometheus metrics and health check
endpoints.

![Status page](demo/status-page.png)

Note that Hoboken is a HAP bridge, not a client. It provides bidirectional
control of MQTT devices and scenes to HomeKit. It does not provide control of
HomeKit-only devices (e.g., Ecobee thermostats) from MQTT. That would be a
different project.

## Why

Matterbridge and Homebridge are too complex and hard to troubleshoot. Hoboken does one
thing: bridge MQTT devices to HomeKit. It's built directly on
[`hap-nodejs`](https://github.com/homebridge/HAP-NodeJS).

It does not have any device discovery, self-update, or plugins. You get exactly what
you configure, and you will always get that.

All dependencies are pure JS/TS code. Test coverage is enforced at 100%
line, function, and statement coverage.

The deployment is a reproducible, distroless container image. You can
run it on K3s or whatever.

It's called "Hoboken" because that has some of the same letters as
"HomeKit Bridge".

### Modules

| Module               | Responsibility                                          |
| -------------------- | ------------------------------------------------------- |
| `src/config.ts`      | Load and validate YAML config; resolve MQTT credentials |
| `src/convert.ts`     | Value conversion (Z2M/WLED ↔ HomeKit)                   |
| `src/accessories.ts` | Create HAP accessories and scenes                       |
| `src/bridge.ts`      | MQTT client, bridge wiring, lifecycle                   |
| `src/metrics.ts`     | Prometheus metrics and HTTP server                      |
| `src/main.ts`        | Entry point                                             |

Modules are split for testability. Each has clear inputs/outputs and minimal
coupling. Accessory creation takes injected `publish`/`getState` functions
rather than an MQTT client directly.

### Device Types

Each device has a `type` field (defaults to `"z2m"`) that selects the MQTT
protocol:

| Type   | Protocol              | MQTT Format                   |
| ------ | --------------------- | ----------------------------- |
| `z2m`  | Zigbee2MQTT (default) | JSON on `<topic>`             |
| `wled` | WLED MQTT API         | Sub-topics `/g`, `/c`, `/api` |

### Capabilities

Devices declare capabilities in `config.yaml`:

| Capability   | HomeKit Characteristic             | Z2M Conversion               | WLED Conversion            |
| ------------ | ---------------------------------- | ---------------------------- | -------------------------- |
| `on_off`     | `On`                               | boolean, always present      | boolean                    |
| `brightness` | `Brightness`                       | Z2M 0–254 ↔ HomeKit 0–100    | WLED 0–255 ↔ HomeKit 0–100 |
| `color_temp` | `ColorTemperature`                 | mireds, no conversion needed | not supported              |
| `color_hs`   | `Hue` + `Saturation`               | ranges match, no conversion  | HSV ↔ RGB conversion       |
| `fan`        | `Active` (FanV2)                   | `fan_state` ON/OFF ↔ 1/0     | not supported              |
| `fan_speed`  | `RotationSpeed` + `TargetFanState` | `fan_mode` ↔ speed thirds    | not supported              |

### Scenes

Scenes are exposed as momentary switches. "Hey Siri, turn on Movie Mode"
publishes `{"scene_recall": <id>}` to Z2M. The switch auto-resets to off after
1 second.

### Heated Bedding Zones

Configure heated mattress pad or heated blanket zones separately from `devices`:

```yaml
heatedBedding:
  - name: "Bed Side A"
    prefix: "tuya"
    controller: "bed"
    zone: "side_a"
  - name: "Bed Side B"
    prefix: "tuya"
    controller: "bed"
    zone: "side_b"
```

Match these logical names to Tucson's configuration. A bridge with only heated bedding
can omit `devices` or set it to `[]`. Controller/zone pairs must be unique
even across prefixes, because they determine accessory identities. Display
names and prefixes can change without changing those identities. Heated bedding
configuration contains only these four fields, and any other field fails
startup; Tucson owns controller credentials, protocol versions, and device
connections.

The fan's Active control changes power. RotationSpeed zero turns power off
and preserves the selected level; positive values select levels 1–10 in
10% steps. The reported speed retains that selected level while power is
off. An explicit off takes precedence over other fan writes arriving in
the same 50 ms window. Preheat follows its reported Boolean until the
controller changes it.

Writes wait for a confirmed command result and reported state that matches
it. Once a newer write to the same zone has been sent, the confirmed result
alone suffices, and the write returns the current reported state. Failed or
expired writes return a HomeKit error and retain reported
values. MQTT reconnection cancels pending writes and requires current
subscriptions, a fresh session heartbeat, online availability, and known
state. Commands are never replayed after reconnection. Existing Zigbee2MQTT
and WLED devices use their existing MQTT connection and conversion rules.

Physical side mapping and controller compatibility still require hardware
qualification. Actual Home app and Siri testing remains part of that
qualification.

### Failure Handling

- **MQTT disconnect**: `onSet` throws `HapStatusError(SERVICE_COMMUNICATION_FAILURE)`
  → HomeKit shows "No Response"
- **Unknown device state**: `onGet` throws `HapStatusError(SERVICE_COMMUNICATION_FAILURE)`
  when no cached state exists → HomeKit shows "Not Responding" until real state
  arrives. Z2M devices recover quickly because the bridge requests state via
  `{topic}/get` on connect. WLED devices require **Retain** enabled in WLED's
  MQTT settings (`Settings → Sync Interfaces → MQTT → Send on change → Retain`)
  so the broker delivers the last `/g` and `/c` values when the bridge subscribes.
  Without retain, the bridge has no way to learn the device's current state at
  startup.
- **MQTT reconnect**: re-subscribes and refreshes state automatically. The
  Zigbee2MQTT and WLED connection waits 1 second before its first retry and
  doubles the wait with each further attempt up to 60 seconds. The wait returns
  to 1 second only after a connection has stayed up for 60 seconds, so a broker
  that accepts the login and then drops the session, such as one that
  disconnects a client after a denied publish, is retried at the growing
  interval rather than every second.
- **MQTT URL and credentials**: a malformed `mqtt.url` and credential
  misconfiguration exit at startup (see [MQTT URL](#mqtt-url) and
  [MQTT authentication](#mqtt-authentication)). A broker that refuses the
  connection, with or without `mqtt.username`, is reported as
  `MQTT error: Connection refused: ...` and retried with that backoff (see
  [MQTT authentication](#mqtt-authentication)).
- **MQTT subscriptions**: a broker that refuses a Zigbee2MQTT or WLED
  subscription is reported as `MQTT subscription refused for ...` and counted;
  the connection stays up and the refused devices report no state (see
  [MQTT authentication](#mqtt-authentication)).
- **Config changes**: restart the container (no hot reload)

### Metrics

Opt-in Prometheus metrics via `prom-client`. Add a `metrics` section to
`config.yaml` with a `port` to enable.

| Metric                                  | Type    | Labels   |
| --------------------------------------- | ------- | -------- |
| `hoboken_mqtt_connected`                | Gauge   |          |
| `hoboken_mqtt_messages_received_total`  | Counter | `device` |
| `hoboken_mqtt_messages_published_total` | Counter |          |
| `hoboken_mqtt_errors_total`             | Counter |          |
| `hoboken_devices_configured`            | Gauge   |          |

Default Node.js process metrics (CPU, memory, event loop lag) are also included.
The `k8s/deployment.yaml` includes Prometheus scrape annotations.

#### Status Page

When metrics are enabled, `GET /` serves an HTML status page showing:

- Bridge name and version
- MQTT connection status and active HAP connection count
- Each device with its topic, capabilities, scenes, and current state

This is useful for quick diagnostics without checking logs or Prometheus.
The page loads new data in real time using SSE.

To preview the status page with sample data:

```sh
make demo
```

## Config

```yaml
bridge:
  name: "Hoboken"
  mac: "AA:BB:CC:DD:EE:FF" # generate a unique MAC for your bridge
  pincode: "123-45-678" # change this before pairing
  port: 51826
  bind: "eno1" # optional: network interface for mDNS (needed in k8s with hostNetwork)

mqtt:
  url: "mqtt://mosquitto:1883"
  # username: "hoboken" # optional: broker login; needs passwordFile
  # passwordFile: "/run/secrets/mqtt_password" # needs username

# metrics:
#   port: 9090
#   bind: "127.0.0.1" # optional: defaults to 0.0.0.0

devices:
  - name: "Living Room Light"
    topic: "zigbee2mqtt/living_room_light"
    capabilities: [on_off, brightness, color_temp]
    scenes:
      - name: "Movie Mode"
        id: 1

  - name: "Bedroom Light"
    topic: "zigbee2mqtt/bedroom_light"
    capabilities: [on_off, brightness, color_hs]

  - name: "Ceiling Fan"
    topic: "zigbee2mqtt/ceiling_fan"
    capabilities: [fan, fan_speed]

  - name: "LED Strip"
    type: wled
    topic: "wled/living-room"
    capabilities: [on_off, brightness, color_hs]
```

Neither `mac` nor `pincode` are secrets. The MAC is broadcast via mDNS.
The PIN is only used during initial pairing and is not reusable afterward.

### Supported keys

Hoboken refuses to start when any object in `config.yaml` has a key that is not
listed here, so a misspelled key cannot silently fall back to its default. A
misspelled `metrics.bind`, for example, would otherwise leave the status page
on every interface. The error gives the section and the key, such as
`metrics: unknown field "bnd"; supported fields are port and bind`, but never
the value.

| Object                     | Keys                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| top level                  | `bridge`, `mqtt`, `devices`, `heatedBedding`, `curtains`, `metrics` |
| `bridge`                   | `name`, `mac`, `pincode`, `port`, `bind`                            |
| `mqtt`                     | `url`, `username`, `passwordFile`                                   |
| `metrics`                  | `port`, `bind`                                                      |
| each `devices` entry       | `name`, `type`, `topic`, `capabilities`, `scenes`                   |
| each `scenes` entry        | `name`, `id`                                                        |
| each `heatedBedding` entry | `name`, `prefix`, `controller`, `zone`                              |
| each `curtains` entry      | `name`, `prefix`, `controller`, `zone`                              |

### Bind Interface

The optional `bind` field restricts the HAP server and mDNS advertisement to a
specific network interface. Without it, hap-nodejs advertises on all interfaces,
which in Kubernetes with `hostNetwork: true` can cause mDNS to advertise a
cluster-internal IP (e.g., `cni0`) instead of the LAN IP. Set `bind` to the
host's LAN interface name (e.g., `eno1`) so HomeKit clients can reach the bridge.

### MQTT URL

`mqtt.url` names the broker as `scheme://host[:port]`, such as
`mqtt://mosquitto:1883` or `mqtts://broker.example.com:8883`. The scheme is
`mqtt`, `mqtts`, `tcp`, `ssl`, `tls`, `ws`, or `wss`, the host is required, and
a port, if present, is 1 to 65535. A bare hostname does not work, because
mqtt.js requires a scheme, and neither does `host:port`, because mqtt.js reads
the host as the scheme. Write a non-ASCII hostname in punycode. A `ws` or `wss`
URL needs a hostname rather than an IPv6 address, because mqtt.js writes the
address without its brackets and cannot connect.

Hoboken refuses to start with `mqtt.url is not a valid MQTT URL` when the URL
breaks these rules. The URL can carry credentials, and a URL that is not well
formed cannot be reliably stripped of them, so no part of it appears in that
error, the logs, the status page, the metrics, or a process warning. Hoboken
parses the URL as mqtt.js does, with Node.js's legacy `url.parse`, and again
with the WHATWG `URL` parser, and requires both to find the same host. That
rejects what `url.parse` alone accepts, such as a port above 65535 or a stray
character in the host, where `url.parse` drops the rest of the host and mqtt.js
connects to what remains. If mqtt.js
still fails synchronously while it creates a client, Hoboken reports only
`MQTT client could not be started` and the error code, because Node.js quotes the
URL in those errors.

### MQTT authentication

Brokers that require a login take an optional `mqtt.username` and an
`mqtt.passwordFile` that names a file containing the password. Hoboken reads the
file once at startup as UTF-8, removes a leading byte order mark, and removes one
trailing line ending, either a line feed or a carriage return and line feed, so a
file made with `echo`, `kubectl create secret --from-file`, or a Windows editor
works as written. A lone trailing carriage return stays part of the password.
The file must be valid UTF-8; invalid bytes, including a UTF-16 file with a byte
order mark, fail startup instead of becoming a different password. Hoboken takes
the password from no other source and ignores any `MQTT_PASSWORD` environment
variable. The connection for Zigbee2MQTT and WLED devices and the heated bedding
connection use the same credentials.

Hoboken refuses to start when `mqtt.username` has no `mqtt.passwordFile`, when
`mqtt.passwordFile` has no `mqtt.username`, when the password file cannot be
read, is not valid UTF-8, or is empty (a file holding only a line ending, with or
without a byte order mark, is empty), when `mqtt.username` or
`mqtt.passwordFile` is not a non-empty string, when the username or password is
longer than 65535 bytes, when `mqtt.username` is combined with credentials in
`mqtt.url`, when `config.yaml` contains `mqtt.password`, or when `mqtt` has any
key other than `url`, `username`, and `passwordFile`, such as a misspelled `user`
or `passwd`. The error names the key but not its value. Keep the password out of
`config.yaml`, which is typically a ConfigMap.

Credentials embedded in `mqtt.url` as `scheme://user:password@host` keep working
when `mqtt.username` and `mqtt.passwordFile` are both unset. Percent-encode any
`/`, `?`, or `#` in them. The logs and the status page show only the
scheme, host, and port of `mqtt.url`, never its credentials, path, or query. A
YAML error or warning in `config.yaml`, such as a syntax error or an unresolved
tag, stops startup and is reported by its code, line, and column without the
text of the line, which can hold such credentials. The configured password never
appears in logs, the status page, metrics, or error messages. Rotating it takes
a restart.
Use `mqtts://` unless the broker is on a trusted network, because `mqtt://`
sends the password unencrypted. `mqtt.passwordFile` can name any file that the
container can read, so treat `config.yaml` as being as trusted as the container.
Do not set `DEBUG` to a pattern that matches `mqttjs:client` or
`mqtt-packet:writeToStream`, such as `DEBUG=*`, `DEBUG=mqtt*`, or
`DEBUG=mqttjs*`, which makes the MQTT library print the password.

When the broker refuses the connection, with or without `mqtt.username`, the
Zigbee2MQTT and WLED connection logs `MQTT error: Connection refused: ...`,
counts it in `hoboken_mqtt_errors_total`, and keeps retrying. It waits 1 second
before the first retry and doubles the wait with each further attempt up to 60
seconds. The wait returns to 1 second only after a connection has stayed up for
60 seconds. The heated bedding connection logs an `mqtt_connection_error` event
with the reason code, counts it in the same metric, and retries with backoff
over the same 1 to 60 second range. Correcting the broker therefore takes
effect without a restart.

Brokers that restrict topics per user must grant Hoboken these topics:

- Zigbee2MQTT devices: read `<topic>`; write `<topic>/set` and `<topic>/get`.
- WLED devices: read `<topic>/g` and `<topic>/c`; write `<topic>/api`.
- Heated bedding: read `<prefix>/bridge/availability`,
  `<prefix>/bridge/heartbeat`, `<prefix>/<controller>/availability`, and each
  zone's `<prefix>/<controller>/<zone>` and `<prefix>/<controller>/<zone>/result`;
  write each zone's `<prefix>/<controller>/<zone>/set`.

With an `acl_file`, Mosquitto accepts a subscription to a topic that the user
cannot read and then delivers nothing, so a missing read permission shows up as
a device that never reports state. It also drops a QoS 0 publish that the user
cannot write without telling the sender, so a missing write permission shows up
as a Zigbee2MQTT or WLED command that HomeKit reports as done while nothing
happens.

A broker that enforces read permissions when a client subscribes, such as EMQX,
HiveMQ, or Mosquitto with its dynamic security plugin, refuses the subscription
instead. The Zigbee2MQTT and WLED connection then logs
`MQTT subscription refused for <topics>: ...`, naming only the topics the broker
refused, counts one error in `hoboken_mqtt_errors_total` for the subscription,
and keeps the connection open, so the topics the broker granted keep working
while the refused devices report no state. Every reconnect subscribes again and
reports a refusal again. The line says `failed` instead of `refused` and names
every topic when the subscription ended without a usable answer from the broker,
such as a connection that closed first. The heated bedding connection treats a
refused subscription as a failed connection: it logs `mqtt_subscription_failed`,
counts it in the same metric, and reconnects with backoff.

### MAC and PIN Generation

The bridge MAC must be a locally-administered unicast address (bit 1 of the
first octet set, bit 0 clear). The PIN is 8 random digits formatted as
`XXX-XX-XXX` and must not be a HAP-excluded value (`000-00-000`,
`111-11-111` … `999-99-999`, `123-45-678`, `876-54-321`).

Generate both with (the PIN is redrawn until it is not an excluded value):

```sh
python3 -c "import random; b=random.randbytes(6); excluded={d*8 for d in '0123456789'}|{'12345678','87654321'}; p=next(s for s in iter(lambda: ''.join(random.choices('0123456789',k=8)), None) if s not in excluded); print(f'MAC: {(b[0]|2)&~1:02X}:{b[1]:02X}:{b[2]:02X}:{b[3]:02X}:{b[4]:02X}:{b[5]:02X}'); print(f'PIN: {p[0:3]}-{p[3:5]}-{p[5:8]}')"
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
- Node.js 26+ (runtime, for TypeScript type stripping)
- Make (task runner)
- A C compiler, CMake, OpenSSL headers, and cJSON headers for integration tests
- A C++ toolchain and Python, only where re2 (Renovate's regex engine, used by
  `make lint`) has no prebuilt binary for the platform and Node.js version

### Setup

```sh
make setup
```

Run it under the Node.js that `make lint` will use, because it installs re2 for
that Node.js version.

### Commands

```sh
make lint    # Type checking, ESLint, Renovate config validation, Prettier
make test    # Run tests with coverage
make run     # Run with Node.js
```

On Debian or Ubuntu, install the broker build packages with
`make test-broker-deps`. Then run `make test-integration` on Node.js 26.
The target builds the pinned Mosquitto release and runs the existing WLED
tests, heated bedding tests over paired HAP HTTP and MQTT 5 connections, an
authenticated broker round trip, a round trip with a broker that refuses
subscriptions, a round trip with a broker that drops every session, and a round
trip with a malformed `mqtt.url`.
Use `NODE=/path/to/node make test-integration` to select the runtime.

Heated bedding integration covers reported state on both zones, fan-write
ordering, stateful preheat, rejected and retained results, session changes,
the full HAP write deadline, and broker restart without command replay.
The simulated MQTT controller exercises the contract; actual Sunbeam, Home
app, and Siri qualification still requires hardware.

The authenticated round trip runs a broker that refuses anonymous clients and
restricts each user's topics. It shows that both MQTT connections log in with a
password read from a file, that Zigbee2MQTT and heated bedding writes and state
get through the topic permissions, that the status page and metrics never carry
the password, that `main.ts` exits without a password file and never takes the
password from `MQTT_PASSWORD`, and that a login the broker first refuses, with
credentials or without, is retried until the broker accepts it.

The refused-subscription round trip runs an in-process broker that refuses
chosen topics. It shows that the bridge names only the refused topic, counts
the refusal once, stays connected, keeps delivering the topic the broker
granted, says nothing when a reconnect is granted, and reports a refusal that
begins at a later reconnect.

The dropped-session round trip runs an in-process broker that accepts every
login and closes each session as soon as the bridge subscribes. It shows that
the Zigbee2MQTT and WLED connection waits at least 1, 2, and 4 seconds before
its next three attempts rather than retrying every second.

The malformed-URL round trip starts `main.ts` with `mqtt.url` values that carry
a password and are not well formed, such as a port that is not a number, a space
in the host, a missing host, and a bare hostname. It shows that startup exits
with `mqtt.url is not a valid MQTT URL` and that no output, including a Node.js
deprecation warning, contains any part of the URL. It also shows that `startBridge`
refuses the same URLs without a log line or a warning, and that a fresh Node.js
process accepts every supported form and raises no warning, also when Node.js
starts with `--no-deprecation`.

To qualify the complete controller path, run Tucson's `make homekit` target
with `HOBOKEN_SOURCE` set to this checkout and `NODE` set to Node.js 26.
The `integration/tucson-roundtrip.ts` driver pairs through HAP HTTP and
checks writes, controller-originated updates, and Tucson shutdown. Both
repositories require their frozen dependencies; missing prerequisites fail
qualification.

## Deployment

### Container

```sh
docker build -t hoboken .
```

Multi-stage build: Bun installs deps, distroless Node.js 26 runs the app.
Image: `gcr.io/distroless/nodejs26-debian13` (no shell, minimal attack surface).

### Kubernetes

Deployed on k3s via [Flux](https://fluxcd.io/). The manifests in `k8s/` are
reconciled automatically.

- `hostNetwork: true` — required for mDNS (HomeKit device discovery)
- `strategy: Recreate` — single instance (MAC uniqueness)
- PVC at `/persist` — pairing data survives restarts
- ConfigMap at `/config/config.yaml`
- Optional Secret for the MQTT password: mount it read-only and name its file
  in `mqtt.passwordFile`

### Pairing with Apple Home

1. Open the **Home** app on your iPhone or iPad.
2. Tap **+** (top right) → **Add Accessory**.
3. Tap **More options…** at the bottom. "Hoboken" should appear via mDNS.
4. Select it, then enter the PIN from your config (e.g., `482-37-159`).
5. Assign the bridge to a room when prompted.

The PIN is only used during the initial pairing. After that, the pairing keys
stored in `/persist` authenticate all communication. If you delete the PVC or
change the MAC, you must remove the bridge from Home and re-pair.

### Troubleshooting

Verify mDNS advertisement from a Mac on the same network:

```sh
dns-sd -B _hap._tcp
```

Check that the HAP port is reachable from the network:

```sh
nc -z <node-ip> 51826
```

View logs for pairing diagnostics:

```sh
kubectl -n hoboken logs deploy/hoboken
```

The bridge logs lifecycle events: MQTT connection state, HAP server listening
address, mDNS advertisement, identify requests, pair-setup completion, and
connection close events.

### Tucson curtains

The optional `curtains` configuration presents Tucson endpoints as HomeKit
window coverings:

```yaml
curtains:
  - name: Living Room Curtain
    prefix: tuya
    controller: living_room
    zone: curtain
```

A curtain-only bridge may omit `devices` or set it to `[]`. Each entry uses the
same logical topic naming rules as `heatedBedding`; routes must not overlap.
No Tuya credentials belong in Hoboken.

Set `TargetPosition` from zero (closed) to 100 (open). `CurrentPosition` comes
from device reports. `PositionState` uses reported motion when available and
otherwise compares reported current and target positions. This inference
cannot detect a motor stalled away from its target. Start/stop controls and
HomeKit `HoldPosition` are not exposed.

Target writes complete after Tucson confirms device acceptance, before the
curtain necessarily finishes moving. Missing positions, stale sessions, or
unavailable controllers produce “No Response.” The status page displays
reported state and pending callers.

This is infrastructure for future Zemismart Wi-Fi curtain support. Tucson does
not yet register a production Zemismart profile; the physical model and
mapping must be qualified first. Its
[curtain contract](https://github.com/shields/tucson/blob/main/docs/implementation-plan.md#curtain-infrastructure)
defines the MQTT interface. `make homekit` in Tucson exercises the synthetic
curtain profile through both bridges and paired HomeKit clients.
