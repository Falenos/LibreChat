# Redis & caching — how it works + local production parity

What Redis does for KARL, how the AGK clusters provision and wire it, and how to run a
matching Redis locally so your dev environment exercises the same code paths as production.

> **TL;DR** — Redis is **optional**: KARL falls back to in-memory/file/Mongo stores when it's
> off, so a single local instance runs fine without it. But prod/dev run with `USE_REDIS=true`,
> and several subsystems behave *differently* (and some only-correctly-with-Redis) when it's on.
> Local dev historically ran with Redis **off**, hiding that class of behaviour. This doc turns
> it on locally.

---

## 1. What Redis is used for

All Redis access is centralised in [`packages/api/src/cache/redisClients.ts`](../../../packages/api/src/cache/redisClients.ts),
which builds two clients (only when `USE_REDIS` is set):

- **`ioredisClient`** (ioredis) — sessions, rate limiting, resumable streams, atomic Lua ops.
- **`keyvRedisClient`** (`@keyv/redis`) — the general Keyv cache layer and leader election.

Each consuming subsystem has a fallback that activates when Redis is off. The fallbacks are
correct on a **single** instance but wrong across **multiple replicas** — which is exactly the
shape of bug that never reproduces on a laptop running without Redis:

| Subsystem | With Redis | Fallback when off | Key file(s) |
|---|---|---|---|
| General KV cache (Keyv) | shared `KeyvRedis` | in-process `Map` per namespace | [`cacheFactory.ts`](../../../packages/api/src/cache/cacheFactory.ts), [`getLogStores.js`](../../../api/cache/getLogStores.js) |
| HTTP sessions (OIDC/SAML SSO) | `connect-redis` store | `memorystore` (per-pod) | `cacheFactory.ts`, [`socialLogins.js`](../../../api/server/socialLogins.js) |
| Rate limiting | `rate-limit-redis` | express-rate-limit memory store | `cacheFactory.ts`, [`middleware/limiters/`](../../../api/server/middleware/limiters/) |
| Login/registration violations | Redis `violations:*` keys | file store | `cacheFactory.ts`, [`logViolation.js`](../../../api/cache/logViolation.js) |
| Bans | Mongo (independent of Redis) | Mongo | `getLogStores.js` |
| Concurrency limiter (streams) | atomic Lua INCR/DECR | non-atomic Keyv (documented race) | [`middleware/concurrency.ts`](../../../packages/api/src/middleware/concurrency.ts) |
| Resumable LLM streams (job store + SSE pub/sub) | `RedisJobStore` + `RedisEventTransport` | in-memory, per-pod — no cross-pod resume | [`stream/createStreamServices.ts`](../../../packages/api/src/stream/createStreamServices.ts) |
| Leader election (multi-replica) | atomic `SET NX EX` + Lua lease | `isLeader()` is always `true` → every pod thinks it leads | [`cluster/LeaderElection.ts`](../../../packages/api/src/cluster/LeaderElection.ts) |
| MCP registry cache + OAuth flow state | shared Redis | per-pod in-memory | [`mcp/registry/cache/`](../../../packages/api/src/mcp/registry/cache/), [`flow/manager.ts`](../../../packages/api/src/flow/manager.ts) |

**Fork-specific note:** Knauf added `attachIoredisPingInterval` in `redisClients.ts` to keep
pub/sub connections alive against Azure Cache idle timeouts — driven by `REDIS_PING_INTERVAL`.

`FORCED_IN_MEMORY_CACHE_NAMESPACES` (default `CONFIG_STORE,APP_CONFIG`) stay in-memory **even
with Redis on**, so YAML-derived config is per-container (safe for blue/green). This is expected
in every environment, local included.

---

## 2. How production is wired

Verified against `agk-deployment-configs` and [`../reference/agentic-karl-architecture.md`](../reference/agentic-karl-architecture.md).

- **App Redis is an external, managed [Azure Cache for Redis]** — not an in-cluster pod.
  Resource names: `redis-agk-nonprod-westeurope-redis-agk-dev-001` (dev),
  `redis-agk-prod-westeurope-redis-agk-prod-001` (prod). It's reached over a **private endpoint
  on TLS port 6380** (`rediss://`) — proven by the AKS egress NetworkPolicy allowing `6380`
  (`agentic-karl/{prod,dev}/network-policy/values.yaml`).
- **Wired via a single `REDIS_URI`** connection string from Key Vault — no separate
  `REDIS_PASSWORD`/`REDIS_CA`/`REDIS_USERNAME` (credentials are embedded in the URI).
  ExternalSecret `agentic-karl-secrets`, KV key `agentic-karl-REDIS-CONNECTION-STRING`,
  WorkloadIdentity SecretStore `kv-agntkarl-{nonprod,prod}-001`.
- **Config** (`agentic-karl/{prod,dev}/services/agentic-karl/values.yaml`):
  `USE_REDIS: true` and `REDIS_PING_INTERVAL: 300`. `USE_REDIS_STREAMS` is not set, so it
  inherits `true`.
- **Not the app's Redis:** an in-cluster `langfuse-redis:7-alpine` pod (6379, no TLS/auth)
  exists but serves **Langfuse only** (BullMQ + cache). Don't conflate the two.

> The Terraform that declares the `azurerm_redis_cache` resource lives in the `agk-infrastructure`
> repo (SKU/tier there); the connection string lives only in Key Vault. Neither is needed to run
> Redis locally.

---

## 3. Local production parity

The goal is to exercise the same `USE_REDIS` code paths — **not** to replicate TLS or the managed
cache. Local uses a plain-TCP container; TLS/auth are intentionally skipped.

Both files below (`docker-compose.override.yml`, `.env`) are **gitignored/local-only**, so this is
a per-developer change — that's why this doc exists (to make it reproducible). Copy the two blocks:

**`docker-compose.override.yml`** — add a `redis` service:

```yaml
  redis:
    image: redis:6.2.22-alpine     # match the Azure Cache for Redis 6.x engine; patch-pinned
    container_name: chat-redis
    restart: always
    ports:
      - "6379:6379"                # host-reachable: the backend runs on the host, not in the api container
```

**`.env`** — enable the same three keys prod sets (its Redis block is otherwise all-commented):

```dotenv
USE_REDIS=true
REDIS_URI=redis://127.0.0.1:6379
REDIS_PING_INTERVAL=300
```

- Use `127.0.0.1` because the backend runs on the **host** (`npm run backend:dev`). If you run
  the `api` **container** instead, that container reaches Redis at `redis://redis:6379`
  (service-name DNS) — a different value.
- Leave `USE_REDIS_STREAMS` unset (it inherits `USE_REDIS=true`, matching prod).
- Do **not** set `REDIS_CA`/`REDIS_PASSWORD` — no TLS/auth locally, by design.
- `USE_REDIS=true` with a **missing** `REDIS_URI` throws at boot (`cacheConfig.ts`). Keep it set.
- The container is ephemeral (no volume) — restarting it clears the cache, like Azure Basic
  eviction. Add `command: redis-server --appendonly yes` + a `./data-redis:/data` volume only if
  you want durability (that dir is not gitignored).

### Bring it up + verify

```bash
# 1. Start only Redis (targeted — avoids starting the api container).
docker compose up -d redis
docker exec chat-redis redis-cli ping                 # -> PONG

# 2. Restart the host backend so dotenv reloads .env (it only reads .env at startup).
#    Ctrl+C the running `npm run backend:dev`, then re-run it (or type `rs` in nodemon).

# 3. After logging in + sending a chat, confirm keys land in Redis:
docker exec chat-redis redis-cli keys '*'             # session, cache, stream job, leader keys

# 4. Reversal check: `docker compose stop redis` + unset USE_REDIS -> clean in-memory fallback.
```

---

## 4. Gotchas

- **This is a local-only change.** `docker-compose.override.yml` and `.env` are gitignored
  (`.gitignore`), so it does not propagate to teammates or prod — hence this doc. (Note: CLAUDE.md
  historically called the override "committed"; it is not.)
- **Backend must restart.** `dotenv` reads `.env` only at process start; enabling Redis while the
  backend is already running has no effect until you restart it.
- **`docker compose up -d` (no service) also starts the `api` container** — the base compose has no
  `profiles` gate despite older docs. Use the targeted `docker compose up -d redis` for local dev.
- **Version:** `redis:6.2.x-alpine` mirrors the Azure 6.x engine; every op KARL uses (`SET NX EX`,
  `EVAL`, `SCAN`, pub/sub, `connect-redis`, `rate-limit-redis`) is 6.x-compatible.

For the production Redis resource itself (provisioning, SKU), see the AGK infra context; for the
overall platform topology see [`../reference/agentic-karl-architecture.md`](../reference/agentic-karl-architecture.md).
