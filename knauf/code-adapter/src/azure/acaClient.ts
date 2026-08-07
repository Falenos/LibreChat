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
 * Data-plane client for the ONE ACA code-interpreter pool.
 *
 * Both languages run here (the pool has bash + python3 + the data-science
 * stack); the exec service always submits a Python wrapper, so this client
 * speaks a single contract:
 *   exec   POST {pool}/code/execute?api-version=…  { properties:{codeInputType,executionType,code} }
 *          → { properties:{ status:"Success"|"Failure", stdout, stderr } }
 *   files  POST {pool}/files/upload · GET {pool}/files · GET {pool}/files/content/{name}
 *
 * Auth: Entra bearer from the TokenProvider; on 401/403 requests refresh the
 * token and retry once. Executions are NOT retried on other failures.
 */
export interface AcaClient {
  execute(identifier: string, code: string): Promise<AcaExecOutcome>;
  pushFile(identifier: string, name: string, data: Buffer, contentType: string): Promise<void>;
  listFiles(identifier: string): Promise<AcaSessionFile[]>;
  fetchFileContent(identifier: string, name: string, maxBytes?: number): Promise<Buffer>;
}

const SESSION_NOT_FOUND_RE = /SessionWithIdentifierNotFound/i;

function isSessionNotFound(statusCode: number, bodyText: string): boolean {
  return statusCode === 404 && SESSION_NOT_FOUND_RE.test(bodyText);
}

export function createAcaClient(config: Config, logger: Logger, tokens: TokenProvider): AcaClient {
  const buildUrl = (path: string, identifier: string): string => {
    const url = new URL(`${config.aca.poolEndpoint}${path}`);
    url.searchParams.set('api-version', config.aca.apiVersion);
    url.searchParams.set('identifier', identifier);
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
    const status = raw.properties?.status ?? '';
    return {
      succeeded: /^succe/i.test(status),
      stdout: raw.properties?.stdout ?? '',
      stderr: raw.properties?.stderr ?? '',
      executionMs: raw.properties?.executionTimeInMilliseconds,
      raw,
    };
  };

  return {
    async execute(identifier, code) {
      const url = buildUrl('/code/execute', identifier);
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

    async pushFile(identifier, name, data, contentType) {
      const url = buildUrl('/files/upload', identifier);
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
      if (response.statusCode === 429) {
        // Pushing a file allocates the session — the concurrency cap can bite
        // here just like on exec. Surface as capacity so execService returns a
        // friendly result instead of a 502.
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
          `pool file push failed (${response.statusCode})`,
          502,
          bodyText.slice(0, 500),
        );
      }
    },

    async listFiles(identifier) {
      const url = buildUrl('/files', identifier);
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
        if (!Array.isArray(parsed.value)) {
          return [];
        }
        // Normalize the wrapped { properties: { filename, size, ... } } shape.
        return parsed.value
          .map((entry): AcaSessionFile | null => {
            const p = entry.properties;
            if (p?.filename == null) {
              return null;
            }
            return {
              name: p.filename,
              type: 'File',
              contentType: p.contentType ?? null,
              sizeInBytes: p.size,
              lastModifiedAt: p.lastModifiedTime,
            };
          })
          .filter((f): f is AcaSessionFile => f !== null);
      } catch {
        throw new AcaError('pool returned non-JSON file list', 502);
      }
    },

    async fetchFileContent(identifier, name, maxBytes) {
      const url = buildUrl(`/files/content/${encodeURIComponent(name)}`, identifier);
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
