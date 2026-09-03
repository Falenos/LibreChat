'use strict';

const mockSpan = {
  setAttributes: jest.fn(),
  setStatus: jest.fn(),
  end: jest.fn(),
};
const mockObservation = {
  update: jest.fn(),
  end: jest.fn(),
};
mockObservation.update.mockReturnValue(mockObservation);
const mockShutdown = jest.fn().mockResolvedValue(undefined);
const mockProvider = { shutdown: mockShutdown };
const mockSetLangfuseTracerProvider = jest.fn();
const mockStartObservation = jest.fn(() => mockObservation);

jest.mock('@opentelemetry/api', () => ({
  context: {
    active: jest.fn(() => ({})),
    with: jest.fn((_context, work) => work()),
  },
  SpanStatusCode: { ERROR: 2 },
  trace: {
    getTracer: jest.fn(() => ({ startSpan: jest.fn(() => mockSpan) })),
    setSpan: jest.fn(() => ({})),
  },
}));
jest.mock('@langfuse/otel', () => ({ LangfuseSpanProcessor: jest.fn() }));
jest.mock('@langfuse/tracing', () => ({
  setLangfuseTracerProvider: mockSetLangfuseTracerProvider,
  startObservation: mockStartObservation,
}));
jest.mock('@opentelemetry/sdk-trace-base', () => ({
  BasicTracerProvider: jest.fn(() => mockProvider),
}));

describe('[knauf] translation observability', () => {
  beforeAll(() => {
    process.env.LANGFUSE_ENABLED = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test';
  });

  afterAll(() => {
    delete process.env.LANGFUSE_ENABLED;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
  });

  it('exports redacted job metadata and a bounded failure code to both backends', async () => {
    const {
      beginTranslationObservation,
      shutdownTranslationObservability,
    } = require('./observability');
    const observation = beginTranslationObservation(
      {
        job_id: 'job-1',
        user: 'secret-user',
        tenantId: 'secret-tenant',
        source_locale: 'en',
        target_locale: 'de',
        input_files: [{ filename: 'secret.idml' }],
        preserve_terms: ['HERADESIGN'],
        attempt_count: 2,
        target_generation: 3,
      },
      { warn: jest.fn() },
    );

    await expect(observation.run(async () => 'done')).resolves.toBe('done');
    observation.setOutcome('failed', 'Provider Error / 503');
    observation.end();
    await shutdownTranslationObservability();

    expect(mockStartObservation).toHaveBeenCalledWith(
      'translate-file',
      {
        metadata: {
          jobId: 'job-1',
          sourceLocale: 'en',
          targetLocale: 'de',
          fileCount: 1,
          preserveTermCount: 1,
          attempt: 2,
          generation: 3,
        },
      },
      { asType: 'span' },
    );
    expect(mockSpan.setAttributes).toHaveBeenCalledWith({
      'translation.outcome': 'failed',
      'translation.error_code': 'provider_error___503',
    });
    expect(mockObservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'ERROR',
        metadata: expect.objectContaining({
          jobId: 'job-1',
          outcome: 'failed',
          errorCode: 'provider_error___503',
        }),
      }),
    );
    expect(mockShutdown).toHaveBeenCalled();
  });
});
