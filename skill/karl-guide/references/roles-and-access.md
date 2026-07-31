# Roles, groups, and access

Last verified from the application repository and current governance model: 2026-07-31. Effective runtime permissions are authoritative.

## Core distinction

- A role answers: “What actions may this person perform in Karl?”
- A group answers: “Which shared agents may this person see and use?”

Use audience groups for normal agent distribution. Do not describe a platform role as an agent audience.

## Current role model

| Capability | USER | AGENT_BUILDER | ADMIN |
| --- | ---: | ---: | ---: |
| Use standard chat | Yes | Yes | Yes |
| Use shipped read-only skills | Yes | Yes | Yes |
| Browse the public web | Conditional; restricted USER deployments disable it | Yes | Yes |
| Use assigned Agent Marketplace agents | Yes | Yes | Yes |
| Use a centrally managed MCP integration | Conditional; only when configured and authorised | No in the seeded profile | Conditional; only when configured |
| Create and maintain own agents | No | Yes | Yes |
| Add Data Knowledge to own agents | No | Yes | Yes |
| Configure Browse, visual artifacts, skills, and curated tools on own agents | No | Yes | Yes |
| Publish or assign agents to audiences | No | No | Yes |
| Manage users, groups, roles, and permissions | No | No | Yes |
| Create or configure MCP integrations | No | No | Platform-team governance only |
| Author or share skills | No | No | Disabled in the shipped configuration |
| Use Code Interpreter | No | No | No; sandbox not deployed |

### USER

Can use standard chat, shipped read-only skills, and agents shared to an audience they belong to. In deployments using the Karl USER restriction, public web search, File Search, agent creation, memory, remote agents, and code execution are disabled for this role. A centrally managed MCP integration may be usable when the platform team configures and exposes it, but the user cannot create, connect, or share one.

### AGENT_BUILDER

An approved AI Champion. Can create and maintain private agents, configure the three **What it can do** capabilities, add approved Data Knowledge, and attach the curated image-generation or calculator tools when needed. Can use shipped skills but cannot author or share skills. Cannot publish agents, grant audience access, browse user/group directories, use or create MCP servers, use remote agents or memory, run code, or administer the platform under the seeded profile.

### ADMIN

Can manage roles, groups, users, permissions, agent publication, audience assignments, and platform configuration. Some product capabilities remain disabled by shipped configuration; the ADMIN role does not make an undeployed backend exist.

## Agent visibility

Preferred model:

```text
Agent -> approved audience group -> group members
```

For temporary pilot testing, an admin may grant direct user access. The Agent Builder has no self-service publication control.

If a user cannot see an expected agent, check conceptually:

1. Was access approved?
2. Was the agent assigned to the correct audience group or user?
3. Is the user a member of that group?
4. Was access revoked or changed?

Do not expose other users, group membership lists, or admin-only details. Direct the user to the platform support/admin process when live access cannot be inspected.

## Accuracy rule

Do not claim that a user has a role or permission unless the current request includes trusted effective-capability context. If the user reports a missing UI control, describe likely access conditions instead of asserting a cause.
