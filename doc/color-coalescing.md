# Write Coalescing and Color Mode Awareness

## The H/S Race Condition

When Siri or the Home app sets a light color, HomeKit sends Hue and
Saturation as two separate characteristic writes in a single
`PUT /characteristics` HTTP request. HAP-NodeJS dispatches these as
follows:

```
PUT /characteristics { aid: 1, iid: [hue, sat], value: [120, 100] }
  └─ Accessory.handleSetCharacteristics()          (Accessory.js:1209)
       └─ for (const write of characteristics)      // sync for...of
            └─ handleCharacteristicWrite(write)      // NOT awaited
                 └─ handleSetRequest(value)
                      └─ await this.setHandler(value) // our handler is sync
```

Each `handleCharacteristicWrite` is `async`, but the `for...of` loop does
NOT `await` it. Since our `onSet` handlers are synchronous (call
`publish()`, return `undefined`), `await undefined` resolves as a
microtask and yields back to the loop. Both `publish()` calls happen in
the same event loop turn, but as two separate MQTT messages.

Z2M processes them independently. The saturation-only message
`{ "color": { "saturation": 100 } }` uses the device's **current** hue
value, not the hue from the not-yet-processed hue message.

**Observed in production**: Asking Siri for green (hue=120) resulted in
Z2M reverting to hue≈30 because the saturation message arrived and was
applied before the hue change propagated through the Zigbee radio.

## Survey of Coalescing Strategies

| Plugin | Timer | Strategy | Source |
|---|---|---|---|
| homebridge-z2m | 0ms (`nextTick`) | Flag-based: wait for both H+S, then flush | [src/converters/light.ts](https://github.com/itavero/homebridge-z2m/blob/master/src/converters/light.ts) |
| homebridge-hue | 20ms (0–500ms) | `setTimeout` debounce, accumulate `desiredState` | [lib/HueBridge.js](https://github.com/ebaauw/homebridge-hue/blob/master/lib/HueBridge.js) |
| homebridge-deconz | 100ms (0–500ms) | Counter-based async debounce | [lib/DeconzAccessory/Light.js](https://github.com/ebaauw/homebridge-deconz/blob/master/lib/DeconzAccessory/Light.js) |
| homebridge-tplink | 100ms | `deferAndCombine` utility | [src/utils/deferAndCombine.ts](https://github.com/plasticrake/homebridge-tplink-smarthome/blob/master/src/utils/deferAndCombine.ts) |
| Home Assistant | 10ms | `async_call_later` with "newest wins" conflict resolution | [homeassistant/components/homekit/type_lights.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/homekit/type_lights.py) |
| homebridge-mqttthing | N/A | Single combined HSV MQTT topic | [docs/Configuration.md](https://github.com/arachnetech/homebridge-mqttthing/blob/master/docs/Configuration.md) |

## Why `process.nextTick`

All HAP-NodeJS characteristic handlers for a single HTTP request run
synchronously in the same event loop turn (verified by tracing the
dispatch loop above). `process.nextTick` fires after the current
synchronous execution completes but before any I/O or timers. This means:

1. **Zero added latency** — the flush happens at the earliest possible
   moment after all writes accumulate.
2. **No timer to manage** — no `setTimeout` to clear, no debounce window
   to tune.
3. **Naturally batches all writes** — whether it's H+S, On+Brightness, or
   a four-way scene activation (On+Brightness+Hue+Saturation).

This matches homebridge-z2m's approach but without the flag-based "wait
for both H+S" limitation. We simply flush whatever has accumulated by the
time `nextTick` fires.

## Deep Merge for Color Objects

Z2M expects color writes as `{ color: { hue: H, saturation: S } }`.
HAP-NodeJS delivers them separately: hue → `{ color: { hue: 120 } }`,
saturation → `{ color: { saturation: 100 } }`. A naive shallow merge
would lose the hue when the saturation write arrives.

The coalescing publisher deep-merges the `color` key specifically:

```typescript
if (key === "color" && typeof pending.color === "object") {
  pending.color = { ...pending.color, ...value };
} else {
  pending[key] = value;
}
```

All other keys use shallow merge (last write wins).

## HAP Spec Constraint: No Dual Color Mode

HAP specification Release R13, §10.11 (Color Temperature) states:

> If this characteristic is included in the "9.5 Lightbulb", "10.13 Hue"
> and "10.30 Saturation" must not be included as optional characteristics
> in "9.5 Lightbulb". This characteristic must not be used for lamps which
> support color.

This means `ColorTemperature` and `Hue`/`Saturation` cannot coexist on
the same Lightbulb service. No major HomeKit bridge (homebridge-hue,
homebridge-deconz, homebridge-z2m) converts HS→CT on the write path.

### HomeKit UI behavior

- **Dual-mode lights** (CT + HS on the same service): Home app shows five
  white presets plus a color picker. The white presets send Hue +
  Saturation values (not ColorTemperature), which puts Z2M into HS mode
  instead of CT mode.
- **CT-only lights**: Home app shows a color temperature slider that sends
  `ColorTemperature` directly.
- **Siri "set lights white"**: HomeKit sends Hue=0, Saturation=0.

### Z2M color_mode behavior

- Z2M does not support bare `{ color_mode: "color_temp" }` set commands —
  an actual `color_temp` value is required to switch modes.
- Z2M preserves per-mode state: switching from HS (green) to CT (2700K)
  and back restores the green. The `color_mode` field indicates which
  values are authoritative.
- Z2M reports `color_mode` as one of `"color_temp"`, `"hs"`, or `"xy"`.
  Both `"hs"` and `"xy"` indicate a non-CT color mode; the device's
  native color space determines which one Z2M reports.

### Hoboken's approach

Hoboken forbids combining `color_temp` and `color_hs` capabilities on the
same device (config validation rejects this). Devices are configured as
either CT-only or HS-only.

For `color_hs` devices, when HomeKit sends Hue=0 and Saturation=0 (Siri's
"set lights white" command), the coalescing publisher's `transformPayload`
hook converts this to a `color_temp` write using the last known
`color_temp` from the state cache. This causes Z2M to switch to CT mode
so the bulb uses its WW/CW LEDs instead of mixing RGB to approximate
white.

The transform only fires when the state cache contains a `color_temp`
value, confirming that the device has CCT hardware. RGB-only devices
never report `color_temp` in their state, so H=0/S=0 passes through as a
normal HS write for those devices.

## Write-Back Suppression

### The bounce problem

After a HomeKit color change, Z2M sends back multiple MQTT state updates
as the Zigbee radio processes the command:

```
t=0ms    HomeKit SET hue=255, sat=68
t=0ms    Hoboken publishes { color: { hue: 255, saturation: 68 } }
t=240ms  Z2M responds: { color: { hue: 30, saturation: 43 } }  ← STALE
t=500ms  Z2M responds: { color: { hue: 255, saturation: 43 } }  ← partial
t=750ms  Z2M responds: { color: { hue: 255, saturation: 68 } }  ← settled
```

Without suppression, the stale response at t=240ms pushes `hue: 30` back
to HomeKit, causing a visible snap to the wrong color before settling.

### Survey of write-back handling

| Project | Suppresses? | Mechanism | Window | Scope |
|---|---|---|---|---|
| homebridge-hue | **Yes** | `recentlyUpdated` flag + `setTimeout` | 500ms | bri, ct, xy |
| homebridge-deconz | **Yes** | `recentlyUpdated` flag + `await timeout` | 500ms | bri, ct, xy |
| homebridge-mqttthing | Partial | Optional `debounceRecvms` (unconditional) | configurable | all properties |
| homebridge-z2m | No | — | — | — |
| Home Assistant | No | pyhap value-changed dedup only | — | — |

Sources:
- homebridge-hue: [`lib/HueLight.js`](https://github.com/ebaauw/homebridge-hue/blob/master/lib/HueLight.js) — `recentlyUpdated` flag in `_put()`, checked in `checkBri()`, `checkCt()`, `checkXy()`
- homebridge-deconz: [`lib/DeconzService/LightsResource.js`](https://github.com/ebaauw/homebridge-deconz/blob/master/lib/DeconzService/LightsResource.js) — identical pattern
- homebridge-mqttthing: [`lib/handlers.js`](https://github.com/arachnetech/homebridge-mqttthing/blob/master/lib/handlers.js) — `debounceRecvms` config

### Hoboken's approach

After publishing a color-related MQTT message (`color` or `color_temp` in
the payload), record a per-device timestamp. When a state update arrives
from Z2M within 500ms of that timestamp, strip color-related keys
(`color`, `color_temp`, `color_mode`) before pushing to HomeKit. The
state cache is always updated regardless of suppression, so the dashboard
and metrics stay current.

This follows the homebridge-hue/homebridge-deconz pattern (the only
implementations that actually solve this problem), with two differences:

1. **Timestamp instead of boolean flag**: A timestamp allows checking the
   elapsed time precisely, rather than relying on a `setTimeout` callback
   to clear a flag. The behavior is equivalent.

2. **Per-topic granularity**: The suppression window is tracked per device
   topic, so a write to one device doesn't suppress updates from another.

Like homebridge-hue, `on`/`off` state and `brightness` updates are never
suppressed — they are independent of the color bounce problem and
critical for responsiveness.

After the suppression window, the characteristic already holds the value
from the HomeKit SET. Z2M's final settled state is in the cache. If the
device settled at a slightly different value than requested, the next
unsuppressed state update will sync the characteristic.

## Future Work

### White → color_temp conversion

Apple's Home app shows five white presets for HS-capable lights. These
presets send Hue + Saturation values that approximate white tones, but
put Z2M into HS mode instead of CT mode. On RGB+CCT bulbs, this means
the RGB LEDs mix to approximate white instead of using the dedicated
WW/CW LEDs, which produces inferior white quality.

A future enhancement could map these specific preset values to
`color_temp` writes. Observed preset values from the Home app:

| Preset | Hue | Sat | Z2M color_temp |
|--------|-----|-----|----------------|
| Coolest | 222 | 20 | 138 |
| Cool | 251 | 5 | 163 |
| Neutral | 28 | 23 | 207 |
| Warm | 30 | 48 | 265 |
| Warmest | 30 | 67 | 325 |

The Home app also provides a color temperature slider as a tab in the
color selection popup. Converting all the values from this would
require reverse-engineering what path in color space the slider is
traversing.

Currently only the exact H=0/S=0 case (Siri's "set lights white") is
converted.
