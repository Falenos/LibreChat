# Karl capabilities

Last verified from the application repository: 2026-07-31. Live role permissions and environment configuration remain authoritative.

## Everyday assistance

Karl can answer questions, explain concepts, draft and rewrite text, summarise, translate, brainstorm, compare options, structure plans, and help with code or technical material. Users should review important business, legal, financial, technical, and safety-related output.

## Public web research

“Browse the internet” combines two mechanisms behind one user-facing capability:

- Azure-hosted model web search discovers current public information and returns web citations.
- The exact-page `open_url` tool reads a specific HTTPS link included in the user's current message.

The exact-page reader is not an interactive browser and rejects plain HTTP. Availability also depends on the user's web-search permission. See `navigation-and-limits.md` for failure cases.

Example: “Compare the latest official EU guidance on this topic and link each source.”

## Files and knowledge

- Chat uploads provide documents or visual images for the current conversation.
- Agent Builder “Data Knowledge” attaches persistent document and data files to that agent.
- File Search retrieves relevant document passages and can produce file citations.
- Images are message-scoped visual inputs. Agent Knowledge rejects them and File Search does not index their pixels.

Example: “Summarise the differences between these two uploaded policies and cite each document.”

## Custom agents and Agent Marketplace

- Shared agents available to the user's audience groups appear in Agent Marketplace.
- An assigned agent combines instructions, approved knowledge, and configured capabilities for a repeatable use case.
- Agent Builders can create and maintain their own private agents under the current governance model.
- Agent publication and audience assignment remain admin-controlled; the builder has no self-publish action.

## Skills

Karl currently ships six read-only deployment skills:

- `karl-brand`, `karl-artifacts`, and `karl-mermaid` for branded visual deliverables and diagrams.
- `web-research` for internet routing and source discipline.
- `karl-guide` for platform help, access, and limitations.
- `agent-builder-coach` for governed agent design, testing, and publication preparation.

New agents start with **Use Knauf skills** enabled and no fixed allow-list, so all skills currently accessible to the user—including future public deployment skills—are available automatically. Existing agents keep their saved setting. The endpoint capability and `SKILLS.USE` role permission still apply.

## Visual and generated output

Depending on enabled capabilities and permissions, Karl can:

- Produce Mermaid diagrams for flows, sequences, architecture, and relationships.
- Create interactive or structured artifacts in a dedicated preview.
- Apply Knauf branding guidance to supported output.
- Generate images when the image-generation control or agent tool is available.

Use a normal chat answer when a diagram, artifact, or image would not improve the result.

## Conditional capabilities

These may be hidden or admin-managed for a user or environment:

- Agent creation and editing.
- Curated tools such as image generation and calculator.
- MCP servers and remote agents.
- Persistent memory.
- Skill authoring and sharing; shipped deployment skills are read-only.
- Public sharing and administrative controls.

Code execution is disabled in the shipped Karl configuration because no sandbox is deployed. Do not promise it.
