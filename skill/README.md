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
| `agent-builder-coach` | Designs, configures, tests, and prepares governed custom agents for admin-controlled publication. | model-invocable + `$agent-builder-coach` | skill gates |
| `karl-brand` | Single source of truth for Knauf brand tokens: official colours, validated chart palette, ink/surface tokens, the real KNAUF wordmark SVG. Read by `karl-artifacts` and usable for non-artifact deliverables. | model-invocable + `$karl-brand` | skill gates |
| `karl-artifacts` | Choosing an artifact type, avoiding preview breakage, and the branded report / slides / dashboard templates. | model-invocable + `$karl-artifacts` | skill gates |
| `karl-guide` | Product guidance for Karl capabilities, navigation, roles, groups, settings, limits, and troubleshooting. | model-invocable + `$karl-guide` | skill gates |
| `karl-mermaid` | Mermaid 11.15.0 generation and repair guardrails, including sequence diagrams and streaming-sensitive `xychart-beta` output. | model-invocable + `$karl-mermaid` | skill gates |
| `web-research` | Routes current-information requests between hosted model search, exact-page HTTPS fetch, File Search, and no browsing; enforces source discipline. | model-invocable + `$web-research` | skill gates; live web calls also require `WEB_SEARCH.USE` |
| `_disabled/karl-data-analysis` | **Not loaded.** Sandbox workflow guidance (`bash_tool`, `/mnt/data`, matplotlib). Its body describes tools that do not exist while code execution is off, and its catalog entry would invite the model to promise work it cannot do. Re-enable with `git mv skill/_disabled/karl-data-analysis skill/karl-data-analysis` once `execute_code` is in `endpoints.agents.capabilities` **and** a sandbox is reachable at `LIBRECHAT_CODE_BASEURL`. | — | needs `execute_code` |

`skill/_disabled/` is not scanned: discovery only looks at `skill/SKILL.md` and the immediate
children of `skill/`, so a skill two levels down is invisible to the loader. The guard spec at
`packages/api/src/skills/__tests__/deploymentSkills.knauf.spec.ts` asserts the loaded set exactly,
so this stays true even if discovery depth changes upstream.

Skill gates are the endpoint `skills` capability, the user's `SKILLS.USE` permission, and skills
being enabled for the current chat or persisted agent.

## Per-skill maintainer constraints

These belong here rather than in a `SKILL.md`, because a SKILL.md body is injected
into the model's context as a **user message** — instructions to a human maintainer
arriving there read as instructions to the model (see authoring rule 10).

**`karl-brand`**

- **Must stay model-invocable.** Do not set `disable-model-invocation: true`.
  `karl-artifacts` reads this skill's files, and a cross-skill read is rejected when
  the target has model invocation disabled and was not primed the same turn — which
  would silently break every branded artifact.
- **Must not be renamed.** The id derives from the name, so a rename mints a new
  skill and drops every user's per-skill active-state.
- A user who switches it off breaks those cross-skill reads. `karl-artifacts`
  carries a labelled quick-card mirror for that case.

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
   singular `skill/` on disk.** Neither needs code execution, and neither touches object
   storage. `SKILL.md` is served from the skill body. Every other file is read into memory at
   boot (`readCachedFileContent`, text under 512 KB) and `read_file` returns that cached copy;
   all of ours are 3–13 KB, so the cache always hits. Only an uncached or binary file falls
   through to a stream, and even then `getSkillStrategyFunctions` intercepts the `deployment`
   source and serves it from the local filesystem via `fs.createReadStream` — never from Azure
   Blob, whatever `fileStrategy` says. Two consequences: keep text references under **256 KB**
   (`MAX_READABLE_BYTES`; between that and the 512 KB cache ceiling is a dead band where a file
   is too big to cache and too big to read), and expect no help from the storage emulator when
   debugging skills locally, because storage is not in the path.
6. **Cross-skill reads work, but the target must stay model-invocable.** A skill whose files other
   skills read must not set `disable-model-invocation: true`, or those reads are rejected. Note
   also that a user who toggles the target skill off breaks the read — give the consumer a stated
   fallback.
7. **Symlinks are rejected at load.** To share content, duplicate it deliberately or cross-read;
   never link.
8. **Do not rename a shipped skill.** The id is derived from the name, so a rename mints a new
   skill and drops every user's per-skill active-state.
9. **Deployment skills are public and read-only, but execution still has gates.** The user needs
   `SKILLS.USE`, the endpoint needs the `skills` capability, and the current chat or persisted agent
   must have skills enabled. New agents default to enabled with no allow-list; existing agents keep
   their saved state. A description that advertises a capability the deployment does not have is a
   promise the model will make and fail to keep.
10. **A SKILL.md body is injected as a `user` message, and it is written in a voice the model
    reads as instructions to itself.** `buildSkillPrimeMessage` sets `role: 'user'` and the SDK
    converts it to a `HumanMessage` — providers reject mid-conversation system messages, so there
    is no system channel available. Consequences, in order of how much they bit us (KK20-252):
    - **YAML frontmatter is stripped before injection** (`prepareSkillBodyForInjection`,
      `packages/api/src/knauf/skills/skillPrimeBody.ts`). Left in, the model saw a user turn
      opening `---\nname: …\ndescription: …\nuser-invocable: true\n---` and then several hundred
      lines of imperatives — shaped exactly like an indirect prompt injection. It responded
      *"I'm sorry, but I cannot assist with that request."*
    - **Write the body as reference material, not as commands to the model.** Domain rules
      ("never use `#FFD25C` for text") are fine — they are facts about the brand. Instructions
      about how to treat the system prompt, or aimed at a human maintainer, are not: put those
      in the section above.
    - **A skill body is charged on every subsequent turn, not just the turn it is invoked.** Once
      the model calls `skill`, `formatAgentMessages` re-injects that body for the rest of the
      conversation. Two skills is a permanent ~4.9k-token tax. Size bodies accordingly and push
      detail into `references/`, which is read on demand instead.
