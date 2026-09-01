---
name: business-case-writeup
description: Turn an agreed business discussion into a decision paper or delivery specification. Use for a business case, decision paper, or spec after key decisions are settled. Do not use to discover requirements or for unrelated writing.
argument-hint: '[agreed discussion to document]'
user-invocable: true
disable-model-invocation: false
version: '1.0.0'
---

# Business Case Writeup

Synthesize an agreed discussion without reopening every decision.

## Boundary

Use this workflow only when enough has already been agreed to write a useful document.

- If the idea is still being judged, use `business-idea-stress-test` instead.
- If execution decisions still need interviewing, use `business-plan-grilling` instead.
- Do not invoke for unrelated reports, summaries, emails, or ordinary drafting.

An explicit `$business-case-writeup` invocation always counts as a request to run it. If the source is too thin, identify the few material gaps rather than producing a hollow template.

## Choose one mode

- **Decision paper:** someone must approve, fund, reject, or choose. Read `skills/business-case-writeup/references/decision-paper.md`.
- **Delivery specification:** the decision is made and a team must build, change, or operate something. Read `skills/business-case-writeup/references/delivery-specification.md`.

Infer the mode and state it in one sentence. If both are needed, write the decision paper first; the delivery specification follows after approval.

## Evidence discipline

Every material number, date, benchmark, and factual claim is one of:

- **Sourced:** use it and name the source.
- **Proposer estimate:** label it as an estimate not yet measured.
- **Assumption:** keep it in the assumptions section with its consequence and confirmation owner.
- **Unknown:** list it as an open question and state what it blocks.

Never invent a figure, benchmark, saving, source, person, system, deadline, or approval. Surface contradictions instead of silently choosing a side.

## Produce the document

1. Use the organisation's exact names for systems, roles, processes, and documents.
2. Follow the selected reference, adapting its depth to the decision. Keep the result readable in roughly ten minutes.
3. Produce a complete Markdown artifact. Reuse its identifier when revising the same document in the conversation.
4. Outside the artifact, state only the material assumptions and gaps that still need closure.

Do not promise a downloadable document file. The artifact is the reusable deliverable in KARL.

## Rules

- Keep “do nothing” among the decision options.
- Keep full cost separate from value.
- Preserve approval lead times and kill criteria when they apply.
- Omit a template section only when it genuinely cannot affect the reader's decision or delivery; record material omissions as open questions.
