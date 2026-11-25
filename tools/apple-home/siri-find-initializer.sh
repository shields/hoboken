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
# Finds the two addresses that siri-hue-table needs on this macOS build: the
# function that builds Siri's HueSemantic color table and the global that holds
# the table.
#
# The builder allocates one array of 712 elements, 32 bytes each after a
# 32-byte header, so it asks for 0x5920 bytes, stores the array in a global,
# and fills in the elements. This disassembles HomeAutomationInternal from the
# dyld shared cache with dyld_info, finds the allocation size, then reports the
# start of that function and the global it stores the array into.
#
# Usage: siri-find-initializer.sh
# Prints "<initializer> <global>" as unslid hex addresses, the arguments of
# siri-hue-table. Takes seconds to a minute and writes tens of MB to $TMPDIR.

set -eu
image=/System/Library/PrivateFrameworks/HomeAutomationInternal.framework/Versions/A/HomeAutomationInternal
dis=$(mktemp "${TMPDIR:-/tmp}/hai.XXXXXX")
trap 'rm -f "$dis"' EXIT
dyld_info -disassemble "$image" >"$dis"

set -- $(awk '
  { sub(/ +$/, "") }
  /pacibsp/ { start = $1 }
  /mov +w1, #0x5920$/ { found = start; next }
  found && /adrp +x8, / { page = $NF; next }
  found && /str +x0, \[x8, #0x[0-9a-f]+\]$/ && page != "" {
    match($0, /#0x[0-9a-f]+/)
    print found, page, substr($0, RSTART + 1, RLENGTH - 1)
    exit
  }
' "$dis")
[ $# -eq 3 ] || { echo "allocation of the color table not found" >&2; exit 1; }
printf '%s 0x%x\n' "$1" $(($2 + $3))
