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
Saturation, or ColorTemperature. Siri's white is the exception, as the next
section describes; "warm white", the Home app's white swatch, and any other
color or temperature still turn it off. The Home app has no switch for
Adaptive Lighting: choosing a color or temperature there is how it is turned
off, and it writes Hue and Saturation, or ColorTemperature, as Siri does.

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

## Siri's white

Siri's "white", "bright white", "soft white", and the rest write Hue 0 and
Saturation 0 in one request (`isSiriWhite`), with a Brightness and On. The
center of the Home app's color wheel writes the same Hue and Saturation, so it
is Siri's white too. On a
light with Adaptive Lighting and `color_hs`, that white means Adaptive
Lighting. A light with `color_temp` alone has no Hue or Saturation, so Siri's
white reaches it only as the Brightness, and a write of a temperature turns
Adaptive Lighting off.

- **While Adaptive Lighting is on,** the write is published with the
  temperature that it last set (`withAdaptiveWhite`), even to a light that
  reports that temperature already: a light with white strips reports a color
  as its minimum temperature, which Adaptive Lighting reaches at midday on a
  narrow range. Hue and Saturation are dropped from the message. The
  controller then sets the temperature for the written Brightness, which
  takes its value only after the write is published, so a light at another
  brightness fades to that temperature over the next 5 s.
- **Keeping it on.** HAP-NodeJS turns Adaptive Lighting off from a `change`
  listener on Hue and Saturation, which it adds each time Adaptive Lighting
  goes on, and it skips a change whose context names the controller.
  `createLightAccessory` adds listeners of its own when it creates the
  accessory, which therefore run first, and when the white is published it
  marks the next change of each to 0 as the controller's. The change object is
  shared by the listeners and copied before notifications are built, so this
  changes nothing that controllers are told.
- **After a color or temperature,** which turned Adaptive Lighting off, the
  white turns it back on from the light's last schedule from the home hub, and
  then keeps it on as above. HAP-NodeJS erases the schedule when Adaptive
  Lighting goes off, so the bridge keeps its own copy (`controller.serialize()`)
  in the HAP storage directory, one file per light named
  `hoboken.adaptive-lighting.<accessory UUID>`, which survives a restart. The
  copy is taken whenever the controller sets a temperature from a schedule
  that it has not seen, and a copy that cannot be written is logged as an
  error while Adaptive Lighting goes on without it. The log says
  `Adaptive Lighting schedule for … from the home hub` for each new one and
  `Adaptive Lighting restored for …` when a white restores it.
- **Restoring.** HAP-NodeJS starts any schedule written to TransitionControl
  at its first entry, so the bridge writes the saved schedule rotated to the
  present (`restoredTransition`): the hub's schedules are the same every day by
  the local clock and end, after 24 hours, where they start, so the rotated
  curve starts at the point where the saved schedule's own clock is now and
  runs a full day back to it. A schedule that is not such a loop is not
  restored. The write goes through the public path, so HAP-NodeJS notifies
  ActiveTransitionCount 1 and persists the transition as if the hub had sent
  it, and the temperature that the controller sets at once is the white's,
  published in the same message. The rotated schedule is never saved over the
  hub's: the saved copy records the start of the one that the bridge made. A
  daylight saving change makes a restored schedule an hour off until the hub
  replaces it.
- **The hub.** The schedule keeps the hub's transition id and the controller
  context, in which the hub marks its own schedules, and starts at the present.
  The change in ActiveTransitionCount makes the hub read TransitionControl, so
  the Home app shows Adaptive Lighting on, and a start time that disagrees with
  the context should make the hub write a fresh schedule of its own, which is
  saved in turn. This comes from reading the hub's code. A live hub has
  restored Adaptive Lighting after a color from Siri and after one from the
  Home app, and sent no schedule of its own in the next 20 minutes; whether
  it replaces a restored schedule before its 24 hours run out has not been
  seen.
- **An end.** Adaptive Lighting going off for any reason other than a
  HomeKit write of Hue, Saturation, or ColorTemperature, a color that the
  light shows, or a scene recalled through the bridge, is the hub's own stop,
  a write to TransitionControl of its instance id alone, or the end of the
  schedule. The bridge then forgets the saved schedule and logs
  `Adaptive Lighting for … ended; white is fixed until the home hub starts it
again`, and white is a fixed white until the hub sends a schedule again, as
  it does when Adaptive Lighting is chosen in the Home app. A restored
  schedule that the hub does not replace ends after 24 hours in the same way.
- **Without a schedule,** a light that has never had one, or whose saved
  schedule is unreadable, which is logged as an error, gets the fixed white of
  [color-coalescing.md](color-coalescing.md#hobokens-approach), and Adaptive
  Lighting stays off. So does a restore that HAP-NodeJS refuses, which is
  logged as an error too.

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
That first temperature is remembered and not published. The bridge's copy of
each light's last schedule from the hub, for [Siri's white](#siris-white), is
kept in the same directory.

Shutdown never calls `disableAdaptiveLighting` or `removeController`, because
both erase the persisted transition. `process.exit` ends the schedule's timer.
