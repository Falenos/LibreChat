####################################
# BASE LAYER
####################################
FROM node:24-alpine3.22 AS base

####################################
# DEPENDENCIES LAYER
####################################
FROM base AS deps
RUN apk add --no-cache libc6-compat git

WORKDIR /app

ARG NPM_TOKEN
RUN echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" > ~/.npmrc \
    && echo "@knauf-group:registry=https://npm.pkg.github.com" >> ~/.npmrc

COPY package.json package-lock.json* ./
RUN npm ci

####################################
# BUILD LAYER
####################################
FROM base AS builder
RUN apk add --no-cache libc6-compat git

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

####################################
# RUNNER LAYER
####################################
FROM base AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

WORKDIR /app

COPY --from=builder /app/public ./public

RUN mkdir .next
RUN chown nextjs:nodejs .next

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
