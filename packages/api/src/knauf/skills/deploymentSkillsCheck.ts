/**
 * [knauf] KK20-243 — boot-time verification that the deployment skills we ship
 * in the image actually loaded.
 *
 * Why this exists at all. Deployment skills are plain files baked into the
 * image (`Dockerfile` `COPY . .` -> `/app/skill`) and read into an in-memory
 * registry at boot by `initializeDeploymentSkills`. Two properties of that
 * loader combine badly:
 *
 *  1. A missing or empty directory is *tolerated*. `loadDeploymentSkillsFromDirectory`
 *     only throws on ENOENT when `DEPLOYMENT_SKILLS_DIR` was set explicitly.
 *     We do not set it, so an empty `/app/skill` yields an empty registry and a
 *     successful boot.
 *  2. The zero case logs at `debug`:
 *       logger.debug('[deploymentSkills] No deployment skills loaded from ...')
 *     At our default log level that is invisible.
 *
 * So the whole feature can vanish from an environment without a single warning:
 * `skillsCapabilityEnabled` stays true, the RBAC permission stays granted, the
 * `$` popover is simply empty and the brand tokens are silently unavailable.
 *
 * The concrete way that happens: `/app/skill` is pre-created in the Dockerfile
 * in the same `mkdir -p` as `/app/uploads` and `/app/logs` — i.e. upstream
 * treats it as a volume mount point — and `docker-compose.yml` does mount
 * `./skill:/app/skill`. We rely on the baked-in copy instead. Dev mounts
 * nothing there today (verified against `agk-deployment-configs`
 * `agentic-karl/dev/services/agentic-karl/values.yaml`, whose only volume is
 * the `karlshare` Azure Files share at `/app/client/public/images`), but any
 * future chart change that adds a volume at `/app/skill` shadows the image copy
 * with an empty directory. This check is what turns that from silent into loud.
 *
 * Deliberately NON-FATAL. A missing markdown file must not crashloop KARL:
 * chat, agents and file search are all unaffected, so the correct posture is
 * degraded-and-noisy rather than down. Note the asymmetry with upstream, which
 * *does* fail the boot for a malformed `SKILL.md` (an unknown frontmatter key
 * throws out of `loadDeploymentSkill`) — that is a build-time authoring error
 * caught by CI, whereas this is a deploy-time environment error that only
 * production can reveal.
 */
import { logger } from '@librechat/data-schemas';

/**
 * The skills this image is expected to ship, by frontmatter `name`.
 *
 * Single source of truth: `packages/api/src/skills/__tests__/deploymentSkills.knauf.spec.ts`
 * asserts the real `skill/` tree loads to *exactly* this set, so adding or
 * parking a skill without updating this list fails CI. That keeps the runtime
 * check honest without it having to guess.
 *
 * Renaming a shipped skill is a breaking change regardless of this list — the
 * skill id derives from the name, so a rename mints a new skill and drops every
 * user's per-skill active state.
 */
export const KNAUF_EXPECTED_DEPLOYMENT_SKILLS: readonly string[] = Object.freeze([
  'karl-artifacts',
  'karl-brand',
  'karl-mermaid',
]);

export interface DeploymentSkillCheckResult {
  /** True when every expected skill is present. Extras do not fail the check. */
  ok: boolean;
  /** Expected skills that did not load. The actionable field. */
  missing: string[];
  /** Loaded skills not on the expected list. Informational, never a failure. */
  unexpected: string[];
  /** Loaded skill names, sorted, for the log line. */
  loaded: string[];
  /** Resolved directory the loader scanned, echoed so the log names the path. */
  directory: string;
}

export interface DeploymentSkillCheckInput {
  /** Skill names from the loaded registry (`registry.list().map((s) => s.name)`). */
  loadedNames: readonly string[];
  /** Directory the registry loaded from (`registry.getDirectory()`). */
  directory: string;
  /**
   * Override the expected set. Present for tests and for a future environment
   * that legitimately ships a different bundle; production passes nothing.
   */
  expected?: readonly string[];
}

/**
 * Deterministic ordering for the log lines and the returned arrays. The locale
 * is pinned rather than left to the runtime default so two pods in two
 * environments never disagree about the order of the same skill list — an
 * unpinned `localeCompare` reads `LANG`/ICU defaults, which is exactly the kind
 * of environment-dependent behaviour a diagnostic must not have.
 */
const bySkillName = (a: string, b: string): number => a.localeCompare(b, 'en');

/**
 * Pure comparison — no logging, no I/O, no process state. Kept separate from
 * `reportDeploymentSkillCheck` so the decision logic is testable without
 * capturing a logger.
 *
 * Duplicate names cannot reach here in practice (`validateUniqueNames` throws
 * during load) but are de-duplicated anyway so a future loader change cannot
 * turn this into a misleading `missing` report.
 */
export function checkDeploymentSkills({
  loadedNames,
  directory,
  expected = KNAUF_EXPECTED_DEPLOYMENT_SKILLS,
}: DeploymentSkillCheckInput): DeploymentSkillCheckResult {
  const loadedSet = new Set(loadedNames);
  const expectedSet = new Set(expected);

  const missing = [...expectedSet].filter((name) => !loadedSet.has(name)).sort(bySkillName);
  const unexpected = [...loadedSet].filter((name) => !expectedSet.has(name)).sort(bySkillName);

  return {
    ok: missing.length === 0,
    missing,
    unexpected,
    loaded: [...loadedSet].sort(bySkillName),
    directory,
  };
}

/**
 * Logs the check result at a level that matches its operational severity.
 *
 * `error` rather than `warn` for a missing skill: this only ever fires on a
 * misconfigured deployment, never on a healthy one, so it should reach the
 * alerting path rather than sit in the warning noise floor. The messages name
 * the directory and the likely cause, because the person reading them at 2am
 * will not have this file open.
 */
export function reportDeploymentSkillCheck(result: DeploymentSkillCheckResult): void {
  const { ok, missing, unexpected, loaded, directory } = result;

  if (unexpected.length > 0) {
    logger.info(
      `[knauf][deploymentSkills] Loaded ${unexpected.length} unlisted skill(s): ${unexpected.join(', ')}. ` +
        'Not an error — update KNAUF_EXPECTED_DEPLOYMENT_SKILLS if this is intentional.',
    );
  }

  if (ok) {
    // "Loaded:" is labelled separately from the expected count because with an
    // unlisted skill present the two differ, and "all 3 expected" followed by
    // four names makes the reader do arithmetic to decide if it is healthy.
    logger.info(
      `[knauf][deploymentSkills] OK — all ${KNAUF_EXPECTED_DEPLOYMENT_SKILLS.length} expected skill(s) present in ${directory}. Loaded: ${loaded.join(', ')}`,
    );
    return;
  }

  if (loaded.length === 0) {
    logger.error(
      `[knauf][deploymentSkills] NO skills loaded from ${directory} — expected ${missing.join(', ')}. ` +
        'Artifacts still work, but the Knauf brand tokens, artifact templates, and Mermaid guidance are unavailable and the `$` popover is empty. ' +
        'Most likely cause: a volume is mounted over that path, shadowing the copy baked into the image — ' +
        'check for a volumeMount at /app/skill in the Helm values. Also verify DEPLOYMENT_SKILLS_DIR is unset.',
    );
    return;
  }

  logger.error(
    `[knauf][deploymentSkills] Missing ${missing.length} expected skill(s) from ${directory}: ${missing.join(', ')}. ` +
      `Loaded: ${loaded.join(', ')}. A partial load points at the skill directory rather than the mount — ` +
      'a skill whose SKILL.md failed validation would have thrown and prevented boot, so this is more likely a missing or renamed directory.',
  );
}

/**
 * Convenience wrapper for the boot path: compare, log, return the result so a
 * caller can act on it if we ever want to (a metric, a readiness gate).
 * Returns rather than throws — see the non-fatal note in the file header.
 */
export function verifyDeploymentSkills(
  input: DeploymentSkillCheckInput,
): DeploymentSkillCheckResult {
  const result = checkDeploymentSkills(input);
  reportDeploymentSkillCheck(result);
  return result;
}
