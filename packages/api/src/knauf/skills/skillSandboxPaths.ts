/**
 * [knauf] KK20-397 — where a skill's bundled files are in the code sandbox, in words the
 * model can act on.
 *
 * `primeSkillFiles` uploads a skill's bundled files (scripts, fonts, templates) under
 * `<skill>/<relativePath>`, and code-adapter 0.4.0 mounts them at exactly that path under
 * /mnt/data. Nothing told the model so: the `skill` tool result said only "loaded", and
 * `read_file`'s "use bash" hints pointed at `/mnt/data/<the read_file path>`, i.e.
 * `/mnt/data/skills/<skill>/…`, which never exists. A skill whose workflow is "run the
 * bundled helper" therefore started by guessing paths.
 */

const MAX_EXAMPLES = 3;

/** The sandbox path of one bundled skill file. */
export function skillSandboxPath(skillName: string, relativePath: string): string {
  return `/mnt/data/${skillName}/${relativePath}`;
}

/**
 * The line appended to the `skill` tool result. `mountedNames` are the names the files were
 * primed under (`<skill>/<relativePath>`); `null` means priming was not attempted (no code
 * execution, or no bundled files), `[]` that it was attempted and failed.
 */
export function describeSkillSandboxMount(
  skillName: string,
  mountedNames: readonly string[] | null,
): string {
  if (mountedNames == null) {
    return '';
  }
  if (mountedNames.length === 0) {
    return (
      ` This skill's bundled files could not be placed in the code sandbox for this run, so ` +
      `/mnt/data/${skillName}/ is not available; do not look for them there.`
    );
  }
  const examples = mountedNames
    .slice(0, MAX_EXAMPLES)
    .map((name) => `/mnt/data/${name}`)
    .join(', ');
  return (
    ` Its bundled files are mounted read-only in the code sandbox under /mnt/data/${skillName}/ ` +
    `(for example ${examples}). Run bundled Python with \`python3 -B\` and write outputs ` +
    'elsewhere — files in that folder cannot be changed.'
  );
}
