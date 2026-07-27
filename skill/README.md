# Deployment Skills

Place shared deployment skills in this directory. Each skill should live in its own folder with a
`SKILL.md` file, for example:

```text
skill/
  my-shared-skill/
    SKILL.md
    references/
      notes.md
```

These skills are loaded at server startup, exposed read-only to all users with Skills enabled, and
are not persisted as Skill documents in MongoDB.

## Current skills

| Skill | Purpose | Invocation | Gate |
|---|---|---|---|
| `karl-brand` | Single source of truth for Knauf brand tokens: official colours, validated chart palette, ink/surface tokens, the real KNAUF wordmark SVG. Read by `karl-artifacts` and usable for non-artifact deliverables. | model-invocable + `$karl-brand` | none |
| `karl-artifacts` | Choosing an artifact type, avoiding preview breakage, and the branded report / slides / dashboard templates. | model-invocable + `$karl-artifacts` | none |
| `_disabled/karl-data-analysis` | **Not loaded.** Sandbox workflow guidance (`bash_tool`, `/mnt/data`, matplotlib). Its body describes tools that do not exist while code execution is off, and its catalog entry would invite the model to promise work it cannot do. Re-enable with `git mv skill/_disabled/karl-data-analysis skill/karl-data-analysis` once `execute_code` is in `endpoints.agents.capabilities` **and** a sandbox is reachable at `LIBRECHAT_CODE_BASEURL`. | — | needs `execute_code` |

`skill/_disabled/` is not scanned: discovery only looks at `skill/SKILL.md` and the immediate
children of `skill/`, so a skill two levels down is invisible to the loader. The guard spec at
`packages/api/src/skills/__tests__/deploymentSkills.knauf.spec.ts` asserts the loaded set exactly,
so this stays true even if discovery depth changes upstream.

## Authoring rules

Learned the hard way — each of these is a silent failure otherwise.

1. **Discovery is one level deep.** `skill/<name>/SKILL.md` only. `skill/<a>/<b>/SKILL.md` is
   never found.
2. **Frontmatter is a strict allowlist, and an unknown key hard-fails the skill at load** —
   which fails `initializeDeploymentSkills`, which means **the backend does not boot**. Allowed:
   `name`, `description`, `when-to-use`, `allowed-tools`, `arguments`, `argument-hint`,
   `user-invocable`, `disable-model-invocation`, `always-apply`, `alwaysApply`, `model`, `effort`,
   `context`, `agent`, `paths`, `shell`, `hooks`, `version`, `license`, `metadata`.
3. **Descriptions are truncated at 250 characters in the model-visible catalog.** The 1024-char
   schema limit is only the storage cap; `formatSkillCatalog` slices each entry at 250. Put every
   trigger word in the first ~240 characters or the model never sees them.
4. **Reference files must not have YAML frontmatter.** Only `SKILL.md` is parsed; a leading `---`
   in a reference renders as a stray horizontal rule and wastes tokens.
5. **References are read at runtime as `skills/<name>/<path>` — plural `skills/` at runtime,
   singular `skill/` on disk.** `SKILL.md` is served from the skill body; anything else comes from
   storage. Neither needs code execution.
6. **Cross-skill reads work, but the target must stay model-invocable.** A skill whose files other
   skills read must not set `disable-model-invocation: true`, or those reads are rejected. Note
   also that a user who toggles the target skill off breaks the read — give the consumer a stated
   fallback.
7. **Symlinks are rejected at load.** To share content, duplicate it deliberately or cross-read;
   never link.
8. **Do not rename a shipped skill.** The id is derived from the name, so a rename mints a new
   skill and drops every user's per-skill active-state.
9. **Deployment skills are active by default for every user** and are read-only over the API. A
   description that advertises a capability the deployment does not have is a promise the model
   will make and fail to keep.
