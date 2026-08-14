import {
  isSkillAvailableForCodeEnvironment,
  listSkillsAvailableForCodeEnvironment,
} from './capabilityRequirements';

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

  it('fills pages after hidden code-dependent skills without skipping the next cursor', async () => {
    const listPage = jest
      .fn()
      .mockResolvedValueOnce({
        skills: [
          { allowedTools: ['execute_code'], name: 'hidden-1' },
          { allowedTools: ['read_file'], name: 'visible-1' },
          { allowedTools: ['execute_code'], name: 'hidden-2' },
        ],
        has_more: true,
        after: 'cursor-1',
      })
      .mockResolvedValueOnce({
        skills: [
          { allowedTools: ['read_file'], name: 'visible-2' },
          { allowedTools: [], name: 'visible-3' },
        ],
        has_more: true,
        after: 'cursor-2',
      });

    await expect(
      listSkillsAvailableForCodeEnvironment({
        listPage,
        limit: 3,
        cursor: null,
        codeEnvAvailable: false,
      }),
    ).resolves.toEqual({
      skills: [
        { allowedTools: ['read_file'], name: 'visible-1' },
        { allowedTools: ['read_file'], name: 'visible-2' },
        { allowedTools: [], name: 'visible-3' },
      ],
      has_more: true,
      after: 'cursor-2',
    });
    expect(listPage).toHaveBeenNthCalledWith(1, { limit: 3, cursor: null });
    expect(listPage).toHaveBeenNthCalledWith(2, { limit: 2, cursor: 'cursor-1' });
  });

  it('returns an exhausted page when only hidden skills remain', async () => {
    const listPage = jest.fn().mockResolvedValue({
      skills: [{ allowedTools: ['execute_code'] }],
      has_more: false,
      after: null,
    });

    await expect(
      listSkillsAvailableForCodeEnvironment({
        listPage,
        limit: 2,
        cursor: 'cursor-1',
        codeEnvAvailable: false,
      }),
    ).resolves.toEqual({ skills: [], has_more: false, after: null });
  });

  it('rejects a non-advancing backend cursor instead of looping', async () => {
    const listPage = jest.fn().mockResolvedValue({
      skills: [{ allowedTools: ['execute_code'] }],
      has_more: true,
      after: 'cursor-1',
    });

    await expect(
      listSkillsAvailableForCodeEnvironment({
        listPage,
        limit: 1,
        cursor: 'cursor-1',
        codeEnvAvailable: false,
      }),
    ).rejects.toThrow('Skills pagination cursor did not advance');
  });
});
