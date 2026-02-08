# All dependencies are pure JS (no native modules), so Bun can install them
# for a Node.js runtime without binary compatibility issues.
FROM oven/bun AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Node 24 runs .ts files directly (built-in type stripping, unflagged since 23.6)
FROM gcr.io/distroless/nodejs24-debian13
WORKDIR /app
COPY --from=build /app/node_modules node_modules/
COPY src/ src/
CMD ["src/main.ts"]
