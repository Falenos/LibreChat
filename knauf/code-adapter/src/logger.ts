import { pino } from 'pino';
import type { DestinationStream } from 'pino';

const REDACTED = '[redacted]';

function boundedFailure(error: unknown): { reason: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      reason:
        typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)
          ? code
          : error.name || 'Error',
    };
  }
  return { reason: 'Error' };
}

/**
 * Structured JSON logs to stdout. Redaction is load-bearing: user code
 * and Authorization headers must never appear at info level.
 */
export function createLogger(level: string, destination?: DestinationStream) {
  return pino(
    {
      level,
      serializers: {
        err: boundedFailure,
      },
      redact: {
        paths: [
          'req.headers',
          'req.query',
          'req.body',
          'body',
          'code',
          'headers',
          'sessionId',
          'session_id',
          'fileId',
          'file_id',
          'blobPath',
          'file',
          'filename',
          'name',
          'userId',
          'user_id',
          'entityId',
          'entity_id',
          'resourceId',
          'resource_id',
          'runtime_session_hint',
          'supplied',
          'kid',
          'url',
          'stack',
          'acaCode',
        ],
        censor: REDACTED,
      },
      base: {
        service: 'agentic-karl-code-adapter',
        env: process.env.DD_ENV ?? process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV,
        version: process.env.ADAPTER_VERSION ?? 'unknown',
      },
    },
    destination,
  );
}

export type Logger = ReturnType<typeof createLogger>;
