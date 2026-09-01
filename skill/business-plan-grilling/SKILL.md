---
name: business-plan-grilling
description: Challenge execution readiness for a chosen business plan through short question rounds. Use when the user says "grill me", asks to check a plan, or wants questions before delivery. Do not use to judge an uncommitted idea or for ordinary drafting.
argument-hint: '[plan to challenge]'
user-invocable: true
disable-model-invocation: false
version: '1.0.0'
---

# Business Plan Grilling

Surface the decisions and risks that could derail an already-chosen direction before delivery starts.

## Boundary

Use this workflow when the direction is agreed and the question is: **are we ready to execute this well?**

- For “should we do this?”, use `business-idea-stress-test` instead.
- For an agreed discussion that only needs writing, use `business-case-writeup` instead.
- Do not invoke this workflow merely because an ordinary request lacks a minor detail.

An explicit `$business-plan-grilling` invocation always counts as a request to run it.

## Question rounds

1. Build the decision frontier: questions whose prerequisites are already settled and whose answers could change the deliverable or plan.
2. Ask three to six numbered questions in one round. Give a short recommended answer and reason for each.
3. Wait for the user. Recompute the frontier from the answers; do not re-ask settled decisions.
4. Two rounds should normally be enough. Stop after three unless the user explicitly wants a deeper interview.

A question dependent on another unanswered decision belongs to a later round.

Use this format:

```markdown
**Q1 — <short title>**
<question, with real options when useful>

Recommendation: <recommended answer and why>
```

Close a round with: “Answer what matters now. I can use my recommendation for low-risk presentation defaults; material business decisions will remain open.”

## Find facts; leave decisions with the user

- Use accessible conversation context, files, knowledge, or search for factual questions. Do not claim to have searched a source or system that is unavailable.
- If a fact cannot be retrieved, mark it unknown and say what evidence would settle it.
- Budget, policy, risk appetite, scope, ownership, deadlines, approval, and trade-off decisions remain with the user. Never adopt a recommendation for these because the user skipped the question.

Read `skills/business-plan-grilling/references/question-lenses.md` and use only the sections matching the plan. Skip questions already answered well.

## Finish

When no material frontier remains, provide:

1. **Shared understanding:** under fifteen lines describing the plan, basis, audience, success measure, and exclusions.
2. **Watch-outs:** three to six specific risks from the answers, each paired with an action.
3. **Open decisions:** every material skipped or unresolved decision, its owner, and what it blocks.

If the user asked for a subsequent deliverable, ask them to confirm the shared understanding before producing it. Otherwise end with the readiness assessment.

## Rules

- Sharp questions only; do not pad a round from a generic checklist.
- Recommendations must show their evidence or be labelled as judgement.
- If the plan is unsound, say so once, plainly, and state what would make it viable.
