#!/bin/sh
# Copyright © 2026 Michael Shields
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Prints the home hub's Adaptive Lighting table, NaturalLightingCurve.plist in
# HomeKitDaemon.framework, as natural-lighting-curve.tsv. Takes the plist's
# path as an optional argument.

set -eu
plist=${1:-/System/Library/PrivateFrameworks/HomeKitDaemon.framework/Versions/A/Resources/NaturalLightingCurve.plist}

json=$(plutil -convert json -o - "$plist")

printf '%s\n' "$json" | jq -r '
  def points($b):
    [.NaturalLightingCurve[] | select(.Brightness == $b)]
    | if length == 1 then .[0].ColorTemperatureTransitionPoints | sort_by(.TimeOfDay)
      else error("expected one curve for brightness \($b)") end;
  if (.NaturalLightingCurve | map(.Brightness) | sort) != [10, 100]
  then error("expected curves for brightness 10 and 100") else . end
  | if .ColorTemperatureValueUpdateInterval != 60000
      or .ColorTemperatureNotifyIntervalThreshold != 600000
      or (keys - ["ColorTemperatureNotifyIntervalThreshold", "ColorTemperatureValueUpdateInterval", "NaturalLightingCurve"]) != []
    then error("top-level keys changed: \(del(.NaturalLightingCurve))") else . end
  | points(10) as $low | points(100) as $high
  | if ($low | map(.TimeOfDay)) != ($high | map(.TimeOfDay))
    then error("the curves have different times") else . end
  | ["time", "milliseconds", "kelvin_10", "kelvin_100"],
    ([$low, $high] | transpose[]
      | (.[0].TimeOfDay / 60000) as $minutes
      | [ "\($minutes / 60 | floor | tostring | if length < 2 then "0" + . else . end):\($minutes % 60 | tostring | if length < 2 then "0" + . else . end)",
          .[0].TimeOfDay, .[0].ColorTemperature, .[1].ColorTemperature ])
  | @tsv'
