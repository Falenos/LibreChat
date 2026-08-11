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
  const env = (value?: string, allowed?: string): NodeJS.ProcessEnv =>
    ({
      ...(value == null ? {} : { LIBRECHAT_CODE_BASEURL: value }),
      ...(allowed == null ? {} : { KNAUF_CODE_ALLOWED_HOSTS: allowed }),
    }) as NodeJS.ProcessEnv;

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

  /**
   * Review finding A4. The guard used to exclude only `api.librechat.ai`, so every other
   * external URL read as configured — which switches on tool registration and the upload
   * gate and posts user files plus a `User-Id` header to that host. The allowlist is the
   * point: these are the cases a denylist got wrong.
   */
  describe('only in-cluster hosts count as configured (A4)', () => {
    it.each([
      ['a bare service name', 'http://agentic-karl-code-adapter:3112/v1'],
      ['namespaced service DNS', 'http://agentic-karl-code-adapter.agentic-karl-dev.svc/v1'],
      [
        'full cluster DNS',
        'http://agentic-karl-code-adapter.agentic-karl-dev.svc.cluster.local:80/v1',
      ],
      ['loopback for local dev', 'http://localhost:3112/v1'],
      ['loopback by address', 'http://127.0.0.1:3112/v1'],
    ])('accepts %s', (_label, url) => {
      expect(isKnaufCodeEnvConfigured(env(url))).toBe(true);
    });

    it.each([
      ['an arbitrary external host', 'https://evil.example.com/v1'],
      ['a plausible typo', 'https://api.librechat.io/v1'],
      ['a public cloud endpoint', 'https://westeurope.dynamicsessions.io/v1'],
      ['an IP outside loopback', 'http://10.0.0.5:3112/v1'],
      ['a non-http scheme', 'file:///etc/passwd'],
    ])('rejects %s', (_label, url) => {
      expect(isKnaufCodeEnvConfigured(env(url))).toBe(false);
    });

    it('accepts a host named explicitly in KNAUF_CODE_ALLOWED_HOSTS', () => {
      // The escape hatch: an unforeseen topology is an ops decision in config, not a
      // reason to loosen the rule for everyone.
      expect(
        isKnaufCodeEnvConfigured(
          env('https://code.internal.knauf.digital/v1', 'code.internal.knauf.digital'),
        ),
      ).toBe(true);
    });

    it('does not let the escape hatch be matched by a suffix', () => {
      expect(
        isKnaufCodeEnvConfigured(env('https://evil-code.internal.example/v1', 'code.internal')),
      ).toBe(false);
    });

    it('names the external host in the warning so the fix is obvious', () => {
      isKnaufCodeEnvConfigured(env('https://evil.example.com/v1'));
      expect(jest.mocked(logger.warn).mock.calls[0][0]).toContain('evil.example.com');
    });
  });

  it('warns once, not on every call', () => {
    isKnaufCodeEnvConfigured(env());
    isKnaufCodeEnvConfigured(env());
    isKnaufCodeEnvConfigured(env());
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(jest.mocked(logger.warn).mock.calls[0][0]).toContain('execute_code');
  });
});
