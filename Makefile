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

.PHONY: lint test test-integration test-screenshot golden-screenshot run demo

lint:
	bun run tsc
	bun run eslint .

test:
	bun test --coverage

test-integration:
	node --test integration/wled-roundtrip.ts

test-screenshot:
	demo/docker-screenshot.sh test test/screenshot.test.ts

golden-screenshot:
	demo/docker-screenshot.sh

run:
	node src/main.ts

demo:
	node demo/status-page.ts
