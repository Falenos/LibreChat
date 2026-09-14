import { isKnaufFileTranslationEnabled } from './translationEnvGuard';

// [knauf] KK20-297 — pins the canonical File Translation availability decision shared
// by `agents/load.ts` (tool injection) and `skills/handlers.ts` (Skills API catalog).
describe('[knauf] isKnaufFileTranslationEnabled', () => {
  const configuredEnv = {
    KNAUF_FILE_TRANSLATION_ENABLED: 'true',
    AZURE_TRANSLATOR_ENDPOINT: 'https://example.cognitiveservices.azure.com/',
    AZURE_TRANSLATOR_KEY: 'test-key',
  } as NodeJS.ProcessEnv;

  it('is enabled only when the flag and both Azure credentials are present', () => {
    expect(isKnaufFileTranslationEnabled(configuredEnv)).toBe(true);
  });

  it('is disabled when the operator flag is not exactly "true"', () => {
    expect(
      isKnaufFileTranslationEnabled({ ...configuredEnv, KNAUF_FILE_TRANSLATION_ENABLED: 'false' }),
    ).toBe(false);
    expect(
      isKnaufFileTranslationEnabled({
        ...configuredEnv,
        KNAUF_FILE_TRANSLATION_ENABLED: undefined,
      }),
    ).toBe(false);
  });

  it('is disabled when either Azure credential is missing, even with the flag on', () => {
    expect(
      isKnaufFileTranslationEnabled({ ...configuredEnv, AZURE_TRANSLATOR_ENDPOINT: undefined }),
    ).toBe(false);
    expect(
      isKnaufFileTranslationEnabled({ ...configuredEnv, AZURE_TRANSLATOR_KEY: undefined }),
    ).toBe(false);
  });
});
