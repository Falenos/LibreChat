import { request } from 'undici';
import type { Dispatcher } from 'undici';
import { AcaError, AcaSessionNotFoundError, AcaTimeoutError } from '../types/aca.js';
import type {
  AcaExecOutcome,
  AcaExecutionResponse,
  AcaFileListResponse,
  AcaSessionFile,
} from '../types/aca.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { TokenProvider } from './credential.js';

/**
 * Data-plane client for ACA dynamic session pools.
 *
 * Response parsing is tolerant across the two observed preview shapes
 * (see types/aca.ts); test/fixtures/aca/ pins the real ones (S5 spike).
 * Auth: Entra bearer from the TokenProvider; on 401/403 the caller-facing
 * methods invalidate + retry exactly once. POST /executions is NOT
 * retried on other failures (execution is not idempotent).
 */
export interface AcaClient {
  execute(poolEndpoint: string, identifier: string, code: string): Promise<AcaExecOutcome>;
  pushFile(
    poolEndpoint: string,
    identifier: string,
    name: string,
    data: Buffer,
    contentType: string,
  ): Promise<void>;
  listFiles(poolEndpoint: string, identifier: string): Promise<AcaSessionFile[]>;
  fetchFileContent(
    poolEndpoint: string,
    identifier: string,
    name: string,
    maxBytes?: number,
  ): Promise<Buffer>;
}

const SESSION_NOT_FOUND_RE = /SessionWithIdentifierNotFound/i;

function isSessionNotFound(statusCode: number, bodyText: string): boolean {
  return statusCode === 404 && SESSION_NOT_FOUND_RE.test(bodyText);
}

export function createAcaClient(config: Config, logger: Logger, tokens: TokenProvider): AcaClient {
  const buildUrl = (
    poolEndpoint: string,
    path: string,
    identifier: string,
    extra?: Record<string, string>,
  ): string => {
    const url = new URL(`${poolEndpoint}${path}`);
    url.searchParams.set('api-version', config.aca.apiVersion);
    url.searchParams.set('identifier', identifier);
    for (const [k, v] of Object.entries(extra ?? {})) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  };

  const authedRequest = async (
    url: string,
    options: Omit<Dispatcher.RequestOptions, 'origin' | 'path'> & { method: Dispatcher.HttpMethod },
    timeoutMs: number,
  ) => {
    const doRequest = async () => {
      const token = await tokens.getToken();
      return request(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.headers as Record<string, string> | undefined),
        },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    };

    let response = await doRequest();
    if (response.statusCode === 401 || response.statusCode === 403) {
      await response.body.dump();
      logger.warn({ url, status: response.statusCode }, 'pool auth failure — refreshing token');
      tokens.invalidate();
      response = await doRequest();
      if (response.statusCode === 401 || response.statusCode === 403) {
        await response.body.dump();
        throw new AcaError('pool authentication failed after token refresh', 502, 'BACKEND_AUTH');
      }
    }
    return response;
  };

  const parseExecution = (raw: AcaExecutionResponse): AcaExecOutcome => {
    const status = raw.properties?.status ?? raw.status ?? '';
    const stdout = raw.properties?.stdout ?? raw.result?.stdout ?? '';
    const stderr = raw.properties?.stderr ?? raw.result?.stderr ?? '';
    const executionMs =
      raw.properties?.executionTimeInMilliseconds ?? raw.result?.executionTimeInMilliseconds;
    return {
      succeeded: /^succe/i.test(status),
      stdout,
      stderr,
      executionMs,
      raw,
    };
  };

  return {
    async execute(poolEndpoint, identifier, code) {
      const url = buildUrl(poolEndpoint, '/executions', identifier);
      let response;
      try {
        response = await authedRequest(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              properties: { codeInputType: 'inline', executionType: 'synchronous', code },
            }),
          },
          config.aca.execTimeoutMs,
        );
      } catch (err) {
        if (err instanceof AcaError) {
          throw err;
        }
        const name = (err as Error).name ?? '';
        if (/Timeout/i.test(name) || /timeout/i.test((err as Error).message ?? '')) {
          throw new AcaTimeoutError();
        }
        throw new AcaError(`pool request failed: ${(err as Error).message}`, 502);
      }

      const bodyText = await response.body.text();
      if (response.statusCode === 408 || response.statusCode === 504) {
        throw new AcaTimeoutError();
      }
      if (isSessionNotFound(response.statusCode, bodyText)) {
        throw new AcaSessionNotFoundError();
      }
      if (response.statusCode === 429) {
        const retryAfter = Number(response.headers['retry-after']);
        throw new AcaError(
          'pool at capacity',
          429,
          'Capacity',
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
      }
      if (response.statusCode >= 400) {
        throw new AcaError(
          `pool execution failed (${response.statusCode})`,
          502,
          bodyText.slice(0, 500),
        );
      }

      let parsed: AcaExecutionResponse;
      try {
        parsed = JSON.parse(bodyText) as AcaExecutionResponse;
      } catch {
        throw new AcaError('pool returned non-JSON execution response', 502);
      }
      return parseExecution(parsed);
    },

    async pushFile(poolEndpoint, identifier, name, data, contentType) {
      const url = buildUrl(poolEndpoint, '/files', identifier);
      const boundary = `karlform${Math.random().toString(16).slice(2)}`;
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([head, data, tail]);

      const response = await authedRequest(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
          body,
        },
        config.aca.fileOpTimeoutMs,
      );
      const bodyText = await response.body.text();
      if (isSessionNotFound(response.statusCode, bodyText)) {
        throw new AcaSessionNotFoundError();
      }
      if (response.statusCode === 413) {
        throw new AcaError('file exceeds pool upload limit', 413, 'PayloadTooLarge');
      }
      if (response.statusCode >= 400) {
        throw new AcaError(
          `pool file push failed (${response.statusCode})`,
          502,
          bodyText.slice(0, 500),
        );
      }
    },

    async listFiles(poolEndpoint, identifier) {
      const url = buildUrl(poolEndpoint, '/files', identifier);
      const response = await authedRequest(url, { method: 'GET' }, config.aca.fileOpTimeoutMs);
      const bodyText = await response.body.text();
      if (isSessionNotFound(response.statusCode, bodyText)) {
        throw new AcaSessionNotFoundError();
      }
      if (response.statusCode >= 400) {
        throw new AcaError(
          `pool file list failed (${response.statusCode})`,
          502,
          bodyText.slice(0, 500),
        );
      }
      try {
        const parsed = JSON.parse(bodyText) as AcaFileListResponse;
        return Array.isArray(parsed.value) ? parsed.value : [];
      } catch {
        throw new AcaError('pool returned non-JSON file list', 502);
      }
    },

    async fetchFileContent(poolEndpoint, identifier, name, maxBytes) {
      const url = buildUrl(poolEndpoint, `/files/${encodeURIComponent(name)}/content`, identifier);
      const response = await authedRequest(url, { method: 'GET' }, config.aca.fileOpTimeoutMs);
      if (response.statusCode === 404) {
        const bodyText = await response.body.text();
        if (SESSION_NOT_FOUND_RE.test(bodyText)) {
          throw new AcaSessionNotFoundError();
        }
        throw new AcaError(`pool file not found: ${name}`, 404, 'FileNotFound');
      }
      if (response.statusCode >= 400) {
        await response.body.dump();
        throw new AcaError(`pool file fetch failed (${response.statusCode})`, 502);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.length;
        if (maxBytes != null && total > maxBytes) {
          chunks.push(buf.subarray(0, buf.length - (total - maxBytes)));
          response.body.destroy();
          break;
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks);
    },
  };
}
