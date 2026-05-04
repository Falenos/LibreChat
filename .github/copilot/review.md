# Copilot Code Review Instructions — agentic-karl

This is a thin fork of LibreChat. Reviews must enforce fork hygiene above all else.

## Critical — Always Flag

- **Upstream file modified without `[knauf]` marker.** Any change to a file that exists in upstream LibreChat must have a `// [knauf] <reason>` comment at the modification site.
- **`[knauf]` marker without SEAMS.md entry.** Every marker must have a corresponding row in the Inline Modifications table in `SEAMS.md`.
- **SEAMS.md entry without `[knauf]` marker.** The manifest and source must stay in sync.
- **Hardcoded secrets or credentials.** No API keys, connection strings, or tokens in source. Use `.env` or Azure KeyVault.
- **Config-achievable change done in source.** If something can be changed via `librechat.yaml` or `.env`, it should not be a code change.

## Important — Flag When Seen

- **New dependency in root or workspace `package.json` instead of `packages/knauf/package.json`.** Knauf-specific dependencies belong in the Knauf package to avoid polluting upstream lockfile.
- **Extension alias changed without syncing all three locations.** Backend aliases must match in both `api/package.json` (`_moduleAliases`) and `api/babel.config.js` (`module-resolver`). Frontend aliases live in `client/vite.config.ts` (`resolve.alias`).
- **Direct modification when extension would work.** If the change can be achieved via `api/extend/` or `client/src/extend/` override, prefer that over modifying the upstream file.
- **New test file missing from workspace test aggregation.** If adding a new test workspace, ensure it's wired into `test:all` and `test:coverage` in root `package.json`.

## Informational — Mention If Relevant

- **Large upstream file modifications.** If a PR touches many lines in upstream files, suggest breaking into smaller seams or using the extension system instead.
- **Missing test coverage for Knauf code.** New code in `knauf/` directories or `extend/` overrides should have tests.
- **`packages/knauf/` changes without `npm install`.** Adding dependencies to `packages/knauf/package.json` requires running `npm install` to update the lockfile.
