'use strict';

const { context, SpanStatusCode, trace } = require('@opentelemetry/api');
const { LangfuseSpanProcessor } = require('@langfuse/otel');
const { setLangfuseTracerProvider, startObservation } = require('@langfuse/tracing');
const { BasicTracerProvider } = require('@opentelemetry/sdk-trace-base');

const tracer = trace.getTracer('knauf.file-translation');
let langfuseProvider;
let langfuseUnavailable = false;

const safeCode = (value) =>
  String(value ?? 'none')
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, '_')
    .slice(0, 64) || 'unknown';

function getLangfuseProvider(logger) {
  if (langfuseProvider || langfuseUnavailable) return langfuseProvider;
  if (
    process.env.LANGFUSE_ENABLED === 'false' ||
    !process.env.LANGFUSE_PUBLIC_KEY ||
    !process.env.LANGFUSE_SECRET_KEY
  ) {
    langfuseUnavailable = true;
    return undefined;
  }
  try {
    langfuseProvider = new BasicTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: process.env.LANGFUSE_PUBLIC_KEY,
          secretKey: process.env.LANGFUSE_SECRET_KEY,
          baseUrl: process.env.LANGFUSE_BASE_URL,
          environment: process.env.LANGFUSE_TRACING_ENVIRONMENT,
          release: process.env.LANGFUSE_RELEASE,
          exportMode: 'batched',
        }),
      ],
    });
    setLangfuseTracerProvider(langfuseProvider);
  } catch (error) {
    langfuseUnavailable = true;
    logger?.warn('[translationWorker][langfuse] initialization failed', {
      error: safeCode(error?.name),
    });
  }
  return langfuseProvider;
}

function beginTranslationObservation(job, logger) {
  const metadata = {
    jobId: job.job_id,
    sourceLocale: job.source_locale ?? 'auto',
    targetLocale: job.target_locale,
    fileCount: job.input_files?.length ?? 0,
    attempt: job.attempt_count,
    generation: job.target_generation,
  };
  let span;
  try {
    span = tracer.startSpan('translate-file', {
      attributes: {
        'translation.job_id': metadata.jobId,
        'translation.source_locale': metadata.sourceLocale,
        'translation.target_locale': metadata.targetLocale,
        'translation.file_count': metadata.fileCount,
        'translation.attempt': metadata.attempt,
        'translation.generation': metadata.generation,
      },
    });
  } catch (error) {
    logger?.warn('[translationWorker][otel] observation start failed', {
      jobId: job.job_id,
      error: safeCode(error?.name),
    });
    return {
      run: (work) => work(),
      setOutcome: () => undefined,
      end: () => undefined,
    };
  }
  let langfuseObservation;
  if (getLangfuseProvider(logger)) {
    try {
      langfuseObservation = startObservation('translate-file', { metadata }, { asType: 'span' });
    } catch (error) {
      logger?.warn('[translationWorker][langfuse] observation start failed', {
        jobId: job.job_id,
        error: safeCode(error?.name),
      });
    }
  }
  let outcome = 'unknown';
  let errorCode = 'none';
  return {
    run: (work) => context.with(trace.setSpan(context.active(), span), work),
    setOutcome: (nextOutcome, nextErrorCode) => {
      outcome = safeCode(nextOutcome);
      errorCode = safeCode(nextErrorCode);
      span.setAttributes({
        'translation.outcome': outcome,
        'translation.error_code': errorCode,
      });
      if (['failed', 'ambiguous', 'lease_lost'].includes(outcome)) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorCode });
      }
    },
    end: () => {
      try {
        langfuseObservation
          ?.update({
            metadata: { ...metadata, outcome, errorCode },
            level: ['failed', 'ambiguous', 'lease_lost'].includes(outcome) ? 'ERROR' : 'DEFAULT',
            ...(errorCode !== 'none' ? { statusMessage: errorCode } : {}),
          })
          .end();
      } catch (error) {
        logger?.warn('[translationWorker][langfuse] observation finish failed', {
          jobId: job.job_id,
          error: safeCode(error?.name),
        });
      }
      span.end();
    },
  };
}

async function shutdownTranslationObservability(logger) {
  if (!langfuseProvider) return;
  try {
    await langfuseProvider.shutdown();
  } catch (error) {
    logger?.warn('[translationWorker][langfuse] shutdown flush failed', {
      error: safeCode(error?.name),
    });
  }
}

module.exports = { beginTranslationObservation, shutdownTranslationObservability };
