/**
 * [knauf] KK20-252 — prepare a skill's SKILL.md for injection into the model's
 * context.
 *
 * ## Why this exists
 *
 * A skill body is injected as a **user** message. `buildSkillPrimeMessage`
 * (`packages/api/src/agents/skills.ts`) sets `role: 'user'`, and the SDK converts
 * it to a `HumanMessage` — `additional_kwargs.role` is metadata only, because
 * Anthropic and Google reject mid-conversation SystemMessages. The tool result
 * itself is one sentence ("Skill X loaded. Follow the instructions below."), so
 * the entire file arrives as the raw content of a user turn.
 *
 * Upstream passes `skill.body` verbatim, and `body` is the **whole file** —
 * `loadDeploymentSkill` sets `body: content` including the YAML frontmatter. So
 * the model received a user message opening with:
 *
 *     ---
 *     name: karl-artifacts
 *     description: >-
 *       Building KARL artifacts (the live preview panel): React, HTML, ...
 *     user-invocable: true
 *     ---
 *
 * followed by several hundred lines of second-person imperatives. A user turn
 * that opens by declaring a name, a description and invocation flags, then issues
 * instructions, is shaped exactly like an indirect prompt injection. Confirmed in
 * a Langfuse trace (KK20-252): message 4 was `role: user` with that frontmatter,
 * and the model's next output was "I'm sorry, but I cannot assist with that
 * request."
 *
 * ## Why strip at injection rather than at load
 *
 * `DeploymentSkill.body` stays byte-faithful to the file on disk. It is what the
 * read-only skills API serves, what `read_file skills/<name>/SKILL.md` returns,
 * and what `deploymentSkills.knauf.spec.ts` asserts over. Stripping at load would
 * change all of those to fix a problem that only exists at the model boundary.
 *
 * ## Why a shared helper rather than three inline edits
 *
 * There are three injection paths and they must not diverge:
 *  1. model-invoked — `buildSkillPrimeMessage` via `handleSkillToolCall`;
 *  2. manual `$` popover / `always-apply` — `buildPrime` in `injectSkillPrimes`;
 *  3. history reconstruction — `formatAgentMessages` in `@librechat/agents`,
 *     which we cannot edit, but which reads its bodies from the map built by
 *     `primeInvokedSkills` in `packages/api/src/agents/skillFiles.ts`.
 *
 * Cleaning the body at (1), (2) and the map feeding (3) covers every path a
 * provider can see, while keeping each upstream edit to an import plus one call.
 *
 * Side benefit: frontmatter is dead weight in context. The model already has the
 * name and description from the catalog, and cannot act on `user-invocable` or
 * `version`. Removing it saves ~60-90 tokens per injection, charged on **every**
 * subsequent turn because skill bodies are re-injected for the life of the
 * conversation.
 */

/**
 * Leading YAML frontmatter block: `---` on the first line through the next `---`
 * on its own line.
 *
 * Three deliberate details:
 *  - anchored at position 0, because a `---` later in the document is a
 *    horizontal rule and must survive;
 *  - `[\s\S]*?` is lazy, so the FIRST closing delimiter wins rather than the last
 *    (a greedy match would swallow the body up to a mid-document `<hr>`);
 *  - the trailing `(?:\r?\n)*` consumes the blank line(s) between the delimiter
 *    and the first heading, so the injected message starts on real content
 *    instead of leading whitespace.
 */
const LEADING_FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)*/;

/**
 * Strip a skill body's leading YAML frontmatter, if present.
 *
 * A body with no frontmatter, an unterminated `---`, or a `---` that is not on
 * line 1 is returned unchanged — the same text the model would have seen before
 * this existed. Never throws, and never returns `undefined` for a string input:
 * a body is load-bearing context, so failing open is the only safe direction.
 */
export function stripSkillFrontmatter(body: string | undefined | null): string {
  if (typeof body !== 'string' || body.length === 0) {
    return '';
  }
  return body.replace(LEADING_FRONTMATTER, '');
}

/**
 * Prepare a skill body for injection as a user-role message.
 *
 * Currently just the frontmatter strip, behind its own name so the three call
 * sites express intent ("this text is about to be shown to a model") rather than
 * a mechanism. If we later need to wrap bodies in provenance framing — e.g. a
 * `<skill name="…">` envelope so the model can tell reference material from a
 * user instruction — this is the one place it goes, and all three paths inherit
 * it without further upstream edits.
 */
export function prepareSkillBodyForInjection(body: string | undefined | null): string {
  return stripSkillFrontmatter(body);
}
