import { Tools } from 'librechat-data-provider';

// Declared like a `Tools` capability but `translate_file` is a request-scoped
// Knauf tool (see `agents/load.ts`), not a member of the shared enum.
const FILE_TRANSLATION_TOOL = 'translate_file';

export type SkillCapabilityRequirements = {
  allowedTools?: readonly string[];
};

export type SkillPage<TSkill extends SkillCapabilityRequirements> = {
  skills: TSkill[];
  has_more: boolean;
  after: string | null;
};

/**
 * Skills may declare environment-backed tool dependencies through `allowed-tools`.
 * Keep code-dependent skills out of every resolution surface when the sandbox is off.
 */
export function isSkillAvailableForCodeEnvironment(
  skill: SkillCapabilityRequirements,
  codeEnvAvailable: boolean | undefined,
): boolean {
  return codeEnvAvailable === true || skill.allowedTools?.includes(Tools.execute_code) !== true;
}

/**
 * Same contract as `isSkillAvailableForCodeEnvironment`, applied to
 * `karl-file-translation`. Keeps the deployment-baked skill out of the catalog whenever
 * `KNAUF_FILE_TRANSLATION_ENABLED`/Azure credentials are not fully configured (prod,
 * today), so the `$` popover never advertises a skill whose tool won't be registered.
 */
export function isSkillAvailableForFileTranslation(
  skill: SkillCapabilityRequirements,
  fileTranslationAvailable: boolean | undefined,
): boolean {
  return (
    fileTranslationAvailable === true ||
    skill.allowedTools?.includes(FILE_TRANSLATION_TOOL) !== true
  );
}

/**
 * Fill an API page with environment-visible skills so cursors describe the returned
 * result set rather than a database page that may contain hidden Code Execution or
 * File Translation skills.
 */
export async function listSkillsAvailableForCodeEnvironment<
  TSkill extends SkillCapabilityRequirements,
>({
  listPage,
  limit,
  cursor,
  codeEnvAvailable,
  fileTranslationAvailable,
}: {
  listPage: (params: { limit: number; cursor: string | null }) => Promise<SkillPage<TSkill>>;
  limit: number;
  cursor: string | null;
  codeEnvAvailable: boolean | undefined;
  // Optional so existing callers are unaffected until they opt in.
  fileTranslationAvailable?: boolean;
}): Promise<SkillPage<TSkill>> {
  const skills: TSkill[] = [];
  let currentCursor = cursor;

  while (skills.length < limit) {
    const page = await listPage({
      limit: limit - skills.length,
      cursor: currentCursor,
    });
    skills.push(
      ...page.skills.filter(
        (skill) =>
          isSkillAvailableForCodeEnvironment(skill, codeEnvAvailable) &&
          isSkillAvailableForFileTranslation(skill, fileTranslationAvailable),
      ),
    );

    if (!page.has_more) {
      return { skills, has_more: false, after: null };
    }
    if (!page.after || page.after === currentCursor) {
      throw new Error('Skills pagination cursor did not advance');
    }
    currentCursor = page.after;
  }

  return { skills, has_more: true, after: currentCursor };
}
