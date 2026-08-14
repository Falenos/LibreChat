import { Tools } from 'librechat-data-provider';

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
 * Fill an API page with environment-visible skills so cursors describe the returned
 * result set rather than a database page that may contain hidden Code Execution skills.
 */
export async function listSkillsAvailableForCodeEnvironment<
  TSkill extends SkillCapabilityRequirements,
>({
  listPage,
  limit,
  cursor,
  codeEnvAvailable,
}: {
  listPage: (params: { limit: number; cursor: string | null }) => Promise<SkillPage<TSkill>>;
  limit: number;
  cursor: string | null;
  codeEnvAvailable: boolean | undefined;
}): Promise<SkillPage<TSkill>> {
  const skills: TSkill[] = [];
  let currentCursor = cursor;

  while (skills.length < limit) {
    const page = await listPage({
      limit: limit - skills.length,
      cursor: currentCursor,
    });
    skills.push(
      ...page.skills.filter((skill) => isSkillAvailableForCodeEnvironment(skill, codeEnvAvailable)),
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
