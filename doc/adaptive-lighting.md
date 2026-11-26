# Adaptive Lighting

A light with the `brightness` and `color_temp` capabilities, Zigbee2MQTT or
WLED, gets HAP-NodeJS's `AdaptiveLightingController` in automatic mode
(`hasAdaptiveLighting`), so the Home app offers Adaptive Lighting for it and a
home hub's schedule sets its temperature through the day.

The controller sets ColorTemperature through `onSet`, with a context naming
itself, about once a minute and whenever Brightness changes. It does so
whether or not the light is on or the temperature is new, and it cannot see a
change made outside HomeKit. The bridge supplies the rest.

## The hub's schedule

The home hub never sends a temperature. It writes a 24-hour schedule to the
light over the TransitionControl characteristic, and the light computes the
temperature from it. Brightness is an input and is never changed.

The schedule comes from a fixed table, `NaturalLightingCurve.plist` in
HomeKitDaemon.framework ("Natural Lighting" is Apple's internal name),
transcribed in
[tools/apple-home/natural-lighting-curve.tsv](../tools/apple-home/natural-lighting-curve.tsv).
It gives a kelvin value at 10% and at 100% brightness for 00:00, 02:30, and
every half hour after that, in local clock time:

| Local time  | 10%         | 100%        |
| ----------- | ----------- | ----------- |
| 00:00–02:30 | 2000 K      | 2250 K      |
| 06:00       | 2371 K      | 2423 K      |
| 08:00       | 2683 K      | 2933 K      |
| 10:00       | 2945 K      | 4451 K      |
| 11:30–14:30 | 2999–3002 K | 4945–4966 K |
| 16:00       | 2940 K      | 4482 K      |
| 18:00       | 2700 K      | 3465 K      |
| 20:00       | 2233 K      | 2650 K      |
| 21:30–24:00 | 2000–2011 K | 2250–2400 K |

Neither the location, the date, nor the sun enters. By the local clock, the
schedule is the same every day of the year, everywhere.

For each time in the table, the hub takes `trunc(1e6 / K)` mireds at each
brightness, clamps both to the light's ColorTemperature range (a light whose
range misses the table's 201 to 500 mireds gets no schedule), and sends the
line through them as a float32 base and factor: `factor = (m100 − m10) / 90`
and `base = m10 − 10 × factor`. The schedule starts at the current clock time
in the home's time zone, in whole seconds, with a point interpolated between
the times around it, and wraps around midnight back to that point. The hub
reads the hour, minute, and second off the clock, so a change to or from
daylight saving time moves the schedule with the clock. A point whose rounded
temperatures at 10% and 100% equal the previous point's becomes a hold on the
previous one, except the last point, which always stays a point of its own.
The schedule also carries the brightness range 10 to 100, an update interval
of 60 s, and a notification interval of 10 minutes.

The light interpolates base and factor linearly in time and sets
`round(base + factor × clamp(brightness, 10, 100))` mireds, clamped to its
range. At a fixed brightness the temperature is piecewise linear in mireds,
not kelvin, between the times in the schedule, and at a fixed time it is
linear in brightness from 10% to 100% and constant outside that range.
Brighter is never warmer.

The bridge stores each schedule in `ControllerStorage.<username>.json` under
its HAP storage path. On 2026-11-25 the hub sent this home's six lights
schedules that started 2.4 hours apart, and
`tools/apple-home/natural-lighting-schedule.ts` reproduces all six exactly.
One is shorter because its light stops at 416 mireds, which turns eight hours
of the night into a single hold.

## What is published

The `adaptiveTemperature` hook from `startBridge` remembers each temperature
and accepts it for publishing only while MQTT is connected and the light is on
at another temperature (`shouldPublishAdaptiveTemperature`). A WLED light is
also accepted while it is known to be off: the message has no `on` and no
`bri`, so WLED stores the color and the light stays off.

A Zigbee2MQTT light, a single bulb or a group, that is known to be off is sent
a raw cluster command instead, to its normal set topic, because a Hue bulb
ignores `color_temp` while off and some bulbs turn on for it:
`moveToColorTemp` with `optionsMask` and `optionsOverride` 1 ("execute if
off"), which stores the temperature and leaves the light off
(`zigbeeOffTemperatureMessage`). Zigbee2MQTT does not reflect the command in
its state, so no report follows, nothing is recorded as an unconfirmed write,
and the cached temperature stays as it was. The bridge remembers the
temperature sent, per device, and does not send it again while the light stays
off and untouched. A report that shows the light on, and any other publish for
the device, forget it, so a light that goes off again is sent the temperature
at the next update. A light of unknown power is sent nothing, and so is one
when MQTT is disconnected. No report confirms that a given bulb, or a group's
cast, honors the flag. The command carries the temperature as asked, because
Zigbee2MQTT clamps `color_temp` to a bulb's range but not a raw command, and a
bulb may clamp or refuse one beyond its range.

The turn-on sends below remain: they cover a bulb that ignores the flag or a
lost group cast, and they bring Zigbee2MQTT's state in step.

The comparison is with the cached device state, not a record of what was last
published, which goes stale across a turn-off or an outside change. The power
and temperature just written (`writtenState`) stand in for the cache, which the
device has not yet had time to correct, until a report changes the device's
power (for the power) or its color group (for the temperature), or 2000 ms
pass. They are the overlay of the unconfirmed writes of
[write confirmation](color-coalescing.md#write-confirmation), so their lifetime
is the one that decides which reports are applied.

A write that turns the light on and sets no color or temperature carries the
remembered temperature while Adaptive Lighting is active
(`withAdaptiveTemperature`). A write turns on a light that is not on (the cache
overlaid with the unconfirmed writes; unknown counts as off) when it has
`on: true`, or has no `on` and a brightness above zero, because Zigbee2MQTT and
WLED turn a light on for a brightness. A write to a light that is already on
gets none, because the light has it and a change of Brightness brings a new
one. In `writtenState` a brightness above zero without `on` counts as power on, so
that the temperature recomputed for the new Brightness is accepted, and a
brightness of zero as power off, so that none is sent to a light that is going
off.

A bulb whose range is narrower than 140 to 500 mireds clamps a temperature to
its limit, so the cache never shows the one asked for. The bridge keeps, per
device, the last temperature that it published and what the light showed when
that temperature was asked for again, and does not publish it a third time
while the light shows that same value. A lost command is retried once the same
way; a different temperature, or a different value shown, starts over, and so
does a light whose cached state shows the temperature, so that a change
outside HomeKit to the same value is corrected every time. A color or
temperature that HomeKit writes starts over too.

A temperature that the controller sets on a Zigbee2MQTT light that is on, a
single bulb or a group, is published with `"transition": 5` (seconds,
`ADAPTIVE_TRANSITION_SECONDS`), so that the light fades to it. This covers the
controller's updates and the temperature recomputed for a brightness, which
after a change at a switch arrives 10 s late and would otherwise step the
color visibly. The transition is added to the message only, so the
characteristic values are those of the temperature alone. Not faded, so that
the light is right at once: the remembered temperature that a report from
outside sends when it turns a light on, the temperature that a write turning
a light on carries, one that the controller sets before the light has
reported that it is on (a light turned on at another brightness gets the
temperature for it right after the write), any color or temperature that
HomeKit writes, a scene recall, the command for a light that is off (its
`transtime` is 0), and every WLED message. Zigbee2MQTT reports the new
temperature when it sends the command, not when the fade ends, so the write
is confirmed as any other is.

The log line for a publish that carries only Adaptive Lighting's temperature
begins `Adaptive Lighting for`, not `HomeKit write for`.

## A light changed outside HomeKit

A switch or the Zigbee2MQTT app can turn a light on or change its brightness.
Applying such a report to HomeKit makes the controller recompute the
temperature.

- **Turned on.** When a report that the bridge applies turns the On
  characteristic from off to on while Adaptive Lighting is active, the bridge
  publishes the remembered temperature at once, as Adaptive Lighting's, if the
  rule above would publish it: nothing is sent when the light already shows
  that temperature. A report that confirms a turn-on that HomeKit wrote finds
  the characteristic on already and sends nothing, and neither does undoing a
  turn-off that no report confirmed. A bridge that restarts finds the
  characteristic off, so the first report of a light that is on counts as a
  turn-on.
- **Brightness.** A Zigbee2MQTT light's reported brightness is held until it
  has stood for 10 s (`BRIGHTNESS_SETTLE_MS`), with or without Adaptive
  Lighting; see [Reported brightness is held](color-coalescing.md#reported-brightness-is-held).
  The Brightness characteristic changes only then, so the controller recomputes
  the temperature once, for a brightness that stood, and the hook accepts it
  under the rule above. A group that a switch turns on reports full
  brightness, then 12% fourteen ms later, then full again 5.2 s later, and
  the light is sent no temperature for the 12%. A brightness set at a switch
  changes the temperature 10 s late.
- A Brightness that HomeKit writes drops the held one, and the temperature
  recomputed for it is accepted at once. A WLED light's reported brightness is
  not held: it reports brightness 0 while off and its real brightness once on,
  and the temperature for that follows at once. Turning Adaptive Lighting off
  does not release a held brightness, which HomeKit shows when it has stood,
  and shutting down drops it.

## A color or temperature in the same request

A color or temperature that HomeKit writes wins over the temperature that the
controller recomputes for a Brightness in the same request, such as Siri's
"red at 30%". The coalescer drops the recomputed one when they share a tick.

Under HAP-NodeJS they do not share one. It handles a request in a `nextTick`
callback, so the request's writes flush before their changes reach the
controller, and the recomputed temperature arrives in a flush of its own.
`createLightAccessory` drops that flush unless the controller is still active.
A test of this must start its writes inside `process.nextTick`.

## What turns it off

HAP-NodeJS turns Adaptive Lighting off when a controller writes Hue,
Saturation, or ColorTemperature, which includes Siri's "white".

A report that reaches HomeKit turns it off when it shows a color
(`showsColor`), so that a color set in the Hue app or in WLED is not
overwritten a minute later. A report that repeats the color that the light
showed before a write is not applied, so it does not turn it off. A color is a
`color_temp` at the minimum without the hue and saturation that the Home app's
curve gives the minimum, which a white there has. The schedule clamps to the
minimum at midday on a light with a narrow range.

A WLED light with white strips reports the white at its end without a lit w
channel as a color at the minimum, which only the bridge's memory of writing it
tells apart (`wledColorToHomeKit`). After a restart there is none, so
`showsColor` also accepts the hue and saturation of that pattern
(`wledUnrememberedWhite`). A color of exactly that hue and saturation set
outside HomeKit then does not turn Adaptive Lighting off.

Recalling a scene through the bridge turns it off for the scene's device, as
the scene sets its own temperature. A scene on a Zigbee2MQTT group does not
reach lights that are configured as devices of their own.

A temperature changed elsewhere does not turn it off, and neither do the
bridge's own `updateValue` calls.

## Hue and Saturation

Before it sets a temperature, the controller sets Hue and Saturation from
HAP-NodeJS's table, without a notification, and expects the accessory's update
to bring the same values and so notify no one. The bridge's updates use the
Home app's curve, which differs, so each published temperature would notify
every connected controller of both. `setCurveColor` replaces the table's values
with the curve's, also without a notification. The controller's own
notifications, at the interval the hub sets, carry the table's values, and the
bridge's next update corrects them.

## Restarts

HAP-NodeJS persists the transition in `ControllerStorage` under the HAP
storage path and restores it when the bridge publishes, before MQTT connects.
That first temperature is remembered and not published.

Shutdown never calls `disableAdaptiveLighting` or `removeController`, because
both erase the persisted transition. `process.exit` ends the schedule's timer.
