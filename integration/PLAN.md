# WLED Integration Test — Implementation Plan (Phase B)

This plan is the sole input for implementing the integration test. It should be
executed in a new context that has **no access to WLED source code**. The
simulator is built entirely from
[`WLED-MQTT-SPEC.md`](./WLED-MQTT-SPEC.md).

---

## Overview

A self-contained integration test that runs directly under Node.js (no Docker)
and stands up:

1. An in-process MQTT broker (**Aedes**)
2. A clean-room **WLED simulator** (from the behavioral spec)
3. The Hoboken **bridge** (`startBridge()`)
4. A real **HAP client** (`hap-controller`) that pairs and exercises
   bidirectional test scenarios

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ┌──────────────┐  HAP/IP  ┌──────────┐  MQTT   │
│  │hap-controller├─────────►│  Bridge  │◄───┐    │
│  │ (HAP client) │          │(startBridge)│  │    │
│  └──────────────┘          └──────────┘   │    │
│                                            │    │
│                             ┌──────────┐   │    │
│                             │  Aedes   │◄──┘    │
│                             │ (broker) │◄──┐    │
│                             └──────────┘   │    │
│                                            │    │
│                      ┌─────────────────┐   │    │
│                      │ WledSimulator   │───┘    │
│                      │(from spec only) │        │
│                      └─────────────────┘        │
└──────────────────────────────────────────────────┘
```

---

## Dependencies

Add to `devDependencies` in `package.json`:

| Package            | Purpose                                     |
| ------------------ | ------------------------------------------- |
| `aedes`            | In-process MQTT 3.1.1 broker                |
| `hap-controller`   | HAP client — pair-setup, read/write chars   |

Install with `bun add --dev aedes hap-controller`.

Also add a `@types/aedes` dev dependency if type declarations are not bundled
(check at install time).

---

## Files to Create

| File                              | Purpose                                    |
| --------------------------------- | ------------------------------------------ |
| `integration/wled-simulator.ts`   | WLED simulator (spec only, no WLED source) |
| `integration/wled-roundtrip.ts`   | Main integration test script               |

## Files to Modify

| File                          | Change                                          |
| ----------------------------- | ----------------------------------------------- |
| `package.json`                | Add `aedes` + `hap-controller` devDeps, script  |
| `src/bridge.ts`               | Export HAP port on `BridgeHandle` (see §3)       |
| `.github/workflows/build.yml` | Add integration test step (see §6)               |

---

## 1. WLED Simulator (`integration/wled-simulator.ts`)

### Class: `WledSimulator`

Built entirely from `WLED-MQTT-SPEC.md`. Does **not** import or reference any
WLED source code.

```ts
interface WledSimulatorOptions {
  mqttUrl: string;   // e.g. "mqtt://127.0.0.1:1883"
  topic: string;     // e.g. "wled/test1"
}
```

#### State

```ts
bri = 128;
briLast = 128;
col: [number, number, number] = [255, 160, 0];
```

#### Connection behavior

- Connect to MQTT broker with:
  - **Client ID**: `wled-sim-{topic}` (or similar unique ID)
  - **Will**: topic `{topic}/status`, payload `"offline"`, QoS 0, retain true
- On connect:
  - Subscribe to `{topic}`, `{topic}/col`, `{topic}/api` (QoS 0)
  - Publish full state (see "Publish state" below)

#### Inbound message handling

Route by topic suffix after stripping the device topic prefix:

**Bare topic** (`{topic}`): call `handleBriPayload(payload)`:

```
if payload contains "ON" or "on" or "true":
    bri = briLast
else if payload contains "T" or "t":
    toggle()
else:
    n = parseInt(payload, 10) clamped to uint8
    if n === 0 && bri > 0: briLast = bri
    bri = n
publishState()
```

**`/col`**: call `handleColPayload(payload)`:

```
if payload starts with '#', 'h', or 'H':
    value = parseInt(payload.slice(1), 16)
else:
    value = parseInt(payload, 10)
col = [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF]
publishState()
```

**`/api`**: call `handleApiPayload(payload)`:

The JSON API processes fields in this order: `bri`, then `on`, then `seg`.
The `on`/`bri` interaction is the trickiest part. Here is the precise logic
followed by a reference table:

```
if payload starts with '{':
    json = JSON.parse(payload)
    onBefore = bri > 0         // snapshot power state before any changes

    // 1. Process bri first
    if "bri" in json: bri = json.bri

    // 2. Then on (boolean)
    if "on" in json:
        if typeof json.on === "string" && json.on === "t":
            // Toggle — but don't toggle OFF if bri just turned us on
            if onBefore || bri === 0: toggle()
        else:
            on = Boolean(json.on)
            if !on !== !(bri > 0): toggle()

    // 3. Then seg[0].col
    if "seg" in json and Array.isArray(json.seg):
        seg0 = json.seg[0]
        if seg0?.col:
            parseSegColor(seg0.col[0])  // primary color only
    publishState()
```

**Reference table for `bri`/`on` interaction:**

| Initial bri | JSON payload              | Expected bri after | Why                                                       |
| ----------- | ------------------------- | ------------------ | --------------------------------------------------------- |
| 0           | `{"on":"t","bri":32}`     | 32                 | bri=32 turns on; toggle skipped (wasn't on before bri)    |
| 128         | `{"on":"t"}`              | 0                  | Was on → toggle turns off, briLast=128                    |
| 0           | `{"on":true}`             | 128 (briLast)      | Was off → toggle turns on, restores briLast               |
| 0           | `{"bri":128,"on":true}`   | 128                | bri=128 turns on; on:true sees already on, no-op          |
| 0           | `{"bri":0,"on":true}`     | 128 (briLast)      | bri=0 stays off; on:true sees off → toggle restores       |
| 128         | `{"on":false}`            | 0                  | Was on → toggle turns off                                 |
| 128         | `{"bri":200}`             | 200                | No `on` field, just brightness                            |

`parseSegColor(entry)`:
- If array of numbers: `col = [entry[0], entry[1], entry[2]]`
- If string (hex): parse 6-char hex as RRGGBB
- If object with r/g/b: `col = [entry.r, entry.g, entry.b]`

**`toggle()`**:
```
if bri === 0:
    bri = briLast
else:
    briLast = bri
    bri = 0
```

#### Publish state

After any command, and on connect:

```
mqtt.publish("{topic}/g", String(bri), { qos: 0, retain: false })
mqtt.publish("{topic}/c", formatColor(), { qos: 0, retain: false })
mqtt.publish("{topic}/status", "online", { qos: 0, retain: true })
```

`formatColor()`:
```ts
"#" + ((col[0] << 16) | (col[1] << 8) | col[2])
    .toString(16).toUpperCase().padStart(6, "0")
```

After `publishState()`, also update `briLast` if `bri > 0` (per spec §2:
"Whenever `bri` is set to a positive value, `briLast` is updated to that
value _after_ the state change is applied").

#### Public API

- `state`: getter returning `{ bri, briLast, col }` for test assertions
- `setBrightness(n)`: update internal state and publish `{topic}/g` (simulates
  external change like physical button)
- `setColor([r,g,b])`: update internal state and publish `{topic}/c`
- `close()`: disconnect MQTT client, returns Promise

---

## 2. Integration Test Script (`integration/wled-roundtrip.ts`)

A standalone Node.js script (not a Bun test — `hap-controller` uses libsodium
WASM which requires Node). Exits with code 0 on success, non-zero on failure.
Uses `node:assert` for assertions.

The entire body must be wrapped in `try/finally` so that teardown runs even
when an assertion fails. The global 30s timeout (`setTimeout` +
`process.exit(1)`) is a backstop for hangs, but `finally` handles the normal
failure case.

### Verbose mode

When `VERBOSE=1` is set, log all MQTT messages flowing through the Aedes
broker. This makes CI failures debuggable:

```ts
const verbose = process.env.VERBOSE === "1";

if (verbose) {
  aedes.on("publish", (packet, client) => {
    const who = client?.id ?? "broker";
    console.log(`  [mqtt] ${who} → ${packet.topic}: ${packet.payload.toString()}`);
  });
}
```

This hooks into Aedes's `publish` event, which fires for every message
(including internal `$SYS` topics — filter those out if noisy). Keep it
behind the env var so normal test output stays clean.

### Setup sequence

1. **Start Aedes broker** on an ephemeral port (port 0 → OS assigns).
   Create a `net.Server`, pass it to Aedes, listen on `127.0.0.1`.

2. **Create WledSimulator** connected to `mqtt://127.0.0.1:{aedesPort}` with
   topic `wled/test1`.
   Wait for the simulator's on-connect state publish to arrive (wait for
   `{topic}/g` message on broker, or simply wait for the MQTT `connect` event
   + a short delay).

3. **Configure Hoboken bridge**:
   ```ts
   import { HAPStorage } from "@homebridge/hap-nodejs";
   import { mkdtempSync } from "node:fs";
   import { tmpdir } from "node:os";

   HAPStorage.setCustomStoragePath(mkdtempSync(join(tmpdir(), "hoboken-test-")));

   const config: Config = {
     bridge: {
       name: "Test Bridge",
       mac: "0E:36:29:42:81:10",    // unique MAC, first octet even
       pincode: "031-45-154",
       port: 0,                      // ephemeral
     },
     mqtt: {
       url: `mqtt://127.0.0.1:${aedesPort}`,
     },
     devices: [{
       name: "Test WLED",
       type: "wled",
       topic: "wled/test1",
       capabilities: ["on_off", "brightness", "color_hs"],
     }],
   };
   ```

4. **Start bridge** via `startBridge(config)`.

5. **Get HAP port** from `handle.hapPort` (see §4 source change — the
   `BridgeHandle` now exposes the resolved port directly).

6. **Create HAP client** (`hap-controller`'s `HttpClient`):
   ```ts
   import { HttpClient } from "hap-controller";

   const client = new HttpClient(
     "test-client",         // clientId
     "127.0.0.1",
     handle.hapPort,
   );
   ```

7. **Pair**: `await client.pairSetup(config.bridge.pincode)` (this handles
   SRP pair-setup M1–M5).

8. **Discover characteristics**: `const accessories = await client.getAccessories()`.
   Build a map of `"aid.iid"` → characteristic. The IIDs from hap-controller
   are BigNumber objects — convert with `String()` for map keys.

   Find characteristics by type UUID:
   - `Characteristic.On.UUID` → `"00000025-0000-1000-8000-0026BB765291"`
   - `Characteristic.Brightness.UUID` → `"00000008-0000-1000-8000-0026BB765291"`
   - `Characteristic.Hue.UUID` → `"00000013-0000-1000-8000-0026BB765291"`
   - `Characteristic.Saturation.UUID` → `"0000002F-0000-1000-8000-0026BB765291"`

   The bridge aid=1, device aid=2 (first bridged accessory). Build a lookup:
   ```ts
   function findChar(accessories, typeUuid) → { aid, iid }
   ```

### Utility: `waitForBrokerMessage`

The Aedes broker instance can listen for published messages via the `publish`
event. Create a helper:

```ts
function waitForTopic(broker, topicPrefix, subtopic, timeoutMs = 5000):
    Promise<string>
```

This resolves when a message matching `{topicPrefix}/{subtopic}` arrives on
the broker, returning the payload string. Use this to confirm the bridge
published the expected MQTT message after a HAP write.

### Utility: `poll`

HAP characteristic reads may not reflect state immediately (the bridge must
process the MQTT message, update the state cache, and push to accessories).
Create a polling helper:

```ts
async function poll(fn: () => Promise<boolean>, intervalMs = 100, timeoutMs = 5000)
```

### Test scenarios

#### HomeKit → WLED

**Test 1: Turn on**
```ts
await client.setCharacteristics({ [onKey]: true });
// Bridge converts { on: true } → homeKitToWled → { "on": true }
// → publishes to wled/test1/api as JSON
// Simulator processes on:true, restores briLast (128)
// Wait for simulator to receive and process
assert.strictEqual(simulator.state.bri > 0, true);
```

**Test 2: Set brightness to 75%**
```ts
await client.setCharacteristics({ [briKey]: 75 });
// homeKitBrightnessToWled(75) = Math.round(75/100 * 255) = 191
assert.strictEqual(simulator.state.bri, 191);
```

**Test 3: Set color to green (hue=120, sat=100)**
```ts
await client.setCharacteristics({ [hueKey]: 120, [satKey]: 100 });
// hsToRgb(120, 100) = [0, 255, 0]
// Bridge publishes {"seg":[{"col":[[0,255,0]]}]} to wled/test1/api
assert.deepStrictEqual(simulator.state.col, [0, 255, 0]);
```

Note on coalescing: The bridge uses `createCoalescingPublish` which batches
hue and saturation into a single MQTT publish via `process.nextTick`. The
HAP client `setCharacteristics` sends both in one request, so they arrive
in the same tick and get coalesced.

#### WLED → HomeKit

For these tests, the simulator publishes state changes directly (via
`setBrightness` / `setColor`) and we read characteristics back via
`client.getCharacteristics`.

**Test 4: Simulator sets brightness to 128 → HomeKit reads 50%**
```ts
simulator.setBrightness(128);
// wledBrightnessToHomeKit(128) = Math.round(128/255 * 100) = 50
await poll(async () => {
  const chars = await client.getCharacteristics([briKey]);
  return chars[briKey] === 50;
});
```

**Test 5: Simulator sets color to red → HomeKit hue=0, sat=100**
```ts
simulator.setColor([255, 0, 0]);
// rgbToHs(255, 0, 0) = { hue: 0, saturation: 100 }
await poll(async () => {
  const chars = await client.getCharacteristics([hueKey, satKey]);
  return chars[hueKey] === 0 && chars[satKey] === 100;
});
```

Note on write-back suppression: The bridge suppresses color feedback for
500ms after a color write. These WLED→HomeKit tests should NOT run within
500ms of a HomeKit→WLED color write. Running tests sequentially with awaits
between them naturally provides enough gap.

**Test 6: Simulator sets brightness to 0 → HomeKit on=false**
```ts
simulator.setBrightness(0);
// parseWledMessage("g", "0") → { on: false, bri: 0 }
await poll(async () => {
  const chars = await client.getCharacteristics([onKey]);
  return chars[onKey] === false;
});
```

#### Error path

**Test 7: HAP write while MQTT disconnected → SERVICE_COMMUNICATION_FAILURE**

```ts
// Stop the Aedes broker (or force-disconnect the bridge's MQTT client)
// to simulate a broker outage.
aedes.close();
server.close();

// Attempt a HAP write — bridge should throw SERVICE_COMMUNICATION_FAILURE
try {
  await client.setCharacteristics({ [onKey]: true });
  assert.fail("Expected setCharacteristics to fail");
} catch (err) {
  // hap-controller surfaces HAP status errors; verify we get the
  // communication failure status code (-70402).
  assert.strictEqual(err.hapStatus, -70402);
}
```

This test validates that the bridge's `prePublishCheck` correctly detects
MQTT disconnection and reports it through HAP. Run this test last since it
tears down the broker.

#### Scope note: color_temp

The test config uses `color_hs` (not `color_temp`) because WLED does not use
mireds. The `color_temp` capability is tested in the existing unit tests.

### Teardown sequence

Teardown runs in `finally` so it executes even after assertion failures:

```ts
let exitCode = 0;
try {
  // ... setup and tests ...
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  client?.close();
  await handle?.shutdown();
  await simulator?.close();
  aedes?.close();
  server?.close();
  rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(exitCode);
```

### Output format

Print each test name and result:
```
WLED integration test
  ✓ HomeKit → WLED: turn on
  ✓ HomeKit → WLED: set brightness
  ✓ HomeKit → WLED: set color
  ✓ WLED → HomeKit: brightness update
  ✓ WLED → HomeKit: color update
  ✓ WLED → HomeKit: turn off
  ✓ MQTT disconnect → HAP error

7/7 passed
```

On failure, print the assertion error and exit with code 1.

Add a global timeout (30s) via `setTimeout(() => process.exit(2), 30_000)`
as a backstop for hangs. Use `.unref()` so it doesn't keep the process alive
during normal exit.

---

## 3. Source Change: Export HAP Port (`src/bridge.ts`)

The `BridgeHandle` interface currently has `bridge`, `metricsPort?`, and
`shutdown`. Add `hapPort: number` — the actual port the HAP server bound to
(which differs from the configured port when `port: 0` is used).

After `bridge.publish()` resolves, the server is listening. Read the port:

```ts
interface BridgeHandle {
  bridge: Bridge;
  hapPort: number;       // ← add this
  metricsPort?: number;
  shutdown: () => Promise<void>;
}
```

In `startBridge`, after the `await bridge.publish(...)` call, read the port
from the bridge's advertise info and include it in the returned handle:

```ts
const hapPort = bridge.port;   // Bridge.port is set after publish()
```

Alternatively, `bridge._server?.address()?.port` — but `bridge.port` is the
public API that hap-nodejs sets after `publish()` resolves.

This is a one-line source change that eliminates the need to chain through
four levels of private API (`_server.httpServer._httpServer.address()`).

---

## 4. package.json Changes

Add script:
```json
"integration:wled": "node --experimental-strip-types integration/wled-roundtrip.ts"
```

Node 24 supports `.ts` files with `--experimental-strip-types` (enabled by
default for `.ts` imports, but explicit here for clarity).
`--disable-warning=ExperimentalWarning` can be added if the warning is noisy.

Add devDependencies:
```json
"aedes": "^0.51.3",
"hap-controller": "^0.11.0"
```

(Check latest versions at install time.)

---

## 5. Key Implementation Gotchas

### Run under Node, not Bun

`hap-controller` depends on `libsodium-wrappers` which loads a WASM module.
This works under Node but not reliably under Bun. The script must be run with
`node`, not `bun run` or `bun test`.

### BigNumber IIDs

`hap-controller` returns IID values as `BigNumber` objects (from `bn.js`),
not plain numbers. When building the `"aid.iid"` key for `setCharacteristics`
/ `getCharacteristics`, use:

```ts
const key = `${String(aid)}.${String(iid)}`;
```

### Write-back suppression

The bridge records `lastColorPublish.set(topic, Date.now())` whenever a
color-related characteristic is written from HomeKit. For 500ms after, inbound
MQTT color updates are suppressed (only `on` and `brightness` pass through).
The WLED→HomeKit color tests (Test 5) must not run within 500ms of a
HomeKit→WLED color write (Test 3). Running tests sequentially with awaits
between them naturally provides enough gap.

### Coalescing

`createCoalescingPublish` batches multiple `setPayload` calls within the same
tick into a single MQTT publish. When `setCharacteristics` sets both hue and
saturation, both arrive in the same tick and are merged into one
`{"seg":[{"col":[[r,g,b]]}]}` publish. This is important — if they were sent
as two separate publishes, the second would use the cached saturation/hue
from the first, potentially producing the wrong color.

### HAP storage isolation

```ts
import { HAPStorage } from "@homebridge/hap-nodejs";
HAPStorage.setCustomStoragePath(mkdtempSync(join(tmpdir(), "hoboken-")));
```

This **must** be called before `startBridge` (which creates Bridge/Accessory
objects that trigger HAP storage reads). It prevents test runs from
interfering with each other or with a real installation.

### Assertion tolerances

- Brightness conversions are lossy due to integer rounding. The round-trip
  HomeKit 75 → WLED 191 → HomeKit `Math.round(191/255*100) = 75` is exact in
  this case, but other values may be off by ±1. Use exact assertions for the
  specific values chosen in tests (which were picked to round-trip cleanly).
- Color HS→RGB→HS round-trips are lossy. Green (H=120, S=100) →
  `[0, 255, 0]` → `{ hue: 120, saturation: 100 }` is exact. Red (H=0, S=100)
  → `[255, 0, 0]` → `{ hue: 0, saturation: 100 }` is exact.

---

## 6. CI Integration (`.github/workflows/build.yml`)

Add a step after unit tests and before the screenshot test. The CI runner
(ubuntu-latest) has Node.js pre-installed, but the workflow currently only
sets up Bun. Add a `setup-node` step, or rely on the system Node (Ubuntu
runners ship Node 18+; we need 24). Simplest approach — add `setup-node`:

```yaml
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24

      - name: Integration test (WLED)
        run: bun run integration:wled
        env:
          VERBOSE: "1"
```

`bun run integration:wled` works as a task runner — it reads the script from
`package.json` and executes `node --experimental-strip-types integration/wled-roundtrip.ts`.
`VERBOSE=1` enables MQTT trace logging so CI failures produce useful output.

Pin the `setup-node` action to a commit hash consistent with the project's
existing action pinning style.

---

## 7. Verification

```sh
# Install new deps
bun install

# Run integration test
bun run integration:wled

# With trace logging
VERBOSE=1 bun run integration:wled

# Existing tests must still pass
bun run lint && bun run check && bun run test
```

The integration test is fully independent of the existing unit tests. It
does not modify any source files in `src/` (other than the one-line
`hapPort` addition to `BridgeHandle`) and does not affect coverage numbers.

---

## 8. Files That Must NOT Be Read

The implementer must **not** read or reference any WLED source code. The
simulator is built solely from `WLED-MQTT-SPEC.md`. This includes:

- Any file under `wled00/` or the WLED repository
- The Phase A transcript
- Any WLED documentation beyond the behavioral spec

The Hoboken source files (`src/bridge.ts`, `src/convert.ts`, etc.) **should**
be read — they are the system under test.
