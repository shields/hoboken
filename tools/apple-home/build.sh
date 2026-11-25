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
# Builds every probe into the directory given as the first argument, which
# must not be inside the repository. Needs Xcode's command line tools and the
# macOS SDK.

set -eu
out=${1:?usage: build.sh <output-directory>}
here=$(cd "$(dirname "$0")" && pwd)
sdk=$(xcrun --show-sdk-path)
mkdir -p "$out"

clang -fobjc-arc -framework Foundation -o "$out/siri-hue-table" "$here/siri-hue-table.m"

for probe in home-palettes home-temperature-curve home-color-writes home-color-readback home-color-limits home-color-wheels; do
  clang -fobjc-arc -Wall -target arm64-apple-ios17.0-macabi -isysroot "$sdk" \
    -iframework "$sdk/System/iOSSupport/System/Library/Frameworks" \
    -framework Foundation -o "$out/$probe" "$here/$probe.m"
done
