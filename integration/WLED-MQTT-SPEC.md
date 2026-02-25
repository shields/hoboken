# WLED MQTT Behavioral Specification

This document describes the externally observable MQTT behavior of a WLED device.
It was written by reading the WLED source code (Phase A of a clean-room process)
and is intended to be the sole input for implementing a WLED simulator (Phase B)
that never sees the original source.

## Scope

Only RGB devices (no white channel) are covered. Features like effects, presets,
playlists, nightlight, segments beyond the first, UDP sync, and HTTP API
passthrough over MQTT are out of scope.

---

## 1. Connection

### Subscriptions

On connect, the device subscribes (QoS 0) to three topics under its device
prefix:

| Topic              | Purpose           |
| ------------------ | ----------------- |
| `{topic}`          | Brightness/power  |
| `{topic}/col`      | Color command      |
| `{topic}/api`      | JSON API           |

If a group topic is configured, the same three suffixes are also subscribed under
the group prefix. The simulator need not implement group topics.

### Last Will and Testament

- **Will topic**: `{topic}/status`
- **Will payload**: `"offline"`
- **Will QoS**: 0
- **Will retain**: true

### On-Connect Publish

Immediately after subscribing, the device publishes its full current state (see
[Section 4: Outbound Messages](#4-outbound-messages)).

---

## 2. State Model

The device maintains three pieces of state relevant to MQTT:

| Variable   | Type       | Range   | Default           | Description                        |
| ---------- | ---------- | ------- | ----------------- | ---------------------------------- |
| `bri`      | integer    | 0–255   | 128               | Current brightness                 |
| `briLast`  | integer    | 1–255   | 128               | Brightness before last turn-off    |
| `col`      | byte[3]    | 0–255 ea| `[255, 160, 0]`   | Primary color (RGB)                |

### Power semantics

- **Off** means `bri === 0`.
- **On** means `bri > 0`.
- Whenever `bri` transitions from non-zero to zero, the non-zero value is saved
  to `briLast`.
- Whenever `bri` is set to a positive value (from any source), `briLast` is
  updated to that value _after_ the state change is applied.

### Toggle

Toggle checks current `bri`:
- If `bri === 0`: set `bri = briLast` (turn on).
- If `bri > 0`: set `briLast = bri`, then set `bri = 0` (turn off).

---

## 3. Inbound Messages

### 3a. Bare topic (`{topic}`)

The payload is interpreted as a brightness/power command:

1. **Contains `"ON"`, `"on"`, or `"true"`** (substring match):
   set `bri = briLast` (restore last brightness). Then apply state.

2. **Contains `"T"` or `"t"`** (substring match):
   toggle on/off. Then apply state.

3. **Otherwise**: parse the entire payload as a decimal unsigned integer
   (0–255). If the parsed value is 0 and `bri > 0`, save `bri` to `briLast`
   first. Then set `bri` to the parsed value. Then apply state.

Matching is checked in the order listed: `ON`/`on`/`true` first, then `T`/`t`,
then numeric. The check uses substring matching (`strstr`), so a payload like
`"ON"` or `"Turn on"` both match the first rule. A payload of `"T"` matches
toggle. A payload of `"128"` sets brightness to 128.

### 3b. Color topic (`{topic}/col`)

The payload is parsed as a color value by `colorFromDecOrHexString`:

- If the first character is `#`, `h`, or `H`: the remainder is parsed as a
  hexadecimal unsigned integer.
- Otherwise: the entire payload is parsed as a decimal unsigned integer.

The resulting uint32 is decomposed into RGBW using this bit layout:

```
Bits 31–24: W (white)
Bits 23–16: R (red)
Bits 15–8:  G (green)
Bits 7–0:   B (blue)
```

For 6-digit hex values (e.g., `#FF8000` → `0x00FF8000`), W is always 0 and the
color is pure RGB.

After parsing, the primary color is updated and state is applied (which triggers
outbound messages).

### 3c. API topic (`{topic}/api`)

If the payload starts with `{`, it is parsed as JSON and processed by the JSON
API state deserializer. Otherwise it is treated as an HTTP API query string
(out of scope for this spec).

#### JSON API fields (relevant subset)

Fields are processed in this order within `deserializeState`:

1. **`bri`** (integer 0–255): Sets brightness directly.

2. **`on`** (boolean or string `"t"`):
   - Boolean `true`: if device is currently off (`bri === 0`), toggle on
     (restore `briLast`).
   - Boolean `false`: if device is currently on (`bri > 0`), toggle off (save
     `bri` to `briLast`, set `bri = 0`).
   - String `"t"`: toggle. Special case: if `on` was already toggled on by a
     simultaneous `bri` change (e.g., `{"on":"t","bri":32}` when off), it does
     not toggle off again.

   **Interaction with `bri`**: Because `bri` is processed before `on`, sending
   `{"bri": 128, "on": true}` first sets bri=128 (which makes the device "on"),
   then the `on: true` comparison sees `bri > 0` and does nothing extra.
   Sending `{"bri": 0, "on": true}` sets bri=0, then `on: true` toggles it
   back on (restoring `briLast`).

3. **`seg`** (array of segment objects): Each segment object can contain a
   `col` field.

   **`seg[0].col`** (array of color values): Sets colors on the first segment.
   Each element in the `col` array corresponds to a color slot (index 0 =
   primary, 1 = secondary, 2 = tertiary). Each color value can be:

   - **Array of integers**: `[R, G, B]` or `[R, G, B, W]`. Values 0–255.
     Example: `[255, 0, 0]` for red.

   - **Hex string**: `"RRGGBB"` or `"RRGGBBWW"`. Parsed by `colorFromHexString`
     which uses standard byte order (NOT the same as `colorFromDecOrHexString`):
     - 6 chars: `RR` = bytes 4–5, `GG` = bytes 2–3, `BB` = bytes 0–1
     - 8 chars: `RR` = bytes 6–7, `GG` = bytes 4–5, `BB` = bytes 2–3,
       `WW` = bytes 0–1

   - **Object**: `{"r": R, "g": G, "b": B}` (each field optional, defaults to
     current value). `"w"` field also accepted.

   Example: `{"seg":[{"col":[[0, 255, 0]]}]}` sets primary color to green.

4. After all fields are processed, `stateUpdated()` is called, which triggers
   outbound messages.

---

## 4. Outbound Messages

After any state change, the device publishes the following messages. The retain
flag depends on a per-device configuration setting (`retainMqttMsg`); the status
topic always uses retain.

### 4a. Brightness: `{topic}/g`

- **Payload**: brightness as a decimal string (e.g., `"128"`, `"0"`, `"255"`)
- **QoS**: 0
- **Retain**: configurable

### 4b. Color: `{topic}/c`

- **Payload**: `#` followed by an uppercase hex representation of the color.
- **Format string**: `#%06X` applied to `(W << 24) | (R << 16) | (G << 8) | B`
  - When W = 0 (RGB-only device): produces 6 hex digits → `#RRGGBB`
  - When W > 0: produces 7–8 hex digits → `#WWRRGGBB`
- **QoS**: 0
- **Retain**: configurable
- **Examples**: `#FFA000` (default orange), `#FF0000` (red), `#00FF00` (green)

### 4c. Status: `{topic}/status`

- **Payload**: `"online"`
- **QoS**: 0
- **Retain**: true (always, regardless of `retainMqttMsg` setting)

### 4d. XML state: `{topic}/v`

An XML document with full device state. Out of scope for the simulator — the
integration test does not depend on this topic.

### Publication timing

State updates are published via `updateInterfaces()`, which is called from the
main loop with a cooldown of 1000 ms between updates. The first publish happens
immediately on connect (before the cooldown applies). For a simulator that
processes commands synchronously, publishing immediately after each command is an
acceptable simplification.

---

## 5. Behavioral Notes for Simulator Implementation

1. **Substring matching on bare topic**: `parseMQTTBriPayload` uses `strstr`,
   not exact matching. The payload `"100"` does NOT match `"ON"` or `"T"`.
   But `"BUTTON"` would match `"T"`. In practice, payloads are short and
   well-formed.

2. **`briLast` persistence**: After `stateUpdated()` runs, if `bri > 0`,
   `briLast` is updated to `bri`. This means setting bri=200 then bri=0 leaves
   `briLast` at 200.

3. **Color channel is independent of brightness**: Setting `bri = 0` does not
   change `col`. Setting a color does not change `bri`.

4. **Segment colors vs global colors**: The JSON API operates on segments. After
   segment changes, global `colPri`/`colSec` are read back from the first
   selected segment. For a single-segment device, segment 0 primary color =
   global primary color.

5. **Topic prefix stripping**: The device strips its device topic prefix (or
   group topic prefix) from incoming messages before checking the suffix. Unknown
   suffixes are ignored (passed to usermods).

6. **Empty/null payloads**: Null payloads are silently ignored. Empty strings
   parse as 0 in numeric contexts.

7. **Partial MQTT packets**: The device buffers partial packets and only
   processes the message when all parts have been received. The simulator can
   ignore this (in-process broker delivers complete messages).
