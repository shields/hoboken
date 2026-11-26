# Apple Home probes

Programs that read how Apple's Home app and Siri choose colors, and how a
home hub schedules Adaptive Lighting, with the data they produced on macOS
27.2.1 (build 26B131, arm64e) on 2026-11-24 and 2026-11-25. The conclusions
are in [doc/color-coalescing.md](../../doc/color-coalescing.md) and
[doc/adaptive-lighting.md](../../doc/adaptive-lighting.md). The programs are
kept so that they can be rerun on a later macOS to see what changed.

**The Objective-C programs call Apple frameworks that are not public API**
(Home, HomeUI, and HomeAutomationInternal) and are not expected to keep
working. None is part of the build, the tests, or the Docker image, except
that `make lint` type-checks and lints `natural-lighting-schedule.ts`. None
talks to HomeKit, reads a home or an account, or opens a network connection:
the Objective-C programs build color objects in memory and call pure
functions.

## Building and running

Needs Xcode's command line tools and the macOS SDK. `build.sh` builds every
program into a directory outside the repository. Each program's standard
output should match its committed file. Apple's code logs to standard error;
ignore it.

```sh
cd tools/apple-home
bin=$TMPDIR/apple-home
./build.sh "$bin"
"$bin/siri-hue-table" | diff - siri-hue-table.tsv
"$bin/home-palettes" 2>/dev/null | diff - home-palettes.txt
for probe in writes readback limits wheels; do
  "$bin/home-color-$probe" 2>/dev/null | diff - "home-color-$probe.txt"
done
"$bin/home-temperature-curve" | grep -v '^#' | diff - home-temperature-curve.tsv
./natural-lighting-curve.sh | diff - natural-lighting-curve.tsv
```

The Home app's frameworks exist on macOS only as Mac Catalyst copies under
`/System/iOSSupport`, so the `home-*` programs are Catalyst executables.

## Programs and data

| Program                        | Output file                  | What it shows                                                                                 |
| ------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `siri-hue-table.m`             | `siri-hue-table.tsv`         | Siri's 712 named colors: name to hue, saturation, and brightness                              |
| `home-palettes.m`              | `home-palettes.txt`          | The Home app's default color and temperature swatches                                         |
| `home-color-writes.m`          | `home-color-writes.txt`      | What the Home app writes for each color, temperature, and swatch                              |
| `home-color-readback.m`        | `home-color-readback.txt`    | How it turns a light's Hue, Saturation, and ColorTemperature back into a color or temperature |
| `home-color-limits.m`          | `home-color-limits.txt`      | Which characteristics each write needs, and how values clamp and round                        |
| `home-color-wheels.m`          | `home-color-wheels.txt`      | What the color and temperature wheels write, and the temperature wheel's range                |
| `home-temperature-curve.m`     | `home-temperature-curve.tsv` | Apple's temperature-to-color curve, checked against the closed form in `src/convert.ts`       |
| `natural-lighting-curve.sh`    | `natural-lighting-curve.tsv` | The home hub's Adaptive Lighting table: kelvins at 10% and 100% brightness by time of day     |
| `natural-lighting-schedule.ts` |                              | The schedule that a hub writes to a light from that table                                     |

The `home-color-*.m` programs share `home-color-item.h`, which gives Apple's
`HFColorControlItem` stub characteristics so that its write and read-back
logic runs without a home.

### siri-hue-table

Siri's named colors: the `HueSemantic` enum from SiriOntology, as built by
HomeAutomationInternal.framework. The columns are the index in the array, the
`HueSemantic` key, the name, the hue in degrees, and the saturation and
brightness in percent. The framework stores doubles, which print rounded to
one decimal place.

No entry is a color temperature, and `warm white` and `cool white` are not
names in the table.

The table is not a copy of one published list. Compared with what it most
resembles:

- 662 of its 709 names are in Wikipedia's "List of colors" as of revision
  468783398 (2011-12-31), 660 with the same color within 1 unit, computed from
  the page's hex codes. The match is as good from about 2011-12 to 2012-02 and
  worse before and after. That revision has 85 names that the table lacks.
- 15 more match Wikipedia's "List of Crayola crayon colors" as of revision
  464659414 (2011-12-07): `red orange`, `green blue`, `pink flamingo`, and
  others.
- 16 of the light sources match, exactly and in order, the values on Planet
  Pixel Emporium's "Reproducing the color of real world light" page, which
  FastLED's `ColorTemperature` list also carries. `carbon arc` and `sunlight`
  have other colors than that page gives them.
- The rest match none of these, among them `greenish`, `incandescent`,
  `pink`, and the four `bright` colors.

This is the fragile one. The table is in a global that a lazily run function
fills, and neither has an exported symbol, so the program uses two addresses
in the dyld shared cache that are valid only for build 26B131 on arm64e. On
another build it stops with a message. To find the addresses there:

```sh
./siri-find-initializer.sh               # prints "<initializer> <global>"
"$bin/siri-hue-table" 0x... 0x...
```

Addresses given as arguments are not checked, and a wrong pair crashes the
program. The script disassembles the framework with `dyld_info`, which takes
up to a minute and tens of MB of temporary space. The comments in both files
say what they look for.

### home-temperature-curve

Apple's color for a color temperature:
`-[HFTemperatureColor hf_RGBColorRepresentation]` in Home.framework. The rows
are whole mireds from 50 to 600, and the columns are mireds, kelvins, red,
green, and blue from 0 to 1, the hue in degrees, and the saturation in
percent. Brightness is 1 wherever a channel is.

The program's output begins with two `# check` lines, which the file leaves
out: the largest difference between Apple's function and the closed form, over
mireds in steps of 0.25 and over kelvins in steps of 50. Expect about `7e-08`
in a color channel and `1.3e-05` in the hue and saturation plane, which is
float32 rounding.

The closed form's constants were read from the framework by disassembling
`_HFGetColorForLightTemperature`.

### natural-lighting-curve and natural-lighting-schedule

`natural-lighting-curve.sh` prints `NaturalLightingCurve.plist` from
HomeKitDaemon.framework's Resources with `plutil` and `jq`. It calls no
framework. HomeKitDaemonLegacy has a byte-identical copy. The columns are the
time of day, in `HH:MM` and in milliseconds, and the kelvins at 10% and at
100% brightness. The plist's other keys, `ColorTemperatureValueUpdateInterval`
(60000) and `ColorTemperatureNotifyIntervalThreshold` (600000), are checked
rather than printed: the script stops with an error if they or the table's
shape change.

`natural-lighting-schedule.ts` runs on Node.js anywhere, from the committed
table. It reimplements, from a disassembly of HomeKitDaemonLegacy, what the hub
does with the table: `HMDNaturalLightingCurve` and
`HAPCharacteristicValueLinearDerivedTransitionPoint` build the points,
`-[HMDNaturalLightingCurve transitionPointsWithMillisecondsElapsedSinceStartOfDay:]`
starts them at the time of day, and
`+[HAPCharacteristicValueTransition transitionPointsByCoalescingTransitionPoints:ofCurve:]`
merges runs into holds. Given a time of day and the light's range in mireds
(default 140 to 500), it prints the points as HAP-NodeJS stores them:

```sh
node tools/apple-home/natural-lighting-schedule.ts 14:03:37 140 500
```

With `--compare`, it reads a bridge's `ControllerStorage.<username>.json` and
regenerates each stored schedule from its start time in the given time zone,
truncated to whole seconds. It takes the light's range to be the lowest and
highest temperatures in the stored schedule, which clamps exactly as the real
range does. It exits nonzero unless it finds a stored schedule and every field
of every point matches:

```sh
node tools/apple-home/natural-lighting-schedule.ts --compare \
  "$PERSIST_PATH/ControllerStorage.<username>.json" America/Los_Angeles
```

On 2026-11-25 all six schedules that one home's hub had sent this bridge
matched with no difference, including one for a light whose range stops at
416 mireds. They test the interpolated first point only weakly, because each
started in the midday plateau, where the times on either side differ by at
most a mired. None of them starts exactly at a time in the table, and no
light's range cuts off the table's coolest values. Those cases are checked
only against the disassembly.

## What can break

- A later macOS may rename or remove any of these classes, selectors, or
  Catalyst frameworks. A missing class prints nothing or crashes, and a
  changed signature can crash.
- A change in output is the finding. Check whether Apple changed a swatch,
  the curve, or the write rule, and update `doc/color-coalescing.md`.
- The Home app on an iPhone or HomePod may differ from these macOS copies.
  The hub's schedules matched the macOS table on 2026-11-25; a `--compare`
  that fails against a later `ControllerStorage` file shows that the table or
  the way a schedule is built has changed.
  Which phrases Siri maps to which name is decided elsewhere and was not
  found; the table gives only the colors that the names have.
