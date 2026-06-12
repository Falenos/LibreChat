# Roles and access

> `USER` = chat only. `AGENT_BUILDER` = create/share agents, no admin panel. `ADMIN` = everything including admin panel.

## Role matrix

| Permission | USER | AGENT_BUILDER | ADMIN |
|---|---|---|---|
| Use chat | ✅ | ✅ | ✅ |
| Create & share agents/prompts | ❌ | ✅ | ✅ |
| All chat features | ❌ | ✅ | ✅ |
| Admin panel & admin API | ❌ | ❌ | ✅ |

`USER` restrictions require `KNAUF_RESTRICT_USER_PERMISSIONS=true` in env.

## How it works

Two separate systems control access:

1. **Permissions** (`roles` collection) — what you can do in chat (create agents, share prompts, etc.).
2. **Capabilities** (`systemgrants` collection) — admin panel access. Only `ADMIN` has the `access:admin` capability.

## AGENT_BUILDER — no code changes needed

`AGENT_BUILDER` is a **custom role** created via script or admin panel — no code changes required.

**Option A — mongosh script (recommended, idempotent):**
```bash
# Local dev
mongosh "mongodb://localhost:27018/LibreChat" knauf/scripts/seed-agent-builder-role.js

# Remote (e.g. via SSH tunnel to nonprod)
mongosh "<connection-string>" knauf/scripts/seed-agent-builder-role.js
```
Safe to re-run: creates the role if missing; if it already exists, it replaces the full permissions block to the target state.

Target `AGENT_BUILDER` permission profile:

- ON: `BOOKMARKS.USE`, `PROMPTS.USE/CREATE/SHARE`, `AGENTS.USE/CREATE`, `MULTI_CONVO.USE`, `TEMPORARY_CHAT.USE`, `RUN_CODE.USE`, `WEB_SEARCH.USE`, `MARKETPLACE.USE`, `FILE_SEARCH.USE`, `FILE_CITATIONS.USE`
- OFF: `PROMPTS.SHARE_PUBLIC`, `AGENTS.SHARE/SHARE_PUBLIC`, all `MEMORIES.*`, all `PEOPLE_PICKER.*`, all `MCP_SERVERS.*`, all `REMOTE_AGENTS.*`, all `SKILLS.*`

**Option B — admin panel (one-time manual):**
1. Log in as ADMIN → Admin Panel → Roles → **Create role**
2. Name it `AGENT_BUILDER`, apply the target profile above
3. Assign users: Admin Panel → Users → select user → **Change Role → AGENT_BUILDER**

## Troubleshooting: DB shows `false`, UI still shows `true`

If MongoDB shows the correct values but the Admin UI does not, check in this order:

1. **Redis cache** (most common):
   ```bash
   node config/flush-cache.js
   ```
2. **Backend process memory cache**: restart backend after cache flush.
3. **Tenant-scoped duplicate role docs**: roles are unique by `(name, tenantId)`, so multiple `AGENT_BUILDER` docs can exist. The seed script updates all docs named `AGENT_BUILDER`, but verify with script output if values still differ by tenant.

## Assigning roles

Via admin panel: Users → select user → Change Role.

Via mongosh (local bootstrap):
```bash
mongosh "mongodb://localhost:27018/LibreChat" --eval '
  db.users.updateOne({ email: "you@example.com" }, { $set: { role: "ADMIN" } })
'
```

## Related

- [agent-publishing-governance.md](../implementation-plans/agent-publishing-governance.md) — business rationale
- [code-change-protocol.md](code-change-protocol.md) — tier ladder
