CLAUDE.md

## Git branch synchronization

- Ordinary feature, fix, and documentation branches must be rebased onto current `origin/main`
  before final review: `git fetch origin && git rebase origin/main`.
- After rebasing a published branch, update it with `git push --force-with-lease`; never use an
  unguarded force push.
- LibreChat upstream-version imports are the exception. Their integration branches merge the
  fetched `upstream/<tag>` so shared ancestry, baseline tags, and atomic rollback are preserved.

## User-facing release notes

- After any user-visible feature or fix, use
  `.agents/skills/maintain-release-notes/SKILL.md` and append one bilingual entry to the pending
  release-note log.
- Skip internal refactors, tests, dependency maintenance, and changes that are not yet working.
- During the weekly release, use the same skill's publish workflow to move shipped entries into
  the bundled KARL help page.
