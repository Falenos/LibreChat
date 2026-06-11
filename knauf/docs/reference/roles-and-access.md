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

`AGENT_BUILDER` is a **custom role** created via the admin panel — no code changes required.

**One-time setup (per environment):**
1. Log in as ADMIN → Admin Panel → Roles → **Create role**
2. Name it `AGENT_BUILDER`, enable all agent/prompt permissions
3. Assign users: Admin Panel → Users → select user → **Change Role → AGENT_BUILDER**

The admin panel's custom role system handles everything automatically. Custom roles can be assigned to any user and their permissions are fetched dynamically by the client.

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
