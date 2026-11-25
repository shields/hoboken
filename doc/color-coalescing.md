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

| Plugin               | Timer            | Strategy                                                  | Source                                                                                                                                             |
| -------------------- | ---------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| homebridge-z2m       | 0ms (`nextTick`) | Flag-based: wait for both H+S, then flush                 | [src/converters/light.ts](https://github.com/itavero/homebridge-z2m/blob/master/src/converters/light.ts)                                           |
| homebridge-hue       | 20ms (0–500ms)   | `setTimeout` debounce, accumulate `desiredState`          | [lib/HueBridge.js](https://github.com/ebaauw/homebridge-hue/blob/master/lib/HueBridge.js)                                                          |
| homebridge-deconz    | 100ms (0–500ms)  | Counter-based async debounce                              | [lib/DeconzAccessory/Light.js](https://github.com/ebaauw/homebridge-deconz/blob/master/lib/DeconzAccessory/Light.js)                               |
| homebridge-tplink    | 100ms            | `deferAndCombine` utility                                 | [src/utils/deferAndCombine.ts](https://github.com/plasticrake/homebridge-tplink-smarthome/blob/master/src/utils/deferAndCombine.ts)                |
| Home Assistant       | 10ms             | `async_call_later` with "newest wins" conflict resolution | [homeassistant/components/homekit/type_lights.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/homekit/type_lights.py) |
| homebridge-mqttthing | N/A              | Single combined HSV MQTT topic                            | [docs/Configuration.md](https://github.com/arachnetech/homebridge-mqttthing/blob/master/docs/Configuration.md)                                     |

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

## Color Temperature Together with Hue and Saturation

HAP specification Release R13, §10.11 (Color Temperature) states:

> If this characteristic is included in the "9.5 Lightbulb", "10.13 Hue"
> and "10.30 Saturation" must not be included as optional characteristics
> in "9.5 Lightbulb". This characteristic must not be used for lamps which
> support color.

Bridges expose all three on one Lightbulb service anyway: Home Assistant's
HomeKit bridge (`type_lights.py`), homebridge-hue, homebridge-deconz, and
homebridge-z2m. HAP-NodeJS documents the combination in
`AdaptiveLightingController` and does not check for it. None of them
converts HS→CT on the write path; they rely on the controller writing
`ColorTemperature`.

Hoboken accepts `color_temp` and `color_hs` together on a Z2M device and
then exposes all three characteristics. A device with `color_hs` alone
exposes Hue and Saturation only.

### What the controllers write

These come from two sources. The HAP write log records what arrives. And
Apple's frameworks on macOS 27.2.1 can be called directly: a Mac Catalyst
program can load `Home.framework` and run the Home app's own color code,
and Siri's color names are a table in `HomeAutomationInternal.framework`.

**The Home app** writes a color as Hue and Saturation only, or as
ColorTemperature only, never with Brightness or On
(`-[HFColorControlItem characteristicValuesForValue:]`):

- A color with a temperature goes to ColorTemperature when the light has
  that characteristic, and is otherwise converted to Hue and Saturation
  by `HFGetColorForLightTemperature`, rounded to the characteristics'
  steps. The Temperature tab is shown either way. Its wheel spans 2400 K
  to 10000 K, or the range of the ColorTemperature characteristic.
- That conversion is a closed form. With `k` in kelvins, each of red,
  green, and blue is `a + b / (k + c)` limited to 0–1, with one set of
  constants at or below 6500 K and another above; hue and saturation
  follow from the usual RGB to HSB conversion. 370 mireds is hue 29.9,
  saturation 66.5. HAP-NodeJS's
  `ColorUtils.colorTemperatureToHueAndSaturation` is a different table,
  which gives (27, 42) for 370 mireds.
- The six default swatches of the color palette are, as hue and
  saturation, (222, 20), (251, 5), (28, 23), (30, 48), (30, 67), and
  (255, 68). The first five lie on the temperature curve, at 101, 142,
  211, 293, and 372 mireds. The third is also tagged 366 mireds, which
  is what a light with ColorTemperature is sent for it.
- A light with all three characteristics is shown as a color only while
  its ColorTemperature is the characteristic's minimum
  (`valueForCharacteristicValues:`); at any other value it is shown as a
  temperature.
- Hue=228, Saturation=56 was seen once for a "white" swatch. It is not
  in the default palettes and may have been a saved favorite.

**Siri** resolves a color name to hue, saturation, and brightness and
has homed write those. It never writes ColorTemperature to a light that
lacks it. Seen through the Siri AI app of macOS 27.2.1 against a light
with Hue and Saturation only:

| Request                                                    | Write                               |
| ---------------------------------------------------------- | ----------------------------------- |
| white, neutral white, natural white, pure white, off white | Hue 0, Saturation 0, Brightness 100 |
| bright white                                               | Hue 0, Saturation 0, Brightness 100 |
| soft white                                                 | Hue 0, Saturation 0, Brightness 78  |
| warm white                                                 | Hue 31, Saturation 33               |
| cool white                                                 | Hue 208, Saturation 17              |
| candle, candlelight                                        | Hue 30, Saturation 84               |
| halogen                                                    | Hue 33, Saturation 12               |
| daylight                                                   | On false                            |
| 2700 kelvin, 4000 kelvin, 6500 kelvin                      | Brightness 100                      |

Every color write also carries On true. Another device answered "cool
white" with "didn't respond" and wrote only Brightness 100, as a kelvin
request does here, so the names vary between Siri versions. Hue has no
meaning at zero saturation, so Hoboken reads zero saturation as white at
any hue, and when Saturation arrives without Hue.

### Z2M color_mode behavior

- Z2M does not support bare `{ color_mode: "color_temp" }` set commands —
  an actual `color_temp` value is required to switch modes.
- Z2M preserves per-mode state: switching from HS (green) to CT (2700K)
  and back restores the green. The `color_mode` field indicates which
  values are authoritative.
- Z2M reports `color_mode` as one of `"color_temp"`, `"hs"`, or `"xy"`.
  Both `"hs"` and `"xy"` indicate a non-CT color mode; the device's
  native color space determines which one Z2M reports.
- In `"hs"` or `"xy"` mode the reported `color_temp` is not the bulb's
  white setting. With `color_sync` on, which is the default, Z2M replaces
  it with a value computed from the color: hue and saturation to RGB to
  CIE xy, then McCamy's formula, `n = (x − 0.332) / (0.1858 − y)` and
  `K = |437n³ + 3601n² + 6861n + 5517|`
  (`syncColorState` in zigbee-herdsman-converters `src/lib/color.ts`).
  The formula fits colors near white. For a saturated color the result is
  arbitrary: blue (240, 100) gives 574 mireds, about 1740 K, and magenta
  (300, 100) gives 50. Z2M clamps the value only when it knows the bulb's
  range.

### Hoboken's approach

For `color_hs` devices, when HomeKit asks for a white, `homeKitToZ2m`
converts the write to `color_temp`. This causes Z2M to switch to CT mode
so the bulb uses its WW/CW LEDs instead of mixing RGB to approximate
white. Siri's three whites get the temperatures of Z2M's `cool`,
`neutral`, and `warm` presets, and any other hue and saturation on the
Home app's temperature curve gets the temperature it stands for:

| Request                        | Hue          | Sat | `color_temp`                      |
| ------------------------------ | ------------ | --- | --------------------------------- |
| Siri "white"                   | any          | 0   | `whiteColorTemp`, or 370 (2700 K) |
| Home app white swatch          | 228          | 56  | `whiteColorTemp`, or 370 (2700 K) |
| Siri "warm white"              | 31           | 33  | 454 (2200 K)                      |
| Siri "cool white"              | 208          | 17  | 250 (4000 K)                      |
| Home app temperature or swatch | on the curve |     | the curve's, from 140 to 500      |

`hueSaturationToColorTemp` finds the nearest point of the curve from 100
to 500 mireds, treating hue and saturation as polar coordinates, because
hue is an angle and means little at low saturation. It accepts a
distance of up to 1. Rounding a point of the curve to a whole hue and
saturation moves it at most 0.88, and a rounded point gives back its
temperature to within 3.2 mireds. Saturated colors are far outside:
(30, 100) is 9.5 away. A color within 1 of the curve is always read as a
temperature, so a deliberate (29, 91) becomes 500 mireds.

The temperature is never the `color_temp` in the state cache, because
that value follows the last color, as described above. Reusing it made
"white" after blue the warmest setting the bulb has.

A request is converted only for a device that has white LEDs: one with
`whiteColorTemp`, one with the `color_temp` capability, or one whose state
cache contains a `color_temp` value. RGB-only devices never report
`color_temp` in their state, so these requests pass through as normal HS
writes for those devices. A device with `whiteColorTemp` or the
`color_temp` capability is converted even before its first state report.

A write that carries `ColorTemperature` as well as Hue or Saturation
publishes only `color_temp`, as Home Assistant does, because Z2M would
send the bulb one command for each and the last would win. The exception
is a write of 140 mireds with both Hue and Saturation: that is what a
light showing a color reports, so a controller that writes a light's
state back, as a scene does, means the color.

On the read path, `z2mToHomeKit` reports only the fields of the active
`color_mode`, as homebridge-z2m does. In `"color_temp"` mode it reports
the temperature, and for Hue and Saturation the Home app's own color for
it (`colorTempToHueSaturation`): (30, 67) for 370 mireds, where Z2M
reports (32, 82). A controller that writes those two back, as a scene
does, then gets the same temperature again. In `"hs"` or `"xy"` mode it
reports the color and 140 mireds, the minimum, which is how the Home app
tells that the light shows a color. A light without `color_hs` has no
color to show and keeps its last temperature instead. A light that is
really at 140 mireds is therefore shown as a color; the minimum cannot
mean both. A state without `color_mode` passes through unchanged. An update is read against the merged state, so one
that carries only `color_mode` still switches what HomeKit shows.

The state report that follows a write is suppressed, as described below,
so after publishing a write the bridge sets the characteristics that the
write implies and did not itself set (`z2mWriteToHomeKit`): Hue and
Saturation after a ColorTemperature write, ColorTemperature after a
color or a white. The ones the controller wrote keep its values.
`updateAccessoryState` sets Hue and Saturation before `ColorTemperature`;
Home Assistant's bridge notes that iOS otherwise shows the wrong color.

Each HAP write request is logged as it arrives, and each published write
is logged with its payload, so the log shows which values a controller
sent for a request and what became of them. A value that HAP-NodeJS
refuses for being out of range appears only in the first line.

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

| Project              | Suppresses? | Mechanism                                 | Window       | Scope          |
| -------------------- | ----------- | ----------------------------------------- | ------------ | -------------- |
| homebridge-hue       | **Yes**     | `recentlyUpdated` flag + `setTimeout`     | 500ms        | bri, ct, xy    |
| homebridge-deconz    | **Yes**     | `recentlyUpdated` flag + `await timeout`  | 500ms        | bri, ct, xy    |
| homebridge-mqttthing | Partial     | Optional `debounceRecvms` (unconditional) | configurable | all properties |
| homebridge-z2m       | No          | —                                         | —            | —              |
| Home Assistant       | No          | pyhap value-changed dedup only            | —            | —              |

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

### Other named whites

Siri's table has whites that are neither on the Home app's curve nor
mapped here, such as halogen (33, 12) and antique white (34, 14). They
are published as colors.

### WLED white channel

A WLED white request publishes RGB (255, 255, 255). Whether an RGBW strip
lights its white LEDs for that is decided by the strip's Auto White
setting, which is not visible over MQTT: "Accurate" lights the white
channel alone, "Brighter", "Dual", and "Max" light all four channels, and
"None" mixes RGB. Publishing white alone, `[0, 0, 0, 255]`, would be right
for "None" and "Dual" and would turn the strip off in the other modes and
on an RGB strip, so it would need a per-device option.

## WLED White Segments

WLED knows nothing about the color temperature of a white LED. On an RGBW
output it sees four channels, and its own CCT support assumes a nominal
range rather than the strips fitted. A fixture can still be built for
tunable white: an RGB strip on one segment for color, and on other
segments a four-channel driver whose channels each feed a white strip,
some warm and some cool. With Auto White off, each channel's value is
that strip's level.

A device describes this with `colorSegments`, `whiteSegments`, and
`whiteChannels`, the color temperature in kelvins of the strip on each of
`r`, `g`, `b`, and `w`, which must be two temperatures in all. It may
then have `color_temp`, and its `ColorTemperature` spans the two strips
in whole mireds: 182 to 416 for 5500 K and 2400 K. That range must lie
within 140 to 500, HomeKit's, because the rest of the bridge limits
`ColorTemperature` to it.

- **A temperature** lights the white segments and darkens the color
  segments. Along the range the two strips cross-fade in mireds, the unit
  in which two whites mix about linearly, with both full on at the
  midpoint: from the warm end the cool strips rise to full at the middle,
  and from there the warm strips fall to nothing. So the light is twice
  as bright in the middle as at either end, and each end is one strip
  alone. A request outside the range gets the nearer end.
- **A color** lights the color segments and darkens the white segments.
- **A white by name**, or a hue and saturation on the Home app's curve,
  is a temperature as for Zigbee2MQTT, and `whiteColorTemp` applies.
- **Gamma**: WLED raises a channel's value to its color gamma before
  output, so 128 is about a fifth of full with the usual 2.2. `gamma`
  tells the bridge that setting, and it sends `level ** (1 / gamma)`.
  Without it the values themselves cross-fade linearly.

Each write addresses segments by `id` and also sets `sel`, because WLED
reports the primary color of the first selected segment on `<topic>/c`
and nothing about the others. A reported color with a lit white channel
is a white, and its temperature follows from the two strips' levels. A
white with only the cool strips lit has no white channel (5500 K is
`[255, 0, 255, 0]` when cool is on `r` and `b`) and cannot be told from
magenta on the color strip, so the bridge keeps the white that it last
wrote, as `white` in the cached state, and reads that same color reported
back as the white. Any other color without a white channel is a color, so
cool strips alone set in WLED itself read as magenta.

Segments in neither list are left alone. A selected one with a lower id than
the listed segments that are lit is the first selected segment, so its color
is the one WLED reports and the bridge reads; it has to be deselected in
WLED.
