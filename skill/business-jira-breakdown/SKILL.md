---
name: business-jira-breakdown
description: Turn an agreed delivery plan into Jira-ready work items with outcomes, owners, acceptance criteria, hierarchy, and true blockers. Use only when the user explicitly asks for Jira tickets, Jira import content, or a Jira work breakdown.
argument-hint: '[agreed plan to break down for Jira]'
user-invocable: true
disable-model-invocation: false
version: '1.0.0'
---

# Business Jira Breakdown

Turn an agreed plan into reviewable Jira work items. This workflow does not connect to Jira and does not change Jira data.

## Boundary

Use only when the user explicitly asks for Jira tickets, Jira import content, or a Jira work breakdown. Do not invoke for an ordinary to-do list, generic project plan, or an unagreed proposal.

An explicit `$business-jira-breakdown` invocation always counts as a request to run it.

## Establish the target

Use source context already available. Ask one compact setup round only for information that changes the output:

1. Jira project or space key and whether the target is company-managed or team-managed.
2. Exact work types and hierarchy available in that project.
3. Desired item size; recommend an outcome one person can usually complete in one to five days.
4. Mandatory fields, configured priorities, labels, components, versions, date format, and any required owner representation.
5. Whether the user needs a review table only or CSV content for a specific Jira import flow.

Do not guess project configuration. Live Jira field names and permissions win over this reference.

## Build outcomes

- Each item delivers an observable outcome, not an endless activity such as “Analysis”, “Workshop”, or “Coordination”.
- Give every item acceptance criteria that a person outside the conversation can verify.
- Make approval gates real work items with an owner and expected lead time.
- Add applicable work for privacy, security, legal or works-council review; communication; training; operational handover; measurement; and retiring the old process.
- Represent only true blockers. Preferred ordering is not a dependency.

## Review before export content

Present a numbered table first:

| #   | Work type | Summary | Owner | Parent | Blocked by | Outcome / done when |
| --- | --------- | ------- | ----- | ------ | ---------- | ------------------- |

Ask whether the granularity, hierarchy, owners, and blocking edges are correct. Revise until the user approves. Do not produce CSV content before approval.

## Produce the requested handoff

- For a review-only request, keep the approved table in chat or a Markdown artifact.
- If the user explicitly asks for Jira CSV content, read `skills/business-jira-breakdown/references/jira-csv.md` and emit the content in one `csv` fenced block after stating that KARL is not creating a downloadable file.
- Include a short field-mapping note specific to the chosen import flow.

## Rules

- Never invent an assignee, owner, due date, component, version, epic, sprint, project configuration, or Jira permission.
- Keep unknown fields empty or marked TBD in the preview; do not turn them into plausible-looking values.
- Never include credentials or unnecessary personal, customer, or contract data.
- Keep “Blocked by” direction stable in the review. When producing link columns, state exactly what each row links to so the user can verify the Jira mapping direction.
- If acceptance criteria cannot be written, the item is not understood well enough to create.
