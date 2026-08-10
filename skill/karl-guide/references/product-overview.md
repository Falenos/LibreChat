# Karl product overview

Last verified from the application repository and current governance model: 2026-08-04. Live UI, effective permissions, approved knowledge, and deployed integrations remain authoritative.

## Scope and Knauf boundary

Karl is Knauf's AI platform for general assistance, approved custom agents, governed skills, file-based knowledge, public-web research, and supported visual deliverables. It helps colleagues turn a work goal and relevant context into an answer or deliverable. Available capabilities still depend on the selected chat or agent, the user's effective permissions, and the deployed environment.

This guide explains Karl in a Knauf work context; it is not a general source of truth about Knauf. For other Knauf-specific questions:

- Use approved Agent Knowledge for internal policies, processes, organisation details, or controlled documents.
- Use current official Knauf sources for public company facts when web research is available.
- State the knowledge boundary when no approved source is available. Do not fill the gap from general knowledge or assumptions.

## Platform mental model

| Layer               | What it does                                                                       | What it does not do                                                             |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Conversation        | Holds the user's current goal, instructions, and supplied context                  | Does not grant access to another system or another user's data                  |
| Skill               | Provides a reviewed workflow or Knauf-specific way of working                      | Does not grant credentials or permissions, or store user-specific knowledge     |
| Custom agent        | Packages instructions, approved capabilities, and knowledge for one repeatable job | Does not become an administrator or automatically learn from every conversation |
| Agent Knowledge     | Keeps approved files available for retrieval by one custom agent                   | Does not retrain the model or guarantee that every passage is retrieved         |
| Tool or integration | Provides a specific approved capability or external data/action surface            | Does not bypass the user's permissions or imply access to unconfigured systems  |
| Artifact            | Renders a structured answer, diagram, report, dashboard, or similar preview        | Is not automatically a native Office or PDF file                                |
| Role and group      | A role controls platform actions; a group controls the audience for shared agents  | A group does not grant Agent Builder or administrator powers                    |

Permissions and deployed configuration gate every layer. A skill or agent can guide the work but cannot make an unavailable capability available.

## Choose the smallest suitable surface

- Use standard Karl for a one-off question, draft, summary, translation, comparison, or research task.
- Use a skill when the task needs a repeatable reviewed method, such as Knauf branding, diagrams, artifacts, or source discipline.
- Use a custom agent when a defined audience repeatedly needs the same instructions, approved knowledge, and capabilities.
- Use Agent Knowledge when the answer must be grounded in a maintained set of approved documents.
- Use a managed integration when the task requires current data from, or an action in, another system.
- Use an artifact when a dedicated visual or structured preview materially improves the result.

Do not recommend a custom agent merely to rename ordinary Karl. It needs a defined job, audience, source set, success criteria, owner, and escalation path.

## Build a personal Karl map

When a user wants to understand how Karl fits their work, use only context they deliberately provide:

1. Identify the user's goal and three to five recurring tasks.
2. Identify the required inputs or authoritative sources.
3. Match each task to standard Karl, a skill, a custom agent, Agent Knowledge, an integration, or an artifact.
4. State the required role, audience access, configuration, and important limitation.
5. Recommend one small experiment the user can run now.

Use this compact structure when an artifact or table would help:

| Goal or task | Inputs | Karl surface | Expected output | Access or limitation | Next experiment |
| ------------ | ------ | ------------ | --------------- | -------------------- | --------------- |

“Personal” means adapted to the user's stated work, not a hidden profile. Do not infer department, seniority, location, permissions, or sensitive attributes. Do not promise persistent memory. If the map must be reused, tell the user to save the artifact or provide it again in a later conversation.

## Learning from user questions

A custom agent does not automatically inspect other users' conversations, build a cross-user profile, update its own instructions, or expose question analytics to its owner. Improving Karl from recurring questions requires a separate approved analytics and review process with appropriate access controls, retention, and privacy handling.

When a question reveals a knowledge gap, answer the current user honestly and describe the missing source or capability. Do not claim that the agent has learned the answer for future users.
