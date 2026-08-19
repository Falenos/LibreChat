import { request } from 'undici';
import type { Dispatcher } from 'undici';
import { Readable } from 'node:stream';
import { AcaError, AcaSessionNotFoundError, AcaTimeoutError } from '../types/aca.js';
import type {
  AcaExecOutcome,
  AcaExecutionResponse,
  AcaFileManifest,
  AcaFileListResponse,
  AcaSessionFile,
} from '../types/aca.js';
import { ACA_FILE_MANIFEST_NAME, ACA_FILE_MANIFEST_TRUNCATED_NAME } from '../types/aca.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../middleware/metrics.js';
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
  execute(identifier: string, code: string, signal?: AbortSignal): Promise<AcaExecOutcome>;
  pushFile(
    identifier: string,
    name: string,
    data: Readable,
    size: number,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void>;
  listFiles(identifier: string, signal?: AbortSignal): Promise<AcaSessionFile[]>;
  fetchFileStream(
    identifier: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ stream: Readable; contentLength?: number }>;
  fetchFileContent(
    identifier: string,
    name: string,
    maxBytes?: number,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  deleteSession(identifier: string, signal?: AbortSignal): Promise<void>;
  checkReadiness(signal?: AbortSignal): Promise<void>;
}

const SESSION_NOT_FOUND_RE = /SessionWithIdentifierNotFound/i;
const FILE_MANIFEST_MAX_BYTES = 1_048_576;
const FILE_MANIFEST_MAX_ENTRIES = 100;

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error != null && 'name' in error && error.name === 'AbortError'
  );
}

function isSessionNotFound(statusCode: number, bodyText: string): boolean {
  return statusCode === 404 && SESSION_NOT_FOUND_RE.test(bodyText);
}

function parseFileManifest(body: Buffer): AcaSessionFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new AcaError('pool returned invalid file manifest JSON', 502);
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    (parsed as Partial<AcaFileManifest>).version !== 1 ||
    typeof (parsed as Partial<AcaFileManifest>).truncated !== 'boolean' ||
    !Array.isArray((parsed as Partial<AcaFileManifest>).files)
  ) {
    throw new AcaError('pool returned invalid file manifest shape', 502);
  }
  const manifest = parsed as AcaFileManifest;
  if (manifest.files.length > FILE_MANIFEST_MAX_ENTRIES) {
    throw new AcaError('pool file manifest exceeded its bounded scan', 502);
  }
  const files = (manifest.files as unknown[]).map((raw) => {
    if (raw == null || typeof raw !== 'object') {
      throw new AcaError('pool returned invalid file manifest entry', 502);
    }
    const entry = raw as Partial<AcaSessionFile>;
    if (
      typeof entry.name !== 'string' ||
      entry.name === '' ||
      entry.name.startsWith('/') ||
      entry.type !== 'File' ||
      (entry.contentType != null && typeof entry.contentType !== 'string') ||
      typeof entry.sizeInBytes !== 'number' ||
      !Number.isSafeInteger(entry.sizeInBytes) ||
      entry.sizeInBytes < 0 ||
      typeof entry.lastModifiedAt !== 'string' ||
      entry.lastModifiedAt === ''
    ) {
      throw new AcaError('pool returned invalid file manifest entry', 502);
    }
    const segments = entry.name.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new AcaError('pool returned invalid file manifest entry', 502);
    }
    return {
      name: entry.name,
      type: 'File',
      contentType: entry.contentType ?? null,
      sizeInBytes: entry.sizeInBytes,
      lastModifiedAt: entry.lastModifiedAt,
    };
  });
  if (manifest.truncated) {
    files.push({
      name: ACA_FILE_MANIFEST_TRUNCATED_NAME,
      type: 'File',
      contentType: null,
      sizeInBytes: 0,
      lastModifiedAt: '',
    });
  }
  return files;
}

export function createAcaClient(
  config: Config,
  logger: Logger,
  tokens: TokenProvider,
  metrics: Metrics,
): AcaClient {
  const buildUrl = (path: string, identifier: string): string => {
    const url = new URL(`${config.aca.poolEndpoint}${path}`);
    url.searchParams.set('api-version', config.aca.apiVersion);
    url.searchParams.set('identifier', identifier);
    return url.toString();
  };
  const buildSessionUrl = (identifier: string): string => {
    const url = new URL(`${config.aca.poolEndpoint}/session`);
    url.searchParams.set('api-version', config.aca.sessionApiVersion);
    url.searchParams.set('identifier', identifier);
    return url.toString();
  };
  const buildListSessionsUrl = (): string => {
    const url = new URL(`${config.aca.poolEndpoint}/listSessions`);
    url.searchParams.set('api-version', config.aca.sessionApiVersion);
    url.searchParams.set('skip', '0');
    return url.toString();
  };

  const authedRequest = async (
    url: string,
    options: Omit<Dispatcher.RequestOptions, 'origin' | 'path'> & { method: Dispatcher.HttpMethod },
    timeoutMs: number,
  ) => {
    const doRequest = async () => {
      const token = await tokens.getToken(options.signal as AbortSignal | undefined);
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

  const fetchFileResponse = async (identifier: string, name: string, signal?: AbortSignal) => {
    const url = buildUrl(`/files/content/${encodeURIComponent(name)}`, identifier);
    const response = await authedRequest(
      url,
      { method: 'GET', signal },
      config.aca.fileOpTimeoutMs,
    );
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
    return response;
  };

  return {
    async execute(identifier, code, signal) {
      const started = Date.now();
      try {
        return await doExecute(identifier, code, signal);
      } finally {
        metrics.acaRequestDuration.observe({ op: 'execute' }, (Date.now() - started) / 1000);
      }
    },
    async pushFile(identifier, name, data, size, contentType, signal) {
      const started = Date.now();
      try {
        return await doPushFile(identifier, name, data, size, contentType, signal);
      } finally {
        metrics.acaRequestDuration.observe({ op: 'pushFile' }, (Date.now() - started) / 1000);
      }
    },
    async listFiles(identifier, signal) {
      const started = Date.now();
      try {
        return await doListFiles(identifier, signal);
      } finally {
        metrics.acaRequestDuration.observe({ op: 'listFiles' }, (Date.now() - started) / 1000);
      }
    },
    async fetchFileStream(identifier, name, signal) {
      const started = Date.now();
      const record = () => {
        metrics.acaRequestDuration.observe(
          { op: 'fetchFileStream' },
          (Date.now() - started) / 1000,
        );
      };
      // Unlike the other ops, this one returns before the operation is done: the
      // promise resolves at response headers, and the caller (capture.ts) then
      // pipes/reads the body separately. Timing only the header round-trip would
      // make slow or stalled downloads — and stream-level errors — invisible to
      // this histogram, so the observation is deferred to the stream's terminal
      // 'close' event (fired on normal end, consumer-driven destroy, and error
      // alike) instead of the `finally` used by the other methods below.
      let result: { stream: Readable; contentLength?: number };
      try {
        result = await doFetchFileStream(identifier, name, signal);
      } catch (err) {
        record();
        throw err;
      }
      result.stream.once('close', record);
      return result;
    },
    async fetchFileContent(identifier, name, maxBytes, signal) {
      const started = Date.now();
      try {
        return await doFetchFileContent(identifier, name, maxBytes, signal);
      } finally {
        metrics.acaRequestDuration.observe(
          { op: 'fetchFileContent' },
          (Date.now() - started) / 1000,
        );
      }
    },
    async deleteSession(identifier, signal) {
      const started = Date.now();
      try {
        await doDeleteSession(identifier, signal);
      } finally {
        metrics.acaRequestDuration.observe({ op: 'deleteSession' }, (Date.now() - started) / 1000);
      }
    },
    async checkReadiness(signal) {
      const started = Date.now();
      try {
        await doCheckReadiness(signal);
      } finally {
        metrics.acaRequestDuration.observe({ op: 'readiness' }, (Date.now() - started) / 1000);
      }
    },
  };

  async function doExecute(
    identifier: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<AcaExecOutcome> {
    const url = buildUrl('/code/execute', identifier);
    let response;
    try {
      response = await authedRequest(
        url,
        {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            properties: { codeInputType: 'inline', executionType: 'synchronous', code },
          }),
        },
        config.aca.execTimeoutMs,
      );
    } catch (err) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      if (isAbortError(err)) {
        throw err;
      }
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
  }

  async function doPushFile(
    identifier: string,
    name: string,
    data: Readable,
    size: number,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = buildUrl('/files/upload', identifier);
    const boundary = `karlform${Math.random().toString(16).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Readable.from(
      (async function* () {
        yield head;
        for await (const chunk of data) {
          yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        }
        yield tail;
      })(),
    );

    const response = await authedRequest(
      url,
      {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(head.length + size + tail.length),
        },
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
  }

  async function doListFiles(identifier: string, signal?: AbortSignal): Promise<AcaSessionFile[]> {
    const url = buildUrl('/files', identifier);
    const response = await authedRequest(
      url,
      { method: 'GET', signal },
      config.aca.fileOpTimeoutMs,
    );
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
      const rootEntries = parsed.value
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
      if (!rootEntries.some((entry) => entry.name === ACA_FILE_MANIFEST_NAME)) {
        return rootEntries;
      }
      const manifest = await doFetchFileContent(
        identifier,
        ACA_FILE_MANIFEST_NAME,
        FILE_MANIFEST_MAX_BYTES,
        signal,
      );
      return parseFileManifest(manifest);
    } catch (error) {
      if (error instanceof AcaError) {
        throw error;
      }
      throw new AcaError('pool returned non-JSON or invalid file list', 502);
    }
  }

  async function doFetchFileStream(
    identifier: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ stream: Readable; contentLength?: number }> {
    const response = await fetchFileResponse(identifier, name, signal);
    const rawLength = response.headers['content-length'];
    const contentLength = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength);
    return {
      stream: response.body,
      ...(Number.isFinite(contentLength) && contentLength >= 0 ? { contentLength } : {}),
    };
  }

  async function doFetchFileContent(
    identifier: string,
    name: string,
    maxBytes?: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const response = await fetchFileResponse(identifier, name, signal);
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
  }

  async function doDeleteSession(identifier: string, signal?: AbortSignal): Promise<void> {
    const response = await authedRequest(
      buildSessionUrl(identifier),
      { method: 'DELETE', signal },
      config.aca.sessionDeleteTimeoutMs,
    );
    if (response.statusCode === 204 || response.statusCode === 404) {
      await response.body.dump();
      return;
    }
    const bodyText = await response.body.text();
    if (response.statusCode >= 400) {
      throw new AcaError(
        `pool session deletion failed (${response.statusCode})`,
        502,
        bodyText.slice(0, 500),
      );
    }
  }

  async function doCheckReadiness(signal?: AbortSignal): Promise<void> {
    const response = await authedRequest(
      buildListSessionsUrl(),
      { method: 'GET', signal },
      config.readinessTimeoutMs,
    );
    const bodyText = await response.body.text();
    if (response.statusCode >= 400) {
      throw new AcaError(
        `pool readiness failed (${response.statusCode})`,
        502,
        bodyText.slice(0, 500),
      );
    }
    try {
      const parsed = JSON.parse(bodyText) as { value?: unknown };
      if (!Array.isArray(parsed.value)) {
        throw new Error('missing value array');
      }
    } catch {
      throw new AcaError('pool readiness returned an invalid session list', 502);
    }
  }
}
