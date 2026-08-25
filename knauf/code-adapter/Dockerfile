
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ARG ADAPTER_VERSION
ARG SOURCE_REVISION
ENV NODE_ENV=production \
    DD_SERVICE=agentic-karl-code-adapter \
    OTEL_SERVICE_NAME=agentic-karl-code-adapter \
    ADAPTER_VERSION=${ADAPTER_VERSION} \
    DD_VERSION=${ADAPTER_VERSION} \
    OTEL_SERVICE_VERSION=${ADAPTER_VERSION} \
    SOURCE_REVISION=${SOURCE_REVISION}
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
LABEL org.opencontainers.image.source="https://github.com/Knauf-Group/agentic-karl" \
      org.opencontainers.image.version="${ADAPTER_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
USER node
EXPOSE 3112
ENV PORT=3112
CMD ["node", "--import", "./dist/tracing.js", "dist/index.js"]
