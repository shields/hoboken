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

PRETTIER = bunx --no-install prettier --no-error-on-unmatched-pattern
FORMAT_PATHS = "**/*.ts" "**/*.md" "**/*.json" "**/*.json5" "**/*.yaml" "**/*.yml" "**/*.toml"
NODE ?= node
TEST_BROKER_VERSION = v2.1.2
TEST_BROKER_REVISION = 99fa50f30e325609394c324c8ff71cfbbe95d8ab
TEST_BROKER_SOURCE = .build/mosquitto-source
TEST_BROKER_BUILD = .build/mosquitto-build/$(TEST_BROKER_REVISION)
TEST_BROKER_BIN = $(abspath $(TEST_BROKER_BUILD)/src/mosquitto)
# Renovate falls back to RegExp, and still exits 0, when re2 is unusable.
RE2_PROBE = import { re2 } from "renovate/dist/expose.js"; new (re2())(".*").exec("x")

.PHONY: setup fmt lint test test-integration test-broker test-broker-deps test-screenshot golden-screenshot run demo

setup:
	bun install --frozen-lockfile
	bun run --cwd node_modules/re2 install
	bunx --no-install lefthook install

fmt:
	bun run eslint --fix .
	$(PRETTIER) --write $(FORMAT_PATHS)

lint:
	bun run tsc
	bun run eslint .
	@"$(NODE)" --input-type=module -e '$(RE2_PROBE)' || { echo "error: Renovate cannot load re2 under Node.js $$("$(NODE)" -v); run make setup with it first in PATH" >&2; exit 1; }
	"$(NODE)" node_modules/.bin/renovate-config-validator --strict
	$(PRETTIER) --check $(FORMAT_PATHS)

test:
	bun test --coverage

test-integration: test-broker
	HOBOKEN_TEST_BROKER="$(TEST_BROKER_BIN)" "$(NODE)" --test integration/wled-roundtrip.ts integration/heated-bedding-roundtrip.ts integration/mqtt-auth-roundtrip.ts

test-broker-deps:
	sudo apt-get update
	sudo apt-get install --yes --no-install-recommends build-essential cmake libssl-dev libcjson-dev

test-broker: $(TEST_BROKER_BIN)

$(TEST_BROKER_BIN):
	mkdir -p $(TEST_BROKER_SOURCE)
	git -C $(TEST_BROKER_SOURCE) init
	git -C $(TEST_BROKER_SOURCE) fetch --depth 1 https://github.com/eclipse-mosquitto/mosquitto.git $(TEST_BROKER_REVISION)
	git -C $(TEST_BROKER_SOURCE) checkout --detach FETCH_HEAD
	test "$$(git -C $(TEST_BROKER_SOURCE) rev-parse HEAD)" = "$(TEST_BROKER_REVISION)"
	git -C $(TEST_BROKER_SOURCE) diff --exit-code HEAD
	cmake -S $(TEST_BROKER_SOURCE) -B $(TEST_BROKER_BUILD) -DWITH_TESTS=OFF -DWITH_DOCS=OFF -DWITH_APPS=OFF -DWITH_PLUGINS=OFF -DWITH_CLIENTS=OFF -DWITH_CTRL_SHELL=OFF
	cmake --build $(TEST_BROKER_BUILD) --target mosquitto --parallel

test-screenshot:
	demo/docker-screenshot.sh test

golden-screenshot:
	demo/docker-screenshot.sh

run:
	node src/main.ts

demo:
	node demo/status-page.ts
