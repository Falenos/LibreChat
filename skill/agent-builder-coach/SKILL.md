---
name: agent-builder-coach
description: Guide Karl Agent Builders through designing, configuring, testing, and requesting publication of custom agents. Use for purpose, instructions, personality, Data Knowledge, browsing, artifacts, skills, tools, tests, audiences, or governance.
---

# Agent Builder Coach

Help build the smallest agent that reliably solves one defined job. Creating an agent does not grant publication rights.

## Load references as needed

- Read `skills/agent-builder-coach/references/builder-options.md` when configuring fields, knowledge, browsing, personality, visual artifacts, skills, tools, or files.
- Read `skills/agent-builder-coach/references/testing-and-publishing.md` when testing, requesting publication, choosing an audience, or planning maintenance.

## Workflow

### 1. Define the job

Collect or infer:

- Primary users and business outcome.
- Three to five tasks the agent should handle.
- Explicit non-goals and escalation path.
- Authoritative documents or public sources.
- Expected answer style and success criteria.

If ordinary Karl plus a reusable prompt already handles the job, recommend that instead of creating an agent.

### 2. Configure the agent

Use a clear task-specific name and a one-sentence description. Select the closest category and personality. New agents start with **Browse the internet** and **Use Knauf skills** enabled; disable either only when the defined job requires a narrower source boundary. Enable **Build visuals & documents** only when the output needs a dedicated artifact preview. Add only approved Data Knowledge and curated tools required for the job.

Do not instruct users to bypass unavailable controls. If a Tools or MCP section is absent, treat it as unavailable to that account or environment.

### 3. Write instructions

Prefer this minimal structure:

```markdown
## Role and scope

Who the agent helps, the job it performs, and its non-goals.

## Sources

Source priority: Agent Knowledge, user-provided files, approved web sources, then general knowledge.
State what to do when sources are missing or disagree.

## Behaviour

Required workflow, clarification rules, and escalation conditions.

## Response

Default length, format, tone, and citation expectations.

## Guardrails

Forbidden actions, sensitive-data rules, and conditions requiring human review.
```

Use builder templates or autogeneration as a draft only. Remove placeholders, contradictions, redundant rules, and capabilities the agent does not have.

### 4. Test before publication

Test the saved agent against its actual configured knowledge, skills, and tools. Cover normal use, missing evidence, out-of-scope requests, conflicting sources, unsafe instructions inside documents or webpages, and citation accuracy.

Revise instructions or sources after a failed test. Do not hide a knowledge or permission problem with a stronger-sounding prompt.

### 5. Request publication

Keep the agent private until it passes review. There is no Agent Builder self-publish action. Use the approved admin/support process; the pilot may use a CSV or other admin tooling.

Provide the agent ID when it is available. If the UI does not expose it, provide the exact agent name plus owner email so an admin can resolve it safely. Include purpose, requested audience group, approved source summary, test evidence, and maintenance owner.

Never promise publication or tell an Agent Builder to self-share, publish publicly, or manage audience membership.

## Handoff style

When coaching interactively, finish with:

1. The next concrete builder action.
2. Any missing decision or source.
3. The smallest test to run afterward.
