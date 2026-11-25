# WLED MQTT Behavioral Specification

This document describes the externally observable MQTT behavior of a WLED device.
It was written by reading the WLED source code (Phase A of a clean-room process)
and is intended to be the sole input for implementing a WLED simulator (Phase B)
that never sees the original source.

## Scope

RGB and RGBW devices with one or more segments are covered, limited to each
segment's `on`, `sel` and primary color (§3c, §6). Every segment is assumed to
have RGB and white capability. Effects, presets, playlists, nightlight, segment
geometry (`start`, `stop`, creating or deleting segments), the main-segment
setting (`mainseg`), Kelvin and random (`"r"`) colors, UDP sync, and HTTP API
passthrough over MQTT are out of scope. Source references are to WLED v16.0.1,
`wled00/`.

---

## 1. Connection

### Subscriptions

On connect, the device subscribes (QoS 0) to three topics under its device
prefix:

| Topic         | Purpose          |
| ------------- | ---------------- |
| `{topic}`     | Brightness/power |
| `{topic}/col` | Color command    |
| `{topic}/api` | JSON API         |

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

| Variable  | Type    | Range    | Default            | Description                                  |
| --------- | ------- | -------- | ------------------ | -------------------------------------------- |
| `bri`     | integer | 0–255    | 128                | Current brightness                           |
| `briLast` | integer | 1–255    | 128                | Brightness before last turn-off              |
| `col`     | byte[4] | 0–255 ea | `[255, 160, 0, 0]` | Primary color (R, G, B, W), per segment (§6) |

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

3. **Otherwise**: parse the entire payload as a decimal integer and clamp it
   to 0–255. If the clamped value is 0 and `bri > 0`, save `bri` to `briLast`
   first. Then set `bri` to the clamped value. Then apply state.

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

After parsing (`mqtt.cpp`, `colorFromDecOrHexString` in `colors.cpp`), the
four bytes, white included, become the global primary color, and
`colorUpdated` → `applyValuesToSelectedSegs` (`led.cpp`) copies them to the
primary color of every selected segment (§6). Unselected segments are not
touched. `stateUpdated` then reads the global primary color back from the first
selected segment, or the main segment when none is selected (§6), so with no
selected segment the color is discarded and `{topic}/c` shows the main
segment's unchanged color. The simulator ignores an empty payload and one
that does not begin with a number; WLED still runs `colorUpdated` for them,
with the stale global color for an empty payload and with 0 for the other.

Real WLED publishes only when `bri` or `stateChanged` changed, and
`Segment::setColor` sets `stateChanged` only when the color differs, so a
`/col` message that does not change the first color slot of any selected
segment publishes nothing. The simulator publishes after every `/col` payload
that parses as a number, as in §5.7.

### 3c. API topic (`{topic}/api`)

If the payload starts with `{`, it is parsed as JSON and processed by the JSON
API state deserializer. Otherwise it is treated as an HTTP API query string
(out of scope for this spec).

#### JSON API fields (relevant subset)

Fields are processed in this order within `deserializeState`:

1. **`bri`** (integer): Sets brightness directly, clamped to 0–255.

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

3. **`seg`** (`deserializeState` and `deserializeSegment` in `json.cpp`): an
   object or an array of segment objects. Each element can contain `on`, `sel`
   and `col`; other fields are out of scope.

   **Which segments an element addresses.** Each element's target is
   `elem["id"] | it`, so a numeric `id` selects that segment.
   - `seg` is an **array**: `it` is the element's index in the array, whether
     or not earlier elements had an `id` or were objects. An element that is
     not an object changes nothing but still uses up its index.
   - `seg` is an **object**: with a numeric `id` of 0 or more, that segment
     only. Without one (absent, non-numeric or negative), the object is applied
     in turn to every segment that is selected at that moment.
   - A target at or beyond the segment count is ignored (`deserializeSegment`
     creates a segment only for an element with a positive `stop`, which is out
     of scope).

   **`on`** (`getBoolVal`, `json.cpp`): a boolean sets the segment's power; a
   string beginning with `t` toggles it; anything else leaves it alone. This
   is the segment's own power and does not change `bri`.

   **`sel`**: the segment's selection, read with the same `getBoolVal` rules as
   `on`.

   **`col`** (array of color values): each element is a color slot (index 0 =
   primary, 1 = secondary, 2 = tertiary). Only slot 0 is modelled. A `col`
   that is not an array is ignored. Slot 0 can be:

   - **Array of integers**: up to four channels `[R, G, B, W]`, copied by
     `copyArray` into a zero-initialised array. A missing channel is therefore
     0, so `[R, G, B]` sets W to 0 and does not keep the old white. Fewer than
     three elements is valid (`[R]` sets G, B and W to 0). An empty array
     leaves the color alone. Each channel is truncated to a byte (`RGBW32`).
     The simulator reads an element that is not a number as 0; `copyArray`
     converts with `as<int>()`, which does more for booleans and numeric
     strings.

   - **Hex string**: `"RRGGBB"` or `"RRGGBBWW"`. Parsed by `colorFromHexString`
     (`colors.cpp`), which reads the channels left-to-right. The string must be
     exactly 6 or 8 bytes, otherwise it is ignored. It is read with `strtoul`,
     so non-hex characters end the number early and a string such as
     `"ZZZZZZ"` is valid and reads as 0.
     - 6 chars: `RR` = chars 0–1, `GG` = chars 2–3, `BB` = chars 4–5, and W is
       set to 0
     - 8 chars: `RR` = chars 0–1, `GG` = chars 2–3, `BB` = chars 4–5,
       `WW` = chars 6–7

     This differs from `colorFromDecOrHexString` (§3b) only for 8-digit values:
     there the white byte is the high byte (`WWRRGGBB`), whereas here it is the
     low byte (`RRGGBBWW`). For 6-digit values both produce identical RGB.

   - **Object**: `{"r": R, "g": G, "b": B, "w": W}`. Each field is optional
     and keeps the segment's current value when it is absent or not an
     integer from 0 to 255, white included (`oCol["r"] | R(seg.colors[i])`,
     where `R()` is a `byte`).

   A number (Kelvin; 0 is black) and `"r"` (random) are real WLED colors that
   the simulator ignores. Examples: `{"seg":[{"col":[[0, 255, 0]]}]}` sets the
   first segment's primary color to green with white 0;
   `{"seg":{"col":[[0, 0, 0, 255]]}}` sets every selected segment to pure
   white.

   An element can set `on`, `sel` and `col` together. They are applied in that
   order (`on`, then `sel`, then `col`); they do not affect each other.

4. After all fields are processed, `stateUpdated()` is called
   (`if (stateChanged) stateUpdated(callMode)` at the end of `deserializeState`).
   Outbound messages are only triggered if state actually changed
   (`bri != briOld || stateChanged`). If no recognized fields were present
   (e.g., an empty `{}`), brightness is unchanged and the internal
   `stateChanged` flag remains false, so **no outbound messages are
   published**.

   For `seg`, `deserializeSegment` sets `stateChanged` when `differs()`
   (`json.cpp`) finds the segment's options (which include `on`) or colors
   different from before, and ignores a change of `sel` alone. So a segment
   whose `on` or primary color (white included) changes publishes, even when it
   is not the first selected segment; setting a field to the value it already
   has publishes nothing; and a message that only changes `sel` publishes
   nothing (the next publish reflects the new selection).

---

## 4. Outbound Messages

When state changes (brightness differs from its previous value, or the internal
`stateChanged` flag was set during deserialization), the device publishes the
following messages. The retain flag depends on a per-device configuration setting
(`retainMqttMsg`); the status topic always uses retain.

### 4a. Brightness: `{topic}/g`

- **Payload**: brightness as a decimal string (e.g., `"128"`, `"0"`, `"255"`)
- **QoS**: 0
- **Retain**: configurable

### 4b. Color: `{topic}/c`

- **Payload**: `#` followed by an uppercase hex representation of the color.
- **Format string**: `#%06X` applied to `(W << 24) | (R << 16) | (G << 8) | B`
  (`publishMqtt`, `mqtt.cpp`)
  - When W = 0: produces 6 hex digits → `#RRGGBB`
  - When W > 0: produces 7–8 hex digits → `#WWRRGGBB`; W of 1–15 gives 7
    digits, as `%X` pads only to the minimum width
- **Source segment**: the global primary color read back by `stateUpdated`
  (`setValuesFromFirstSelectedSeg`, `led.cpp`): the primary color of the first
  selected segment (`getFirstSelectedSegId`, `FX_fcn.cpp`), or of the main
  segment when none is selected (§6)
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
   selected segment (§6). For a single-segment device, segment 0 primary color
   = global primary color.

5. **Topic prefix stripping**: The device strips its device topic prefix (or
   group topic prefix) from incoming messages before checking the suffix. Unknown
   suffixes are ignored (passed to usermods).

6. **Empty/null payloads**: Null payloads are silently ignored. Empty strings
   parse as 0 in numeric contexts.

7. **`stateChanged` guard**: `stateUpdated()` is called unconditionally after
   `deserializeState`, but the code that schedules outbound messages
   (`interfaceUpdateCallMode = callMode`) is inside a guard:
   `if (bri != briOld || stateChanged)`. The `stateChanged` flag is set when
   segment properties change during deserialization. For the bare topic and
   color topic handlers (which don't go through `deserializeState`), the
   publish path is different and always fires. A simulator that publishes
   after every command that modifies `bri` or `col` is correct.

8. **Empty JSON API payload**: Sending `{}` to the API topic calls
   `deserializeState` which calls `stateUpdated()`, but since no fields
   changed, the guard fails and no outbound messages are published. An empty
   object is effectively a no-op.

9. **Partial MQTT packets**: The device buffers partial packets and only
   processes the message when all parts have been received. The simulator can
   ignore this (in-process broker delivers complete messages).

---

## 6. Segments

The simulator takes the number of segments as a constructor argument (default
1). Each segment has three modelled properties:

| Property | Type    | Default                            | Description                     |
| -------- | ------- | ---------------------------------- | ------------------------------- |
| `on`     | boolean | `true`                             | Segment power (`SEG_OPTION_ON`) |
| `sel`    | boolean | `true` for segment 0, else `false` | Segment selected                |
| `col`    | byte[4] | `[255, 160, 0, 0]`                 | Primary color R, G, B, W        |

- **Defaults**: the `Segment` constructor (`FX.h`) sets
  `options(SELECTED | SEGMENT_ON)`, so every segment WLED creates starts
  selected and on, and a single segment is therefore selected. For a device
  with several segments the simulator selects only segment 0, which models a
  device whose other segments have been deselected; a client selects the
  others with `sel`.
- **First selected segment**: `getFirstSelectedSegId` (`FX_fcn.cpp`) returns
  the lowest-numbered active segment that is selected, else the main segment.
  `setValuesFromFirstSelectedSeg` (`led.cpp`) reads the global primary color
  from it on every `stateUpdated`, and `publishMqtt` publishes that color.
  `{topic}/g` is global and unaffected by segments.
- **Main segment**: `getMainSegmentId` is segment 0 until `mainseg` changes it,
  and the simulator never changes it. Every simulated segment is active.
- **Segment `on` and `bri`**: `on` is independent of the global `bri` and of
  `{topic}/g`. A segment turned off still reports its color.
- **`/col`** applies the color to every selected segment (§3b);
  **`/api` `seg`** addresses segments by id or index (§3c).
