import { pino } from 'pino';

/**
 * Structured JSON logs to stdout. Redaction is load-bearing: user code
 * and Authorization headers must never appear at info level.
 */
export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.body.code',
        'body.code',
        'code',
        'headers.authorization',
      ],
      censor: '[redacted]',
    },
    base: { service: 'code-adapter' },
  });
}

export type Logger = ReturnType<typeof createLogger>;
