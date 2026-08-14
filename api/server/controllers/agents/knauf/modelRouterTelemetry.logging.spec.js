jest.mock('@librechat/api', () => ({
  recordFoundryModelCall: jest.fn(),
}));
jest.unmock('winston');
jest.unmock('winston-daily-rotate-file');

const { logger, tenantStorage } = require('@librechat/data-schemas');
const { createModelRouterTelemetry } = require('./modelRouterTelemetry');

const routedResult = {
  generations: [
    [
      {
        message: {
          response_metadata: {
            model: 'model-routergpt-5.5-2026-04-01',
          },
        },
      },
    ],
  ],
};

describe('[knauf] Model Router telemetry log privacy', () => {
  it('excludes request-context identity from the transport envelope', async () => {
    const transport = logger.transports.find((candidate) => candidate.name === 'console');
    expect(transport).toBeDefined();

    const originalLoggerLevel = logger.level;
    const originalTransportLevel = transport.level;
    const originalLog = transport.log;
    const envelopes = [];

    logger.level = 'info';
    transport.level = 'info';
    transport.log = (info, callback) => {
      envelopes.push(info);
      callback();
    };

    try {
      await tenantStorage.run(
        {
          tenantId: 'tenant-secret',
          userId: 'user-secret',
          requestId: 'request-context-secret',
        },
        async () => {
          const telemetry = createModelRouterTelemetry({
            responseModelExtractor: () => 'gpt-5.5',
            correlation: { requestId: 'safe-request-correlation' },
            startedAtMs: 1_000,
            now: () => 2_000,
          });

          telemetry.handler.handleChatModelStart(
            null,
            [[]],
            'model-run-1',
            undefined,
            undefined,
            [],
            { ls_model_name: 'model-router' },
          );
          telemetry.handler.handleLLMEnd(routedResult, 'model-run-1');
          telemetry.finalize();
        },
      );

      expect(envelopes).toHaveLength(2);
      for (const envelope of envelopes) {
        expect(envelope).not.toHaveProperty('tenantId');
        expect(envelope).not.toHaveProperty('userId');
        expect(envelope.requestId).toBe('safe-request-correlation');
        expect(envelope[Symbol.for('message')]).not.toContain('tenant-secret');
        expect(envelope[Symbol.for('message')]).not.toContain('user-secret');
      }
    } finally {
      transport.log = originalLog;
      transport.level = originalTransportLevel;
      logger.level = originalLoggerLevel;
    }
  });
});
