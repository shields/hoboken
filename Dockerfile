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

# All dependencies are pure JS (no native modules), so Bun can install them
# for a Node.js runtime without binary compatibility issues.
FROM oven/bun AS build
ARG GIT_VERSION=unknown
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN printf '%s' "${GIT_VERSION}" > VERSION

# Node 24 runs .ts files directly (built-in type stripping, unflagged since 23.6)
FROM gcr.io/distroless/nodejs24-debian13
WORKDIR /app
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/VERSION .
COPY src/ src/
CMD ["src/main.ts"]
