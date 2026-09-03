---
name: maintain-release-notes
description: Capture user-visible KARL features and fixes in the bilingual pending log, and publish shipped entries into the bundled help page. Use after implementing any user-facing change and during the weekly KARL release-note publication.
---

# Maintain KARL Release Notes

Keep release notes accurate, bilingual, and tied to shipped behavior.

## Capture a change

1. Confirm the change is visible or useful to users. Skip internal refactors, tests, dependency
   maintenance, and incomplete work.
2. Append one row to `knauf/docs/release-notes/unreleased.md`.
3. Write the user outcome, not implementation details. Keep English and German meaning equivalent.
4. Include the Jira ticket. Never include secrets, internal hostnames, incident details, or claims
   that were not tested.
5. Replace any `|` in note text with `\|` so the Markdown table remains valid.

Use this format:

```markdown
| YYYY-MM-DD | KK20-123 | Users can … | Nutzer können … |
```

## Publish the weekly notes

The `Publish KARL Release Notes` workflow runs every Monday at 07:00 UTC and can also be started
with `workflow_dispatch`. It opens a reviewable PR instead of writing directly to `main`.

The workflow:

1. Reads every pending row already merged into `main`.
2. Adds one bilingual publication group to `knauf/docs/release-notes/published.json`.
3. Regenerates both marked release-note sections in `client/public/help/index.html`.
4. Keeps the latest eight groups expanded and retains older groups in a collapsed archive.
5. Removes only the published rows from `unreleased.md`.
6. Opens one PR. A later run skips while an automation release-notes PR remains open.

Do not hand-edit content between the `release-notes:{en,de}:begin/end` markers. To publish locally
or recover a failed workflow, start from a clean `main` worktree and run:

```bash
node knauf/scripts/publish-release-notes.js --date=YYYY-MM-DD
node knauf/scripts/publish-release-notes.js --check
node --test knauf/scripts/publish-release-notes.spec.js
cd client
npm run test:ci -- --runInBand \
  src/knauf/components/Header/KnaufTopBar.knauf.spec.tsx \
  src/knauf/components/Header/KnaufHelpDialog.knauf.spec.tsx
npm run build
test -f dist/help/index.html
```

Review the generated English/German wording and included tickets before merging the PR. Run
Prettier and `git diff --check` before committing any manual recovery.
