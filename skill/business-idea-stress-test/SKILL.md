---
name: business-idea-stress-test
description: Stress-test an uncommitted business idea before it becomes a proposal. Use when the user asks whether an idea is worthwhile, says "poke holes in this", or wants its assumptions tested. Do not use for an approved plan or ordinary drafting.
argument-hint: '[idea to test]'
user-invocable: true
disable-model-invocation: false
version: '1.0.0'
---

# Business Idea Stress Test

Test whether an idea deserves investment before helping to sell it.

## Boundary

Use this workflow when the decision is still open: **should we do this?**

- For an already-chosen direction whose execution needs checking, use `business-plan-grilling` instead.
- For an agreed discussion that only needs writing, use `business-case-writeup` instead.
- Do not load either neighbouring workflow merely because it is mentioned here.

An explicit `$business-idea-stress-test` invocation always counts as a request to run it.

## Workflow

1. **Frame the decision.** State the idea, intended beneficiary, decision owner, proposed value, and the credible do-nothing alternative. Correct the framing with the user only when it would materially change the test.
2. **Classify the evidence.** Mark material claims as sourced, proposer estimate, assumption, or unknown. Never manufacture a baseline, benchmark, saving, date, owner, or source. If browsing or file search is unavailable, keep the claim unknown.
3. **Find the load-bearing assumptions.** Select the two or three assumptions whose failure would collapse the case. For each, name the cheapest ethical test that could disprove it, its owner, and the evidence needed.
4. **Apply relevant weakness lenses.** Read `skills/business-idea-stress-test/references/lenses.md`. Use only the lenses that could change the decision; a short idea does not need a ceremonial pass through all seventeen.
5. **Argue against the idea.** Write the strongest fair case for doing nothing or choosing the best alternative. Do not create a straw man.
6. **Reach a provisional verdict.** Use one of: promising, conditional, or not supported yet. State what evidence would change the verdict.
7. **Capture the result.** For a reusable review, read `skills/business-idea-stress-test/references/map-template.md` and produce or update a Markdown artifact. Reuse its identifier within the conversation. For a small request, answer in chat.

## Interaction

- Ask no more than three questions in one round, and only when their answers can change the load-bearing assumptions or verdict.
- Choices, risk tolerance, budget and policy decisions belong to the user. Recommendations are not decisions.
- Pair every material weakness with a validation step, mitigation, cheaper alternative, or explicit reason it cannot be fixed.
- Say plainly when the case is strong. The purpose is decision quality, not automatic rejection.

## Rules

- Never turn an estimate into a fact through polished wording.
- Never imply that the Map persists across separate conversations. It can be revised while the artifact remains available in the current conversation.
- Compliance, privacy, security, legal and works-council questions are decision inputs, not approvals supplied by this workflow.
