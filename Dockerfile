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

# Production dependencies are pure JS, so one native Bun install can serve
# every target architecture and the Node.js runtime.
# Digests pin to OCI image indexes (multi-arch) covering amd64 and arm64.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS build
ARG GIT_VERSION=unknown
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN printf '%s' "${GIT_VERSION}" > VERSION

# Node runs .ts files directly (built-in type stripping, stable since 24.12)
# :nonroot runs as uid 65532; the HAP (51826) and metrics ports are unprivileged
# so root is never needed. The k8s manifest sets fsGroup so /persist stays writable.
FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:ffa8a7545403036c94ec76674b5dbac2d425af2d679147cdf3e30180071487b7
WORKDIR /app
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/VERSION .
COPY src/ src/
# The :nonroot base already runs as uid 65532; set it explicitly so the
# container also runs unprivileged under `docker run`, independent of the base
# image default. COPY above runs as root, so the app's files stay root-owned.
USER 65532:65532
CMD ["src/main.ts"]
