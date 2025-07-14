FROM oven/bun:1.2-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src /app/src

# config file and certs needs to be mapped as docker volume
ENV CONFIG_FILE=/app/config.jsonc

USER bun
CMD [ "bun", "start-file-receiver" ]
