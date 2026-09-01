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

1. Start from a clean worktree synchronized with the release candidate branch. Use the exact
   previous-release and candidate commits supplied by the release workflow; do not guess a range.
2. Read the pending rows and verify each ticket/change is merged inside that release range. Treat
   inclusion in the approved release candidate as the ship signal; leave every other row pending.
3. Combine duplicate entries and group related outcomes. Keep the wording short and non-technical.
4. Add a newest-first dated list to both `#en-release-notes` and `#de-release-notes` in
   `client/public/help/index.html`, matching the existing `<h3>date</h3><ul><li>…</li></ul>` shape.
5. Remove only the published rows from `unreleased.md`; Git history remains the audit trail.
6. Verify the English-default selector and both translations with:

   ```bash
   cd client
   npm run test:ci -- --runInBand src/knauf/components/Header/KnaufTopBar.knauf.spec.tsx
   ```

7. Run Prettier and `git diff --check` before committing.
