# Tucson Heated Bedding and Curtains

Configuration and behavior of the heated bedding and curtain accessories.
[Tucson](https://github.com/shields/tucson) is a separate service that owns the
device connections and publishes each device over MQTT; Hoboken uses only
those topics. The [README](../README.md#heated-bedding) has example entries.

## Heated bedding

### Configuration

Each `heatedBedding` entry has `name`, `prefix`, `controller`, and exactly one
of `zone` and `zones`; any other field fails startup. Match these logical names
to Tucson's configuration. Tucson owns controller credentials, protocol
versions, and device connections. A bridge with only heated bedding can omit
`devices` or set it to `[]`.

The prefix, controller, and zone follow Tucson's grammar for lowercase
identifiers. `bridge` is reserved as a controller name and `availability` as a
zone name. Heated bedding and curtain routes cannot overlap device topics or
each other, and wildcard device topics cannot accompany either. A curtain owns
its controller's topic, so a controller that has both heated bedding and a
curtain overlaps on its availability route.

Entry identities must be unique even across prefixes, because they determine
accessory identities; a single zone's identity is its controller and zone.
Display names and prefixes can change without changing those identities.

An entry with `zones` controls several zones of one controller as a group. A
group lists at least two distinct zones. It can sit beside the entries for its
own zones, and shares their connection and per-zone writes. A group's identity
comes from its controller and its set of zones, so reordering the zones,
renaming the group, or changing the prefix keeps its accessories, and it never
matches the identity of a single zone. Two groups over the same zones are
duplicates; groups that merely share a zone are allowed. A controller/zone pair
must use one prefix everywhere it appears.

### Fan and preheat

The fan's Active control changes power. RotationSpeed zero turns power off
and preserves the selected level; positive values select levels 1–10 in
10% steps. The reported speed retains that selected level while power is
off. An explicit off takes precedence over other fan writes arriving in
the same 50 ms window. Preheat follows its reported Boolean until the
controller changes it.

### Groups

A group's fan is on while any of its zones is on. Its speed is the highest
level among the zones that are on, or the highest stored level while all are
off. Active on powers on each zone that is off, and each resumes its own stored
level; a zone that is already on is left alone. Active off powers off every
zone and preserves their levels. A positive RotationSpeed sets every zone to
that level, which turns it on, and zero powers off every zone and preserves
their levels. An explicit off takes precedence over other fan writes in the
same 50 ms window, including writes to a zone's own fan. The preheat switch is
on while any zone preheats; turning it on preheats every zone and turning it
off cancels preheat on every zone.

A group write goes to each zone through the same confirmed path as that zone's
own accessory, so writes to the group and to a zone's accessory that are in
flight together stay consistent. The write succeeds only when every zone's
command is confirmed, and it returns the group's state as it is when the last
zone settles, including any change a zone's own accessory made in between.
Otherwise it returns the HomeKit error that the first failing zone, in the
order listed, returned, and the bridge logs a `group_write_failed` event for
each failing zone. Zones whose commands were confirmed keep their change. A
group is unavailable ("No Response") while any of its zones is, and refuses
writes without sending any command. A zone that becomes unavailable after it
confirmed, before the last zone settles, fails the write with a communication
failure and is logged the same way.

The status page lists a group as the states of its zones, and the
`hoboken_devices_state_unknown` metric counts a group once, as unknown if any of
its zones is.

### Auto-off

A fan write that powers a zone on also sets its auto-off timer to six hours,
because the controller returns the timer to 10 hours whenever the zone turns
off. The timer is left out only while the zone reports power on and no
power-off is in flight. A power-on still in flight can fail, so a write that
follows one carries the timer too. A write to a zone that is already on sends
no timer, because the controller restarts the countdown whenever the timer is
written, even with the same value; power and level writes leave it running.
Preheat is sent alone, so a preheat that turns a zone on leaves the
controller's 10-hour default.

### Writes and reconnection

Writes wait for a confirmed command result and reported state that matches
it. Once a newer write to the same zone has been sent, the confirmed result
alone suffices, and the write returns the current reported state. Failed or
expired writes return a HomeKit error and retain reported
values. MQTT reconnection cancels pending writes and requires current
subscriptions, a fresh session heartbeat, online availability, and known
state. Commands are never replayed after reconnection. An invalid heated
bedding message tears down the whole heated bedding connection, which
reconnects with backoff, so that every zone starts over from a clean session.

### Qualification

Physical side mapping and controller compatibility still require hardware
qualification. Actual Home app and Siri testing remains part of that
qualification.

## Curtains

Each `curtains` entry has `name`, `prefix`, and `controller`, and uses the same
logical topic naming rules as `heatedBedding`; routes must not overlap. A
curtain-only bridge may omit `devices` or set it to `[]`. A curtain is a
single-endpoint controller, so its state is on `<prefix>/<controller>` and its
commands, results, and availability are under it, without a zone. Zones are
Sunbeam's term and apply only to heated bedding, so a `zone` or `zones` key on
a curtain is an unknown field. A controller name identifies the accessory, so
it is unique across prefixes, and `bridge` and `availability` are reserved. No
Tuya credentials belong in Hoboken.

Set `TargetPosition` from zero (closed) to 100 (open). `CurrentPosition` comes
from device reports. `PositionState` uses reported motion when available and
otherwise compares reported current and target positions. This inference
cannot detect a motor stalled away from its target. Start/stop controls and
HomeKit `HoldPosition` are not exposed.

Target writes complete after Tucson confirms device acceptance, before the
curtain necessarily finishes moving. Missing positions, stale sessions, or
unavailable controllers produce "No Response." The status page displays
reported state and pending callers.

Tucson's `zemismart-bcd300fb` profile supports the Zemismart BCD300FB Wi-Fi
curtain motor; other Zemismart models are not implied to be compatible. That
motor reports neither motion nor its position during a move, so
`CurrentPosition` stays at the last reported position and jumps when the motor
reports arrival, and a Tucson reconnection during a move starts over from the
last reported position
([details](https://github.com/shields/tucson/blob/main/docs/setup.md#zemismart-bcd300fb)).
Tucson's
[curtain contract](https://github.com/shields/tucson/blob/main/docs/implementation-plan.md#curtain-infrastructure)
defines the MQTT interface. `make homekit` in Tucson exercises the synthetic
curtain profile through both bridges and paired HomeKit clients.
