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
Safe to re-run: creates the role if missing, patches any missing permissions if it exists.

**Option B — admin panel (one-time manual):**
1. Log in as ADMIN → Admin Panel → Roles → **Create role**
2. Name it `AGENT_BUILDER`, enable all agent/prompt permissions
3. Assign users: Admin Panel → Users → select user → **Change Role → AGENT_BUILDER**

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
