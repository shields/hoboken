# Apple Home probes

Programs that read how Apple's Home app and Siri choose colors, with the data
they produced on macOS 27.2.1 (build 26B131, arm64e) on 2026-11-24. The
conclusions are in [doc/color-coalescing.md](../../doc/color-coalescing.md).
The programs are kept so that they can be rerun on a later macOS to see what
changed.

**They call Apple frameworks that are not public API** (Home, HomeUI, and
HomeAutomationInternal) and are not expected to keep working. They are not
part of the build, the tests, or the Docker image. None talks to HomeKit,
reads a home or an account, or opens a network connection: they build color
objects in memory and call pure functions.

## Building and running

Needs Xcode's command line tools and the macOS SDK. `build.sh` builds every
program into a directory outside the repository. Each program's standard
output should match its committed file. Apple's code logs to standard error;
ignore it.

```sh
cd tools/apple-home
bin=$TMPDIR/apple-home
./build.sh "$bin"
"$bin/siri-hue-table" | diff - <(grep -v '^##' siri-hue-table.tsv)
"$bin/home-palettes" 2>/dev/null | diff - home-palettes.txt
for probe in writes readback limits wheels; do
  "$bin/home-color-$probe" 2>/dev/null | diff - "home-color-$probe.txt"
done
"$bin/home-temperature-curve" | diff - <(grep -v '^##' home-temperature-curve.tsv)
```

The Home app's frameworks exist on macOS only as Mac Catalyst copies under
`/System/iOSSupport`, so the `home-*` programs are Catalyst executables.

## Programs and data

| Program                    | Output file                  | What it shows                                                                                 |
| -------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `siri-hue-table.m`         | `siri-hue-table.tsv`         | Siri's 712 named colors: name to hue, saturation, and brightness                              |
| `home-palettes.m`          | `home-palettes.txt`          | The Home app's default color and temperature swatches                                         |
| `home-color-writes.m`      | `home-color-writes.txt`      | What the Home app writes for each color, temperature, and swatch                              |
| `home-color-readback.m`    | `home-color-readback.txt`    | How it turns a light's Hue, Saturation, and ColorTemperature back into a color or temperature |
| `home-color-limits.m`      | `home-color-limits.txt`      | Which characteristics each write needs, and how values clamp and round                        |
| `home-color-wheels.m`      | `home-color-wheels.txt`      | What the color and temperature wheels write, and the temperature wheel's range                |
| `home-temperature-curve.m` | `home-temperature-curve.tsv` | Apple's temperature-to-color curve, checked against the closed form in `src/convert.ts`       |

The `home-color-*.m` programs share `home-color-item.h`, which gives Apple's
`HFColorControlItem` stub characteristics so that its write and read-back
logic runs without a home.

### siri-hue-table

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

The output begins with two `# check` lines: the largest difference between
Apple's function and the closed form, over mireds in steps of 0.25 and over
kelvins in steps of 50. Expect about `7e-08` in a color channel and `1.3e-05`
in the hue and saturation plane, which is float32 rounding. The rows that
follow are whole mireds from 50 to 600.

The closed form's constants were read from the framework by disassembling
`_HFGetColorForLightTemperature`.

## What can break

- A later macOS may rename or remove any of these classes, selectors, or
  Catalyst frameworks. A missing class prints nothing or crashes, and a
  changed signature can crash.
- A change in output is the finding. Check whether Apple changed a swatch,
  the curve, or the write rule, and update `doc/color-coalescing.md`.
- The Home app on an iPhone or HomePod may differ from these macOS copies.
  Which phrases Siri maps to which name is decided elsewhere and was not
  found; the table gives only the colors that the names have.
