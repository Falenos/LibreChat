import { isSkillAvailableForCodeEnvironment } from './capabilityRequirements';

describe('[knauf] code-dependent skill availability', () => {
  it('keeps ordinary skills available when Code Execution is disabled', () => {
    expect(isSkillAvailableForCodeEnvironment({ allowedTools: ['read_file'] }, false)).toBe(true);
  });

  it('hides execute_code skills unless the effective environment is enabled', () => {
    const skill = { allowedTools: ['execute_code'] };

    expect(isSkillAvailableForCodeEnvironment(skill, undefined)).toBe(false);
    expect(isSkillAvailableForCodeEnvironment(skill, false)).toBe(false);
    expect(isSkillAvailableForCodeEnvironment(skill, true)).toBe(true);
  });
});
