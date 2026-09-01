# Jira CSV handoff reference

Use this only after the user approves the preview and identifies the Jira import flow and target configuration. Jira field names, work types, hierarchy and required fields vary; the user's live target is authoritative.

## Choose columns from the target

Start with the fields the user confirmed. A common hierarchy-capable shape is:

```csv
Work Item ID,Summary,Work Type,Description,Parent,Priority,Labels,Due Date
```

Add Assignee, Component, Fix Version, Project or Space Key, or link columns only when the target requires them and the user supplied valid values. Do not ask about a mandatory field and then omit it.

## Relationships

- Give every new row a unique temporary Work Item ID.
- Put each parent before its children and reference the parent's temporary ID in Parent.
- Jira's ordinary bulk-create importer and administrative External System Import support different hierarchy behaviour. Use the flow the user named; do not claim multi-level hierarchy will work in an unidentified importer.
- Add issue-link columns only when the target link type exists and the import flow supports mapping it.
- Preserve one declared direction. If a row's `Blocks` value is another temporary ID, state: “this row blocks that ID.” If the preview is stored as `Blocked by`, invert it deliberately rather than copying the value unchanged.

## CSV correctness

- Encode as UTF-8 and use commas unless the selected importer is configured otherwise.
- Quote every value containing a comma, quote, carriage return, or line break. Double embedded quote characters.
- Keep real line breaks in a quoted Description only when the selected importer supports them; otherwise flatten the description.
- Use one consistent date pattern and tell the user to configure the Jira import wizard to the same pattern. Never invent dates.
- Repeat a column header only for a confirmed multi-value field supported by the selected importer.
- Put parent rows before children. Put referenced rows before link rows when the importer requires it.

## Description content

Use this compact structure inside Description:

```text
What this delivers
<observable outcome>

Done when
- <criterion>
- <criterion>

Owner
<confirmed role or name, or unassigned>

Context
<decision or source plan>
```

Before handing over CSV content, verify the number of fields in every row matches the header and visually inspect the first three rows with the user.
