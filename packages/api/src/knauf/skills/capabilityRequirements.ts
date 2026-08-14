import { Tools } from 'librechat-data-provider';

export type SkillCapabilityRequirements = {
  allowedTools?: readonly string[];
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
