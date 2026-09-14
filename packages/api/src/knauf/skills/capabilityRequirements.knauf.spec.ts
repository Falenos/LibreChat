import {
  isSkillAvailableForCodeEnvironment,
  isSkillAvailableForFileTranslation,
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

// [knauf] KK20-297 — same fail-closed contract as Code Execution, applied to the
// deployment-baked `karl-file-translation` skill so the `$` popover never advertises
// it while `KNAUF_FILE_TRANSLATION_ENABLED`/Azure credentials are not fully configured.
describe('[knauf] file-translation-dependent skill availability', () => {
  it('keeps ordinary skills available when File Translation is disabled', () => {
    expect(isSkillAvailableForFileTranslation({ allowedTools: ['read_file'] }, false)).toBe(true);
  });

  it('hides translate_file skills unless the effective environment is enabled', () => {
    const skill = { allowedTools: ['translate_file'] };

    expect(isSkillAvailableForFileTranslation(skill, undefined)).toBe(false);
    expect(isSkillAvailableForFileTranslation(skill, false)).toBe(false);
    expect(isSkillAvailableForFileTranslation(skill, true)).toBe(true);
  });

  it('composes with the Code Execution gate so either disabled dependency hides a skill', async () => {
    const listPage = jest.fn().mockResolvedValue({
      skills: [
        { allowedTools: ['translate_file'], name: 'karl-file-translation' },
        { allowedTools: ['execute_code'], name: 'karl-data-analysis' },
        { allowedTools: ['read_file'], name: 'visible' },
      ],
      has_more: false,
      after: null,
    });

    await expect(
      listSkillsAvailableForCodeEnvironment({
        listPage,
        limit: 3,
        cursor: null,
        codeEnvAvailable: true,
        fileTranslationAvailable: false,
      }),
    ).resolves.toEqual({
      skills: [
        { allowedTools: ['execute_code'], name: 'karl-data-analysis' },
        { allowedTools: ['read_file'], name: 'visible' },
      ],
      has_more: false,
      after: null,
    });

    await expect(
      listSkillsAvailableForCodeEnvironment({
        listPage,
        limit: 3,
        cursor: null,
        codeEnvAvailable: true,
        fileTranslationAvailable: true,
      }),
    ).resolves.toEqual({
      skills: [
        { allowedTools: ['translate_file'], name: 'karl-file-translation' },
        { allowedTools: ['execute_code'], name: 'karl-data-analysis' },
        { allowedTools: ['read_file'], name: 'visible' },
      ],
      has_more: false,
      after: null,
    });
  });
});
