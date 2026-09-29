/**
 * [knauf] KK20-397 — deployment-skill files that reach the code sandbox and nowhere else.
 *
 * WHY THIS EXISTS
 * Everything under `skill/<name>/` is loaded, shipped in the image and primed into the
 * sandbox — and also listed in the Skills panel and downloadable through
 * `GET /api/skills/:id/files/:path` by every user, because deployment skills grant VIEW to
 * all (`canAccessSkillResource`). That is fine for scripts, references and the public
 * wordmark; it is not fine for the licensed Knauf fonts, which the Office/PDF skills need in
 * the sandbox so LibreOffice and reportlab render and embed the real typefaces.
 *
 * Convention: a deployment skill's `sandbox/` folder holds such files. The Skills API does
 * not list them and answers a direct request with the same 404 as a missing file (no
 * existence oracle); priming and the model's `read_file` are unaffected. Delivering them back
 * out of the sandbox is stopped separately, by the code-output policy on the api side
 * (api/server/services/Files/knauf/codeOutputPolicy.js).
 */
import { isDeploymentSkillFileSource } from '~/skills/deployment';

export const SANDBOX_ONLY_SKILL_DIR = 'sandbox/';

export function isSandboxOnlySkillFile(file: {
  source?: unknown;
  relativePath?: unknown;
}): boolean {
  return (
    isDeploymentSkillFileSource(file.source) &&
    typeof file.relativePath === 'string' &&
    file.relativePath.startsWith(SANDBOX_ONLY_SKILL_DIR)
  );
}
