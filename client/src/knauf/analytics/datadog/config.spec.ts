jest.mock('./beforeSend', () => ({
  rumBeforeSend: jest.fn(),
  logsBeforeSend: jest.fn(),
}));

import { getRumConfig, getLogsConfig, resolveEnv } from './config';

describe('config', () => {
  describe('resolveEnv', () => {
    it('returns "prod" for production hostnames', () => {
      expect(resolveEnv('agentic-karl.knauf.com')).toBe('prod');
      expect(resolveEnv('agentic-karl.agk.prod.knauf.digital')).toBe('prod');
    });

    it('returns "dev" for dev/nonprod hostnames', () => {
      expect(resolveEnv('agentic-karl.agk.dev.knauf.digital')).toBe('dev');
      expect(resolveEnv('agentic-karl.dev.knauf.digital')).toBe('dev');
      expect(resolveEnv('something.nonprod.knauf.digital')).toBe('dev');
    });

    it('returns "local" for localhost or unknown hosts', () => {
      expect(resolveEnv('localhost')).toBe('local');
      expect(resolveEnv('')).toBe('local');
      expect(resolveEnv('example.com')).toBe('local');
    });
  });

  describe('getRumConfig', () => {
    it('returns Knauf defaults with hardcoded credentials', () => {
      const config = getRumConfig();

      expect(config.applicationId).toBe('1268732f-53c3-48d0-ac2b-fd564cfefe36');
      expect(config.clientToken).toBe('pubbc77d2e967e9fa2f4a24de29ab0e61c6');
      expect(config.site).toBe('datadoghq.eu');
      expect(config.service).toBe('agentic-karl');

      expect(config.sessionSampleRate).toBe(100);
      expect(config.sessionReplaySampleRate).toBe(0);
      expect(config.trackUserInteractions).toBe(true);
      expect(config.trackResources).toBe(true);
      expect(config.trackLongTasks).toBe(true);
      expect(config.defaultPrivacyLevel).toBe('mask-user-input');
      expect(config.trackingConsent).toBe('not-granted');
      expect(config.silentMultipleInit).toBe(true);
      expect(config.beforeSend).toBeDefined();
    });
  });

  describe('getLogsConfig', () => {
    it('returns Knauf defaults for logs', () => {
      const config = getLogsConfig();

      expect(config.clientToken).toBe('pubbc77d2e967e9fa2f4a24de29ab0e61c6');
      expect(config.site).toBe('datadoghq.eu');
      expect(config.service).toBe('agentic-karl');
      expect(config.forwardConsoleLogs).toEqual(['error']);
      expect(config.forwardErrorsToLogs).toBe(true);
      expect(config.trackingConsent).toBe('not-granted');
      expect(config.silentMultipleInit).toBe(true);
      expect(config.beforeSend).toBeDefined();
    });
  });
});
