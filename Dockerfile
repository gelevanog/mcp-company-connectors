# Switchboard: the five MCP servers, the gateway and the CLI share one image (different commands).
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/server-crm/package.json packages/server-crm/
COPY packages/server-helpdesk/package.json packages/server-helpdesk/
COPY packages/server-analytics/package.json packages/server-analytics/
COPY packages/server-kb/package.json packages/server-kb/
COPY packages/server-workspace/package.json packages/server-workspace/
COPY packages/agent/package.json packages/agent/
COPY packages/gateway/package.json packages/gateway/
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --filter "./packages/**" --filter switchboard
COPY packages packages
RUN pnpm exec tsc -b tsconfig.json && rm -rf packages/*/node_modules packages/*/src packages/*/test

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/packages /app/packages
RUN pnpm install --frozen-lockfile --prod --filter "./packages/**" \
 && rm -rf /root/.cache /root/.local/share/pnpm
COPY config config
COPY data data
COPY results results
RUN mkdir -p .cache && chown -R node:node .cache results
USER node
EXPOSE 8080 7101 7102 7103 7104 7105
ENTRYPOINT ["node", "packages/cli/dist/main.js"]
CMD ["gateway", "--host", "0.0.0.0"]
