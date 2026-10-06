/**
 * [knauf] KK20-397 — freshness predicate for the skill-file upload cache.
 *
 * WHY THIS EXISTS
 * `primeSkillFiles` / `primeInvokedSkills` (agents/skillFiles.ts) reuse a skill's staged
 * files when `getSessionInfo(ref)` + `checkIfActive(value)` say the staged copy is still
 * live. KK20-316 changed `getSessionInfo` (api/server/services/Files/Code/process.js) to
 * return the whole object-metadata record and removed `checkIfActive`, but
 * `skillDeps.js` kept importing it — so it has been `undefined` ever since, the cache
 * check is skipped, and every skill invocation (and every later turn that re-primes it)
 * re-uploads every file of the skill. For a skill that ships scripts and fonts that is
 * several MB per turn, uploaded sequentially.
 *
 * This adapter restores the pair without touching the upstream signatures: it maps the
 * metadata record to its authoritative `expiresAt`, and treats an object as active only
 * while it has at least `minRemainingMs` of staging life left — long enough that a file
 * reused now cannot expire before the run that needs it.
 *
 * It is gated by `KNAUF_CODE_SKILL_FILE_CACHE` (default off) because reuse depends on
 * code-adapter 0.4.0's read-only overwrite guard being deployed in the same environment:
 * without it, a caller that reuses a skill's staging session could replace a shared,
 * cached skill file in place. Operational probe failures propagate — the callers already
 * treat any throw as "re-upload".
 */
import type { CodeEnvRef } from 'librechat-data-provider';

/** Staging life a cached object must still have to be reused (1 h). */
export const KNAUF_SKILL_CACHE_MIN_REMAINING_MS: number = 60 * 60 * 1000;

export function isKnaufSkillFileCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KNAUF_CODE_SKILL_FILE_CACHE === 'true';
}

type ObjectInfoProbe<Req> = (
  ref: CodeEnvRef,
  req?: Req,
) => Promise<{ expiresAt?: unknown } | null | undefined>;

export interface SkillStagingFreshness<Req> {
  /** Resolves to the object's `expiresAt`, or null when it is missing or expired. */
  getSessionInfo: (ref: CodeEnvRef, req?: Req) => Promise<string | null>;
  /** True while the object still has `minRemainingMs` of staging life. */
  checkIfActive: (expiresAt: string) => boolean;
}

export function createSkillStagingFreshness<Req>(
  probe: ObjectInfoProbe<Req>,
  options: { now?: () => number; minRemainingMs?: number } = {},
): SkillStagingFreshness<Req> {
  const now = options.now ?? Date.now;
  const minRemainingMs = options.minRemainingMs ?? KNAUF_SKILL_CACHE_MIN_REMAINING_MS;
  return {
    getSessionInfo: async (ref, req) => {
      const info = await probe(ref, req);
      return typeof info?.expiresAt === 'string' && info.expiresAt !== '' ? info.expiresAt : null;
    },
    checkIfActive: (expiresAt) => {
      const expiry = Date.parse(expiresAt);
      return Number.isFinite(expiry) && expiry - now() > minRemainingMs;
    },
  };
}

/**
 * The deps `skillDeps.js` hands to the skill-file primers: the freshness pair when the
 * cache is enabled, nothing (always re-upload, the pre-fix behaviour) when it is not.
 */
export function knaufSkillCacheDeps<Req>(
  probe: ObjectInfoProbe<Req>,
  env: NodeJS.ProcessEnv = process.env,
): Partial<SkillStagingFreshness<Req>> {
  return isKnaufSkillFileCacheEnabled(env) ? createSkillStagingFreshness(probe) : {};
}
