FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY tsconfig ./tsconfig
RUN bun run build

FROM oven/bun:1.2-alpine AS installer

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production


FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY --from=installer /app/node_modules ./node_modules
COPY static ./static
COPY robot_config.templ.yaml ./

COPY --from=builder /app/build ./build

# config file and certs needs to be mapped as a docker volume
ENV CONFIG_FILE=/app/config.jsonc

CMD ["node", "build/CloudBridge.js"]
