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

1. **Permissions** (`roles` collection) — what you can do in chat. Defined in `packages/data-provider/src/roles.ts`. `AGENT_BUILDER` has identical defaults to `ADMIN`.
2. **Capabilities** (`systemgrants` collection) — admin panel access. `seedSystemGrants()` in `packages/data-schemas/src/methods/systemGrant.ts` seeds `ADMIN` with all capabilities (including `access:admin`) and `AGENT_BUILDER` with all capabilities **except** `access:admin`.

## Assigning roles

Via admin panel: Users → select user → Change Role.

Via mongosh (local bootstrap):
```bash
mongosh "mongodb://localhost:27018/LibreChat" --eval '
  db.users.updateOne({ email: "you@example.com" }, { $set: { role: "ADMIN" } })
'
```

Restart the backend after any role change so `seedSystemGrants()` runs.

## Files changed (all marked `// [knauf]`)

- `packages/data-provider/src/roles.ts` — `AGENT_BUILDER` added to `SystemRoles` + `roleDefaults`
- `packages/data-schemas/src/methods/systemGrant.ts` — `seedSystemGrants()` updated

## Related

- [agent-publishing-governance.md](../implementation-plans/agent-publishing-governance.md) — business rationale
- [code-change-protocol.md](code-change-protocol.md) — tier ladder (this is Tier 4c)
