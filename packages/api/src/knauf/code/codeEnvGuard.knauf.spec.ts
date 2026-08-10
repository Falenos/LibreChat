import { logger } from '@librechat/data-schemas';
import {
  isKnaufCodeEnvConfigured,
  _resetKnaufCodeEnvWarning,
  LIBRECHAT_HOSTED_CODE_API_HOST,
} from './codeEnvGuard';

/**
 * [knauf] KK20-257. The guard's whole purpose is that a missing
 * `LIBRECHAT_CODE_BASEURL` must NOT silently fall back to LibreChat's hosted SaaS
 * (`https://api.librechat.ai/v1`), which is what `@librechat/agents` does on its own.
 * These tests pin the negative branch, because that is the one with a data-egress
 * consequence — jest.setup.cjs sets a Knauf-looking value for every other suite.
 */
describe('[knauf] isKnaufCodeEnvConfigured', () => {
  const env = (value?: string): NodeJS.ProcessEnv =>
    (value == null ? {} : { LIBRECHAT_CODE_BASEURL: value }) as NodeJS.ProcessEnv;

  beforeEach(() => {
    _resetKnaufCodeEnvWarning();
    jest.restoreAllMocks();
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  it('is configured when the base URL points at a host we control', () => {
    expect(isKnaufCodeEnvConfigured(env('http://agentic-karl-code-adapter:3112/v1'))).toBe(true);
  });

  it('is NOT configured when the base URL is unset', () => {
    expect(isKnaufCodeEnvConfigured(env())).toBe(false);
  });

  it('is NOT configured when the base URL is blank', () => {
    expect(isKnaufCodeEnvConfigured(env('   '))).toBe(false);
  });

  it('is NOT configured when the base URL is the LibreChat-hosted default', () => {
    expect(isKnaufCodeEnvConfigured(env(`https://${LIBRECHAT_HOSTED_CODE_API_HOST}/v1`))).toBe(
      false,
    );
  });

  it('ignores case and path when recognising the hosted default', () => {
    expect(isKnaufCodeEnvConfigured(env('https://API.LibreChat.ai/v1/exec'))).toBe(false);
  });

  it('is NOT configured when the base URL is unparseable', () => {
    expect(isKnaufCodeEnvConfigured(env('not-a-url'))).toBe(false);
  });

  it('warns once, not on every call', () => {
    isKnaufCodeEnvConfigured(env());
    isKnaufCodeEnvConfigured(env());
    isKnaufCodeEnvConfigured(env());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(jest.mocked(logger.warn).mock.calls[0][0]).toContain('execute_code');
  });
});
