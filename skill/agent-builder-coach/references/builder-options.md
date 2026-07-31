# Agent Builder options

Last verified from the application repository: 2026-07-31. Visible sections depend on effective permissions and environment configuration.

## Core fields

- Avatar: optional visual identity.
- Name: required; identify the task or audience rather than using a generic assistant name.
- Description: explain the outcome in one sentence.
- Category: helps organise and find the agent.
- Personality: controls the agent's writing style and tone.
- Fast Mode: prioritises faster, cheaper answers by skipping reasoning; use for simple, repeatable work.
- Show reasoning: shows supported reasoning progress; it is unavailable while Fast Mode is on.

## What it can do

The simplified builder currently exposes three capability switches:

- **Browse the internet**: enabled by default. Uses the model's native web search for public-web research and `open_url` only for an exact HTTPS URL in the user's current message.
- **Build visuals & documents**: off by default for new agents. Enables the artifact preview for React, HTML, Mermaid, SVG, and Markdown deliverables.
- **Use Knauf skills**: enabled by default for new agents. With no per-skill allow-list in the simplified builder, the agent receives every skill currently accessible to the user, including future public deployment skills. Existing agents keep their saved setting.

Disable browsing for agents that must answer only from approved Data Knowledge. Instructions must still say what to do when knowledge is missing.

## Data Knowledge

- Upload persistent documents that the agent may retrieve in future conversations.
- File Search turns on automatically when the first knowledge file is attached and turns off when the last is removed.
- Wait for indexing to become ready before judging retrieval quality.
- Use a focused, governed source set. More files are not automatically better.
- Remove obsolete or conflicting files and retest after knowledge changes.

Supported Agent Knowledge formats: PDF, DOCX, PPTX, XLSX, CSV, JSON, TXT, and Markdown. PNG, JPEG/JPG, and WEBP are supported as message-scoped chat images but are rejected for Agent Knowledge/File Search.

Per-file limits: documents 25 MB and data/spreadsheets 50 MB. Agent Knowledge has no configured per-selection file-count or aggregate-size cap, but large unfocused libraries can reduce answer quality and increase maintenance work.

## Tools and MCP servers

The Tools section is enabled in the shipped endpoint configuration and is curated to image generation and calculator. Attach either only when the agent's defined job needs it.

The MCP section appears only when servers are configured and accessible. The seeded Agent Builder pilot role cannot create or use MCP servers, remote agents, memory, or code execution. Never ask the user to supply credentials or configure an unapproved connector.

Treat a missing control as an access or configuration condition, not automatically as a UI defect.

## Instructions editor

Templates and autogeneration can accelerate drafting. Always inspect the final instructions for placeholder text, impossible capabilities, conflicting source rules, excessive verbosity, and unsafe sharing instructions.
