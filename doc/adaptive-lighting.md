# Adaptive Lighting

A light with the `brightness` and `color_temp` capabilities, Zigbee2MQTT or
WLED, gets HAP-NodeJS's `AdaptiveLightingController` in automatic mode
(`hasAdaptiveLighting`), so the Home app offers Adaptive Lighting for it and a
home hub's schedule sets its temperature through the day.

The controller sets ColorTemperature through `onSet`, with a context naming
itself, about once a minute and whenever Brightness changes. It does so
whether or not the light is on or the temperature is new, and it cannot see a
change made outside HomeKit. The bridge supplies the rest.

## What is published

The `adaptiveTemperature` hook from `startBridge` remembers each temperature
and accepts it for publishing only while MQTT is connected and the light is on
at another temperature (`shouldPublishAdaptiveTemperature`). A light that is
off gets nothing, because a Hue bulb ignores `color_temp` while off and some
bulbs turn on for it.

The comparison is with the cached device state, not a record of what was last
published, which goes stale across a turn-off or an outside change. The power
and temperature just written (`writtenState`) stand in for the cache, which the
device has not yet had time to correct, each for 500 ms after the write that set
it.

A write that turns the light on and sets no color or temperature carries the
remembered temperature while Adaptive Lighting is active
(`withAdaptiveTemperature`). A write turns on a light that is not on (the cache
overlaid with the write-back window; unknown counts as off) when it has
`on: true`, or has no `on` and a brightness above zero, because Zigbee2MQTT and
WLED turn a light on for a brightness. A write to a light that is already on
gets none, because the light has it and a change of Brightness brings a new
one. In `writtenState` a brightness above zero without `on` counts as power on, so
that the temperature recomputed for the new Brightness is accepted, and a
brightness of zero as power off, so that none is sent to a light that is going
off. A light turned on outside HomeKit waits for the next
update.

A bulb whose range is narrower than 140 to 500 mireds clamps a temperature to
its limit, so the cache never shows the one asked for. The bridge keeps, per
device, the last temperature that it published and what the light showed when
that temperature was asked for again, and does not publish it a third time
while the light shows that same value. A lost command is retried once the same
way; a different temperature, or a different value shown, starts over, and so
does a light whose cached state shows the temperature, so that a change
outside HomeKit to the same value is corrected every time. A color or
temperature that HomeKit writes starts over too.

The log line for a publish that carries only Adaptive Lighting's temperature
begins `Adaptive Lighting for`, not `HomeKit write for`.

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

`handleStateUpdate` turns it off when a report outside the suppression window
shows a color (`showsColor`), so that a color set in the Hue app or in WLED is
not overwritten a minute later. A color is a `color_temp` at the minimum
without the hue and saturation that the Home app's curve gives the minimum,
which a white there has. The schedule clamps to the minimum at midday on a
light with a narrow range.

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
