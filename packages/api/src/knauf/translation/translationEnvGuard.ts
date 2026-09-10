/**
 * [knauf] KK20-297 — canonical operator decision for File Translation availability.
 *
 * WHY THIS EXISTS
 * `packages/api/src/agents/load.ts` already fails closed on this exact check before
 * injecting the request-scoped `translate_file`/`translation_status` tools, so a
 * disabled environment (prod, today) never registers a working tool. The Skills API
 * catalog (`packages/api/src/skills/handlers.ts`) did not consult that same decision,
 * so the deployment-baked `karl-file-translation` skill kept appearing in the `$`
 * skill popover on every environment — including prod, where selecting it produces a
 * skill with no working tool behind it. This guard is the single source of truth both
 * call sites now share (extracted out of `agents/load.ts`) so skill visibility can
 * never drift from tool availability again.
 *
 * WHAT COUNTS AS CONFIGURED
 * The explicit operator flag AND both Azure Translator credentials must be present.
 * Partial configuration (flag on, credentials missing, or vice versa) reads as
 * unavailable everywhere.
 */
export function isKnaufFileTranslationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.KNAUF_FILE_TRANSLATION_ENABLED === 'true' &&
    Boolean(env.AZURE_TRANSLATOR_ENDPOINT && env.AZURE_TRANSLATOR_KEY)
  );
}
