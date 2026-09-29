/**
 * [knauf] KK20-397 — tenant-scoped staging refs for deployment-skill files.
 *
 * WHY THIS EXISTS
 * Deployment skills are loaded from `skill/` into one in-memory registry shared by every
 * request in the process. Upstream records a skill file's staged `codeEnvRef` straight onto
 * that shared registry object (`updateFileCodeEnvRefs`) and then strips it again when
 * listing (`toSkillFileRow`), so the skill-file cache can never hit for a deployment skill:
 * every invocation re-uploads every bundled file. Simply un-stripping it would be wrong —
 * the ref would be whichever tenant primed last, and the code adapter authorises a
 * skill-kind object by tenant, so another tenant's run would fail with 403.
 *
 * This keeps the refs beside the registry, keyed by tenant + skill + path, and hands them
 * out only when `KNAUF_CODE_SKILL_FILE_CACHE=true` (the same gate as the freshness pair in
 * `knauf/code/skillStagingFreshness.ts`, which decides whether a recalled ref is still
 * live). The map is bounded by (tenants × shipped skill files) and dies with the process,
 * which is also what invalidates it when a new image ships different skill content.
 */
import { getTenantId } from '@librechat/data-schemas';
import type { CodeEnvRef } from 'librechat-data-provider';
import { isKnaufSkillFileCacheEnabled } from '~/knauf/code/skillStagingFreshness';

type SkillId = { toString(): string } | string;

const refs = new Map<string, CodeEnvRef>();

function keyFor(skillId: SkillId, relativePath: string, tenantId: string): string {
  return JSON.stringify([tenantId, skillId.toString(), relativePath]);
}

/** Record the staged ref a deployment-skill file was just uploaded under, for this tenant. */
export function rememberDeploymentSkillCodeEnvRef(
  skillId: SkillId,
  relativePath: string,
  codeEnvRef: CodeEnvRef,
  tenantId: string = getTenantId() ?? '',
): void {
  refs.set(keyFor(skillId, relativePath, tenantId), codeEnvRef);
}

/** This tenant's staged ref for a deployment-skill file, when the cache is enabled. */
export function recallDeploymentSkillCodeEnvRef(
  skillId: SkillId,
  relativePath: string,
  tenantId: string = getTenantId() ?? '',
  env: NodeJS.ProcessEnv = process.env,
): CodeEnvRef | undefined {
  if (!isKnaufSkillFileCacheEnabled(env)) {
    return undefined;
  }
  return refs.get(keyFor(skillId, relativePath, tenantId));
}

/** Test seam. */
export function clearDeploymentSkillCodeEnvRefs(): void {
  refs.clear();
}
