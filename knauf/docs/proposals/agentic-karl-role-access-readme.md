# Agentic Karl Role Access and Agent Publishing Governance

Last reviewed: 2026-06-15
Status: Final draft for business, audit, and legal review

## Executive Summary

Agentic Karl uses a controlled access model with two separate governance layers.

Roles define what a person can do inside the application. For example, a role controls whether a user can use chat, create agents, manage platform settings, or administer users and groups.

Groups define which agents a person can access. A user does not receive access to all agents just because they can use the platform. Agents are published to approved audience groups, and users receive access by being members of those groups.

The first operating model uses three roles only: `USER`, `AGENT_BUILDER`, and `ADMIN`. Standard users can use chat, internet search, and assigned agents. Approved AI Champions with the `AGENT_BUILDER` role can create and maintain agents, but they cannot publish agents or decide who can use them. Platform admins publish agents by assigning them to approved groups and managing the users in those groups.

```text
Roles answer:   What can this user do in the application?
Groups answer:  Which agents can this user see and use?
Admins control both.
```

## Governance Model

The platform separates feature access from agent access.

```text
                  FEATURE ACCESS

        +------------------+       +----------------------+
        | User account     |       | Role                 |
        | user@knauf.com   +------>| USER                 |
        +------------------+       | AGENT_BUILDER        |
                                   | ADMIN                |
                                   +----------+-----------+
                                              |
                                              v
                                   +----------------------+
                                   | Application features |
                                   | chat, web search,    |
                                   | agent creation,      |
                                   | admin controls       |
                                   +----------------------+
```

```text
                  AGENT ACCESS

        +------------------+       +----------------------+
        | Published agent  +------>| Audience group       |
        | Finance Helper   |       | AGK_FINANCE_USERS    |
        +------------------+       +----------+-----------+
                                              |
                         +--------------------+--------------------+
                         |                    |                    |
                         v                    v                    v
                 +---------------+    +---------------+    +---------------+
                 | user 1        |    | user 2        |    | user 3        |
                 +---------------+    +---------------+    +---------------+
```

This distinction is important for governance. Roles should not be used as the normal way to publish individual agents. Roles are for platform capability levels. Groups are for agent audiences.

## Scope

This document defines the first controlled operating model for Agentic Karl.

It covers:

- Default access for normal platform users.
- The approved AI Champion role for creating agents.
- Admin control of platform features and agent publication.
- Group-based assignment of agents to approved audiences.
- Revocation, offboarding, and lifecycle expectations.

It does not define technical implementation details, database scripts, infrastructure setup, or future self-service governance workflows.

## Roles

The first iteration uses only three roles.

| Role | Business meaning | Primary purpose |
|---|---|---|
| `USER` | Standard platform user | Uses chat, internet search, and assigned agents |
| `AGENT_BUILDER` | Approved AI Champion | Creates and maintains private agents |
| `ADMIN` | Platform administrator / developer | Controls roles, groups, publication, assignments, and admin-managed capabilities |

Additional roles are technically possible, but they are not recommended in the first iteration. A small role model is easier to explain, operate, and audit.

## Feature Access by Role

Feature access is governed through roles.

| Application feature | `USER` | `AGENT_BUILDER` | `ADMIN` |
|---|---:|---:|---:|
| Use standard chat | Yes | Yes | Yes |
| Use internet search in chat | Yes | Yes | Yes |
| Use assigned agents | Yes | Yes | Yes |
| See assigned agents in marketplace | Yes | Yes | Yes |
| Create agents | No | Yes | Yes |
| Maintain own agents | No | Yes | Yes |
| Publish agents to other users | No | No | Yes |
| Assign agents to groups | No | No | Yes |
| Manage users | No | No | Yes |
| Manage groups | No | No | Yes |
| Manage roles and permissions | No | No | Yes |
| Use people picker for users/groups/roles | No | No | Yes |
| Use persistent memory | No | No | Admin-managed only |
| Create or attach agent tools | No | No | Admin-managed only |
| Create or attach MCP connectors | No | No | Admin-managed only |
| Use MCP connectors | No in first iteration | No in first iteration | Admin-managed only |
| Create or attach remote agents | No | No | Admin-managed only |
| Create or attach agent skills | No | No | Admin-managed only |

### Standard Users

Standard users receive limited access by default.

They can:

- Use the normal Agentic Karl chat experience.
- Use internet search in chat.
- Use agents that have been assigned to a group they belong to.
- Open the marketplace to find agents available to them.

They cannot:

- Create, edit, delete, share, or publish agents.
- Decide who can access an agent.
- Manage users, groups, roles, or permissions.
- Use admin-only controls.
- Create or attach MCP connectors, tools, remote agents, or skills.
- Use persistent memory unless a later governance model explicitly approves it.

### Agent Builders

The `AGENT_BUILDER` role is reserved for approved AI Champions.

Agent Builders can:

- Use the same standard platform features as normal users.
- Create agents.
- Maintain agents they created.
- Configure agent name, description, and instructions.
- Customize the agent prompt.
- Add approved knowledge or files to their own agent where the platform allows it.
- Request publication of an agent to a defined business audience.

Agent Builders cannot:

- Publish an agent to users or groups.
- Share an agent directly with other users.
- Share an agent publicly.
- Grant or revoke access to an agent.
- Use the people picker to browse users, groups, or roles.
- Manage roles, groups, users, or platform permissions.
- Create or attach MCP connectors, tools, remote agents, or skills.
- Enable persistent memory.

Creating an agent is not the same as publishing an agent. AI Champions can build and maintain agents, but publication remains controlled by platform admins.

### Admins

Admins are responsible for controlled operation of Agentic Karl.

Admins can:

- Manage platform roles and feature permissions.
- Manage users and groups.
- Review agent publication requests.
- Assign agents to approved groups.
- Add or remove users from agent audience groups.
- Revoke access to agents.
- Manage admin-controlled capabilities such as MCP connectors, tools, remote agents, skills, and memory if those capabilities are introduced.
- Maintain the Admin Panel and operational access processes.

Admins are the only role allowed to publish an agent to a business audience.

## Admin-Managed Features

Some application capabilities exist in the platform but are not self-service for standard users or Agent Builders.

These include:

- MCP connectors.
- Agent tools.
- Remote agents.
- Agent skills.
- Persistent memory.
- User, group, role, and permission administration.

For the first iteration, there will be no MCP connectors available to Agent Builders. If connectors, tools, remote agents, skills, or memory are introduced later, platform admins will decide which capabilities are approved, how they are configured, and who may use them.

## Agent Assignment Through Groups

Agent access is governed through groups.

The recommended model is:

```text
Agent -> Audience group -> Users
```

An agent is assigned to a group with viewer access. Users who belong to that group can see and use the agent. Users outside that group cannot see or use the agent unless they receive access through another approved group or a specific exception.

```text
Recommended model

        +-------------+       viewer access       +----------------------+
        | Agent A     +-------------------------->| Group: AGK_TEAM_X    |
        +-------------+                           +----------+-----------+
        +-------------+                                      |
        | Agent B     +--------------------------+           |
        +-------------+                          |           |
                                                  v           v
                                             +----------------------+
                                             | Approved users       |
                                             | in AGK_TEAM_X        |
                                             +----------------------+
```

A group can receive one agent or several agents.

```text
Group: AGK_FINANCE_USERS

Assigned agents:
  - Finance Policy Assistant
  - Invoice Support Agent
  - Reporting Helper

Approved members:
  - finance user 1
  - finance user 2
  - finance user 3
```

This is preferred over assigning every agent directly to individual users.

```text
Avoid as the default:

  Agent A -> user 1
  Agent A -> user 2
  Agent A -> user 3
  Agent B -> user 1
  Agent B -> user 2
  Agent B -> user 3

Use instead:

  Agent A -> Group X -> users
  Agent B -> Group X -> users
```

Direct user-to-agent assignment should be used only for exceptions, such as temporary testing or a specific one-off approval.

## Publishing Flow

The publishing flow is intentionally controlled.

1. A user joins Agentic Karl and receives `USER` access.
2. A small set of approved AI Champions receives `AGENT_BUILDER` access.
3. An Agent Builder creates and maintains a private agent.
4. The Agent Builder submits a publication request to the platform admin team.
5. The request identifies the agent and the requested business audience.
6. Platform admins review the request.
7. Platform admins create or select the approved audience group.
8. Platform admins add the approved users to that group.
9. Platform admins assign the agent to the group with viewer access.
10. Group members can find the agent in the marketplace and use it.
11. Platform admins can later adjust access by changing group membership or removing the group assignment.

```text
Agent Builder              Platform Admins                  Users
     |                           |                            |
     | create private agent      |                            |
     +-------------------------->| review request             |
     |                           | create/select group        |
     |                           | add approved users         |
     |                           | grant group viewer access  |
     |                           +--------------------------->|
     |                           |                            | see/use assigned agent
```

The Agent Builder does not self-publish and does not self-assign access.

## Marketplace Behavior

The marketplace is not an open catalogue of all agents.

Users see agents that are available to them. An agent becomes visible only when the user has access through an approved group or, by exception, a direct user assignment.

This means:

- Standard users see assigned agents only.
- Agent Builders see assigned agents and agents they own or maintain.
- Users do not get access to all agents simply because the marketplace exists.
- Removing a user from an audience group should remove that user's access to the agents assigned to that group.

## Revocation and Lifecycle Rules

Access should be revoked through group membership whenever possible.

```text
User removed from Group X
          |
          v
User no longer receives Group X agent access
          |
          v
Agent is no longer available to that user
```

Removing a user from the `AGENT_BUILDER` role stops the user from creating new agents and from using Agent Builder capabilities. It does not automatically delete agents the user already created.

Existing agents should be handled deliberately:

- If the agent is still needed, admins keep it and control the audience through groups.
- If the creator should no longer maintain it, admins transfer ownership, downgrade ownership, or manage the agent directly.
- If the agent is no longer needed, admins delete or archive it according to the operating process.

Deleting an audience group should remove the access granted to that group. The agent itself remains unless admins delete the agent separately.

## Audit and Operating Principles

The governance model should remain simple and auditable.

Core principles:

- Use `USER`, `AGENT_BUILDER`, and `ADMIN` as the only standard roles in the first iteration.
- Use roles to control application features.
- Use groups to control agent audiences.
- Assign agents to groups with viewer access by default.
- Use direct user-to-agent assignment only as an exception.
- Keep all publication and access changes under admin control.
- Do not allow Agent Builders to publish, share, or grant access to agents.
- Keep MCP connectors, tools, remote agents, skills, and persistent memory admin-managed.
- Avoid creating many special-purpose roles until the governance model is mature.

The key rule is:

```text
Roles control platform capabilities.
Groups control agent audiences.
Admins control both.
```
