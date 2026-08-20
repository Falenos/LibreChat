# Roles and access

> `USER` = restricted chat and assigned agents. `AGENT_BUILDER` = create private agents, no agent publishing or admin panel. `ADMIN` = platform administration.

## Role matrix

| Permission | USER | AGENT_BUILDER | ADMIN |
|---|---|---|---|
| Use standard chat | ✅ | ✅ | ✅ |
| Use shipped read-only skills | ✅ | ✅ | ✅ |
| Use web and document search | ❌ when USER lockdown is enabled | ✅ | ✅ |
| Create private agents | ❌ | ✅ | ✅ |
| Share or publish agents | ❌ | ❌ | ✅ |
| Create and share prompts | Admin-managed | Admin-managed | Admin-managed |
| Admin panel & admin API | ❌ | ❌ | ✅ |

`USER` restrictions require `KNAUF_RESTRICT_USER_PERMISSIONS=true` in env.

## How it works

Two separate systems control access:

1. **Permissions** (`roles` collection) — what you can do in chat (create agents, share prompts, etc.).
2. **Capabilities** (`systemgrants` collection) — admin panel access. Only `ADMIN` has the `access:admin` capability.

## AGENT_BUILDER lifecycle

`AGENT_BUILDER` remains a normal LibreChat custom role. Application startup creates the base role if absent and adds only permission fields that are missing. Existing values, including explicit `false`, the description, and Admin-managed choices are never overwritten.

The role cannot be renamed or deleted through the Admin API. Admins can still edit every permission exposed by the Admin Panel and add or remove members.

Target `AGENT_BUILDER` permission profile:

- ON: `BOOKMARKS.USE`, `AGENTS.USE/CREATE`, `MULTI_CONVO.USE`, `TEMPORARY_CHAT.USE`, `WEB_SEARCH.USE`, `MARKETPLACE.USE`, `FILE_SEARCH.USE`, `FILE_CITATIONS.USE`, `SKILLS.USE`
- OFF: `AGENTS.SHARE/SHARE_PUBLIC`, `RUN_CODE.USE`, all `MEMORIES.*`, all `MCP_SERVERS.*`, all `REMOTE_AGENTS.*`, and `SKILLS.CREATE/SHARE/SHARE_PUBLIC`

Configure role permissions in Admin Panel → Roles. For peer email sharing without global sharing, enable `PROMPTS.SHARE` and `PEOPLE_PICKER.VIEW_USERS`, and disable `PROMPTS.SHARE_PUBLIC`.

The shipped `librechat.yaml` sets `SKILLS.USE=true` and skill authoring/sharing false for built-in USER and ADMIN roles. The Agent Builder initializer carries the equivalent read-only Skills defaults for `AGENT_BUILDER`. No post-deployment role seed is required.

Assign users through Admin Panel → Users → select user → **Change Role → AGENT_BUILDER**.

## Troubleshooting

If MongoDB shows the correct values but the Admin UI does not, check in this order:

1. **Redis cache** (most common):
   ```bash
   node config/flush-cache.js
   ```
2. **Backend process memory cache**: restart backend after cache flush.
3. **Missing base permission field**: restart the application; startup reconciliation adds missing fields and invalidates the base role cache.
4. **Tenant-scoped role docs**: roles are unique by `(name, tenantId)`. Startup manages only the base `AGENT_BUILDER`; tenant-specific role lifecycle remains tenant-owned.

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
