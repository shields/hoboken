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

.PHONY: setup fmt lint test test-integration test-screenshot golden-screenshot run demo

setup:
	bun install --frozen-lockfile
	bunx --no-install lefthook install

fmt:
	bun run eslint --fix .
	$(PRETTIER) --write $(FORMAT_PATHS)

lint:
	bun run tsc
	bun run eslint .
	$(PRETTIER) --check $(FORMAT_PATHS)

test:
	bun test --coverage

test-integration:
	node --test integration/wled-roundtrip.ts

test-screenshot:
	demo/docker-screenshot.sh test

golden-screenshot:
	demo/docker-screenshot.sh

run:
	node src/main.ts

demo:
	node demo/status-page.ts
