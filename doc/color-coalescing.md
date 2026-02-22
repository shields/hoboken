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

## Color Mode Semantics

Z2M always reports **both** `color_temp` and `color` values in state
updates, regardless of which mode is active. The `color_mode` field
indicates which values are current; the others are stale.

```json
{
  "color_mode": "color_temp",
  "color_temp": 250,
  "color": { "hue": 27, "saturation": 21 }
}
```

Here `color_temp: 250` is the real value; the `color` object contains
Z2M's rough conversion of 250 mireds to HS, which doesn't round-trip
cleanly and causes unnecessary HomeKit updates.

### Strategy

When a device has **both** `color_temp` and `color_hs` capabilities:

| `color_mode` | CT handling | H/S handling |
|---|---|---|
| `"color_temp"` | Push CT value. Convert to H/S via `ColorUtils.colorTemperatureToHueAndSaturation` and push. | Suppress raw Z2M color (stale). |
| `"hs"` | Suppress (stale). | Push H/S values. |
| `undefined` | Push as-is. | Push as-is. |

For single-capability devices (only `color_temp` or only `color_hs`),
`color_mode` is ignored — there's no conflict to resolve.

### Why convert CT→H/S instead of suppressing both

HAP has no concept of "color mode". If a device is in CT mode and we
suppress the H/S characteristics, the Home app shows stale hue/saturation
values. By converting via `ColorUtils.colorTemperatureToHueAndSaturation`,
the H/S values stay consistent with the displayed color temperature.

### `ColorUtils` reference

`ColorUtils.colorTemperatureToHueAndSaturation(mireds)` is exported from
`@homebridge/hap-nodejs`. It returns `{ saturation: number, hue: number }`
representing the approximate HS equivalent of a color temperature.

## Outgoing Color Mode

No write-side changes are needed. Z2M infers color mode from the payload:
- `{ color_temp: 250 }` → CT mode
- `{ color: { hue: 120, saturation: 100 } }` → HS mode

The coalescing publisher naturally groups these correctly.
