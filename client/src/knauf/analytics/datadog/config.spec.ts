jest.mock('./beforeSend', () => ({
  rumBeforeSend: jest.fn(),
  logsBeforeSend: jest.fn(),
}));

import type { DatadogConfig } from '../types';
import { getRumConfig, getLogsConfig } from './config';

const baseConfig: DatadogConfig = {
  clientToken: 'pub-test-token',
  site: 'datadoghq.eu',
  service: 'agentic-karl',
  env: 'prod',
  rumEnabled: true,
  browserLogsEnabled: true,
  rumApplicationId: 'test-app-id',
};

describe('config', () => {
  describe('getRumConfig', () => {
    it('maps config values to RUM init configuration', () => {
      const config = getRumConfig(baseConfig);

      expect(config.applicationId).toBe('test-app-id');
      expect(config.clientToken).toBe('pub-test-token');
      expect(config.site).toBe('datadoghq.eu');
      expect(config.service).toBe('agentic-karl');
      expect(config.env).toBe('prod');
    });

    it('applies Knauf defaults', () => {
      const config = getRumConfig(baseConfig);

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

    it('uses empty string when rumApplicationId is undefined', () => {
      const config = getRumConfig({ ...baseConfig, rumApplicationId: undefined });
      expect(config.applicationId).toBe('');
    });
  });

  describe('getLogsConfig', () => {
    it('maps config values to Logs init configuration', () => {
      const config = getLogsConfig(baseConfig);

      expect(config.clientToken).toBe('pub-test-token');
      expect(config.site).toBe('datadoghq.eu');
      expect(config.service).toBe('agentic-karl');
      expect(config.env).toBe('prod');
    });

    it('applies Knauf log defaults', () => {
      const config = getLogsConfig(baseConfig);

      expect(config.forwardConsoleLogs).toEqual(['error']);
      expect(config.forwardErrorsToLogs).toBe(true);
      expect(config.trackingConsent).toBe('not-granted');
      expect(config.silentMultipleInit).toBe(true);
      expect(config.beforeSend).toBeDefined();
    });
  });
});
