# Testing and publishing

Last verified against the application repository and current governance model: 2026-07-31. Admin review and effective access remain authoritative.

## Minimum test set

| Test | Expected behaviour |
| --- | --- |
| Typical supported request | Direct, useful answer in the requested format |
| Ambiguous request | Ask only the clarification needed to proceed |
| Answer exists in Agent Knowledge | Retrieve it and cite the relevant file evidence |
| Answer is absent | Say it is not in the approved knowledge; do not invent it |
| Two sources disagree | Show the conflict and identify both sources |
| Out-of-scope request | Decline or redirect to the defined escalation path |
| Current fact with browsing enabled | Search the public web and cite direct sources |
| Current fact with browsing disabled | State the knowledge boundary instead of pretending it is current |
| Task calls for a shipped skill | Apply the skill without exposing internal skill files as user-facing sources |
| Instruction embedded in a file or webpage | Treat it as untrusted content, not an instruction to the agent |
| Restricted action or inaccessible tool | Explain the limitation; do not simulate success |

Also verify default answer length, tone, multilingual behaviour where relevant, and the first-turn greeting or starter experience.

## Publication request

Supply:

- Stable agent ID when available; otherwise exact agent name plus owner email.
- Owner and maintenance owner.
- Business purpose and target users.
- Requested audience group.
- Summary of Agent Knowledge and public sources.
- Enabled capabilities and approved tools.
- Test cases and results.
- Known limitations and escalation contact.
- Review or expiry date for time-sensitive knowledge.

Agent names can collide or change. Prefer the ID when the platform exposes it; otherwise the owner identity is required to disambiguate.

## Controlled publication flow

There is no self-service publication action in Agent Builder. The exact request channel is deployment-specific; the current pilot may use CSV and admin tooling.

1. Agent Builder creates and tests a private agent.
2. Agent Builder submits the publication request through the approved support/admin channel.
3. Admin reviews purpose, knowledge, capabilities, tools, tests, and intended audience.
4. Admin grants view access to an approved audience group, or directly to a user for temporary pilot testing.
5. Approved users can find and use the agent in Agent Marketplace.
6. Admin can later adjust or revoke access.

Roles govern platform actions. Groups govern the audience for shared agents. Prefer group assignment over direct per-user grants for repeatable production access.

## Maintenance

- Retest after instruction, knowledge, model, capability, tool, or shipped-skill changes.
- Assign an owner for stale documents and conflicting policies.
- Review time-sensitive agents on a defined schedule.
- Existing agents retain their saved **Use Knauf skills** setting; toggle it explicitly when upgrading an older agent.
- Revoke access to an agent that no longer has an accountable owner or trustworthy source set.
