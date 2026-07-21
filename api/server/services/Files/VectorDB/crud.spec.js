// [knauf] KK20-203 — seam test for the hardened, batched pgvector delete used by
// the chat-delete cascade (cascadeDeleteConvoFiles). Asserts bounded retry on
// transient failures, 404-as-success idempotency, and fail-fast on a 4xx.
// End [knauf]

jest.mock('axios');
jest.mock('@librechat/api', () => ({
  logAxiosError: jest.fn(),
  generateShortLivedToken: jest.fn(() => 'jwt-token'),
  // [knauf] KK20-195 WP0 — metric recorders used by crud.js.
  recordFileIndexEmbed: jest.fn(),
  recordFileIndexProviderError: jest.fn(),
  recordFileIndexEmbedRetry: jest.fn(),
  // End [knauf]
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// [knauf] KK20-195 WP0 — keep retry backoff ~instant (jitter ∈ [0,1] ms) and
// pin a small end-to-end embed budget so deadline behavior is testable. Must
// be set before require('./crud'): the knobs are read at module load.
process.env.RAG_EMBED_BACKOFF_BASE_MS = '1';
process.env.RAG_EMBED_BACKOFF_MAX_MS = '1';
process.env.RAG_EMBED_SYNC_TIMEOUT_MS = '5000';
// End [knauf]

const axios = require('axios');
const {
  deleteVectors,
  deleteVectorsByIds,
  deleteVectorsForFiles,
  // [knauf] KK20-195 WP0 exports under test.
  uploadVectors,
  parseRetryAfterMs,
  isRetryableEmbedError,
  embedRetryDelayMs,
  // End [knauf]
} = require('./crud');

describe('deleteVectorsByIds (KK20-203)', () => {
  const OLD_URL = process.env.RAG_API_URL;
  const req = { user: { id: 'u1' } };

  beforeAll(() => {
    process.env.RAG_API_URL = 'http://rag.test';
  });
  afterAll(() => {
    if (OLD_URL === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = OLD_URL;
    }
  });
  beforeEach(() => jest.clearAllMocks());

  test('posts the batch of ids to /documents in one call', async () => {
    axios.delete.mockResolvedValue({ status: 200 });
    await deleteVectorsByIds(req, ['a', 'b']);
    expect(axios.delete).toHaveBeenCalledTimes(1);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['a', 'b'] }),
    );
  });

  test('is a no-op (no RAG call) for an empty id list', async () => {
    await deleteVectorsByIds(req, []);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  test('filters falsy ids before deciding to call', async () => {
    await deleteVectorsByIds(req, [null, undefined, '']);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  test('treats 404 as idempotent success and does not throw', async () => {
    axios.delete.mockRejectedValue({ response: { status: 404 } });
    await expect(deleteVectorsByIds(req, ['x'])).resolves.toBeUndefined();
    expect(axios.delete).toHaveBeenCalledTimes(1);
  });

  test('retries a transient 5xx and throws after the attempt budget', async () => {
    axios.delete.mockRejectedValue({ response: { status: 503 }, message: 'unavailable' });
    await expect(deleteVectorsByIds(req, ['x'])).rejects.toThrow();
    expect(axios.delete).toHaveBeenCalledTimes(3);
  });

  test('fails fast on a non-transient 4xx (no retry)', async () => {
    axios.delete.mockRejectedValue({ response: { status: 400 }, message: 'bad request' });
    await expect(deleteVectorsByIds(req, ['x'])).rejects.toThrow();
    expect(axios.delete).toHaveBeenCalledTimes(1);
  });
});

// [knauf] Seam test for Azure-Search-aware batch delete.
describe('deleteVectorsForFiles (Azure Search routing)', () => {
  const OLD_URL = process.env.RAG_API_URL;
  const OLD_SEARCH = process.env.AZURE_SEARCH_ENABLED;
  const req = { user: { id: 'u1' } };

  beforeAll(() => {
    process.env.RAG_API_URL = 'http://rag.test';
  });
  afterAll(() => {
    if (OLD_URL === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = OLD_URL;
    }
    if (OLD_SEARCH === undefined) {
      delete process.env.AZURE_SEARCH_ENABLED;
    } else {
      process.env.AZURE_SEARCH_ENABLED = OLD_SEARCH;
    }
  });
  beforeEach(() => jest.clearAllMocks());

  test('agent files go to Azure Search when enabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'agent-file-1', context: 'agents' },
      { file_id: 'agent-file-2', context: 'agents' },
    ]);

    // Agent files → Azure Search only, no pgvector
    expect(axios.delete).toHaveBeenCalledTimes(2);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/agent-file-1',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/agent-file-2',
      expect.any(Object),
    );
  });

  test('chat/message_attachment files go to pgvector even when Azure Search enabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [{ file_id: 'chat-file-1', context: 'message_attachment' }]);

    // Chat files always go to pgvector, never Azure Search
    expect(axios.delete).toHaveBeenCalledTimes(1);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['chat-file-1'] }),
    );
  });

  test('FileAsset-backed batch deletes use immutable physical ids', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      {
        file_id: 'logical-agent',
        knauf_asset_id: 'physical-agent',
        context: 'agents',
      },
      {
        file_id: 'logical-chat',
        knauf_asset_id: 'physical-chat',
        context: 'message_attachment',
      },
    ]);

    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/physical-agent',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['physical-chat'] }),
    );
  });

  test('single-file deletes use immutable physical ids', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'false';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectors(req, {
      file_id: 'logical-chat',
      knauf_asset_id: 'physical-chat',
      context: 'message_attachment',
      embedded: true,
    });

    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['physical-chat'] }),
    );
  });

  test('mixed batch — agent files to Azure Search, chat files to pgvector', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'agent-1', context: 'agents' },
      { file_id: 'chat-1', context: 'message_attachment' },
      { file_id: 'chat-2', context: 'message_attachment' },
    ]);

    // 1 Azure Search for agent + 1 pgvector batch for chats = 2
    expect(axios.delete).toHaveBeenCalledTimes(2);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/agent-1',
      expect.any(Object),
    );
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['chat-1', 'chat-2'] }),
    );
  });

  test('all files go to pgvector when Azure Search disabled', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'false';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'agent-1', context: 'agents' },
      { file_id: 'chat-1', context: 'message_attachment' },
    ]);

    // All to pgvector when Azure Search disabled
    expect(axios.delete).toHaveBeenCalledTimes(1);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['agent-1', 'chat-1'] }),
    );
  });

  test('skips files with missing file_id', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockResolvedValue({ status: 200 });

    await deleteVectorsForFiles(req, [
      { file_id: 'good-1', context: 'agents' },
      { file_id: undefined, context: 'agents' },
      { file_id: null, context: 'message_attachment' },
    ]);

    // Only good-1 (agent) hits Azure Search; null/undefined filtered out
    expect(axios.delete).toHaveBeenCalledTimes(1);
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/agent/documents/good-1',
      expect.any(Object),
    );
  });

  test('is a no-op for empty file list', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    await deleteVectorsForFiles(req, []);
    expect(axios.delete).not.toHaveBeenCalled();
  });

  // Azure-failure branch — pinning the round-2/round-3 semantics: pgvector
  // runs first and unconditionally, an Azure failure aggregate-throws with the
  // failed ids afterward, and a 404 on /agent/documents/:id is swallowed as success.
  test('mixed batch: pgvector still runs and succeeds even when an Azure delete fails', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockImplementation((url) => {
      if (url === 'http://rag.test/documents') {
        return Promise.resolve({ status: 200 });
      }
      if (url.endsWith('/agent-fail')) {
        return Promise.reject({ response: { status: 400 }, message: 'bad request' });
      }
      return Promise.resolve({ status: 200 });
    });

    await expect(
      deleteVectorsForFiles(req, [
        { file_id: 'agent-fail', context: 'agents' },
        { file_id: 'chat-1', context: 'message_attachment' },
      ]),
    ).rejects.toThrow(/agent-fail/);

    // pgvector call for the chat file happened despite the Azure failure.
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['chat-1'] }),
    );
  });

  test('aggregate-throws listing every failed agent file id', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockImplementation((url) => {
      if (url.endsWith('/agent-ok')) {
        return Promise.resolve({ status: 200 });
      }
      return Promise.reject({ response: { status: 400 }, message: 'bad request' });
    });

    await expect(
      deleteVectorsForFiles(req, [
        { file_id: 'agent-ok', context: 'agents' },
        { file_id: 'agent-bad-1', context: 'agents' },
        { file_id: 'agent-bad-2', context: 'agents' },
      ]),
    ).rejects.toThrow(/agent-bad-1.*agent-bad-2|agent-bad-2.*agent-bad-1/);
  });

  test('a 404 on /agent/documents/:id resolves silently (no throw)', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    axios.delete.mockRejectedValue({ response: { status: 404 } });

    await expect(
      deleteVectorsForFiles(req, [{ file_id: 'agent-gone', context: 'agents' }]),
    ).resolves.toBeUndefined();
  });

  test('chunks agent deletes into waves of AZURE_SEARCH_CONCURRENCY (5), sequentially', async () => {
    process.env.AZURE_SEARCH_ENABLED = 'true';
    let inFlight = 0;
    let maxInFlight = 0;
    axios.delete.mockImplementation(() => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight--;
          resolve({ status: 200 });
        }, 5),
      );
    });

    const files = Array.from({ length: 7 }, (_, i) => ({
      file_id: `agent-${i}`,
      context: 'agents',
    }));
    await deleteVectorsForFiles(req, files);

    expect(axios.delete).toHaveBeenCalledTimes(7);
    // Wave 1 = 5 concurrent, wave 2 = 2 — never all 7 at once.
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });
});
// End [knauf]

// [knauf] KK20-195 WP0 — seam tests for the RAG containment guardrails:
// sync-path embed timeout, bounded Retry-After-aware retry, fail-fast
// classification, and baseline metric recording.
describe('parseRetryAfterMs (KK20-195 WP0)', () => {
  test('parses delta-seconds to milliseconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
  });

  test('caps at RAG_EMBED_RETRY_AFTER_MAX_MS (default 60s)', () => {
    expect(parseRetryAfterMs('120')).toBe(60_000);
  });

  test('parses a future HTTP-date (capped)', () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfterMs(future);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(60_000);
  });

  test('returns null for a past HTTP-date', () => {
    expect(parseRetryAfterMs(new Date(Date.now() - 5_000).toUTCString())).toBeNull();
  });

  test('returns null for absent/invalid values', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('not-a-date')).toBeNull();
  });
});

describe('isRetryableEmbedError (KK20-195 WP0)', () => {
  test('retries ONLY a provider throttle (429) until WP1 lands', () => {
    expect(isRetryableEmbedError({ response: { status: 429 } })).toBe(true);
  });

  test('ambiguous failures fail fast pre-WP1 — RAG may already have written vectors', () => {
    expect(isRetryableEmbedError({ response: { status: 503 } })).toBe(false);
    expect(isRetryableEmbedError({ response: { status: 408 } })).toBe(false);
    expect(isRetryableEmbedError({ code: 'ECONNRESET' })).toBe(false);
    expect(isRetryableEmbedError({ code: 'ECONNABORTED' })).toBe(false);
  });

  test('fails fast on other 4xx (bad input)', () => {
    expect(isRetryableEmbedError({ response: { status: 400 } })).toBe(false);
    expect(isRetryableEmbedError({ response: { status: 401 } })).toBe(false);
  });

  test('never retries body-level failures (knaufNoRetry)', () => {
    expect(isRetryableEmbedError({ knaufNoRetry: true })).toBe(false);
  });
});

describe('embedRetryDelayMs (KK20-195 WP0)', () => {
  const { recordFileIndexProviderError } = require('@librechat/api');
  const BIG_BUDGET_MS = 60_000;

  beforeEach(() => jest.clearAllMocks());

  test('Retry-After is a FLOOR with jitter added on top, never max()', () => {
    const delay = embedRetryDelayMs(
      { response: { status: 429, headers: { 'retry-after': '2' } } },
      1,
      'embed',
      BIG_BUDGET_MS,
    );
    // Backoff base/max pinned to 1 ms in this spec: jitter ∈ [0, 1].
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(2001);
  });

  test('returns null when the end-to-end budget cannot fit the delay', () => {
    const delay = embedRetryDelayMs(
      { response: { status: 429, headers: { 'retry-after': '2' } } },
      1,
      'embed',
      1500,
    );
    expect(delay).toBeNull();
  });

  test('returns null for non-retryable classes and once attempts are spent', () => {
    expect(embedRetryDelayMs({ response: { status: 503 } }, 1, 'embed', BIG_BUDGET_MS)).toBeNull();
    expect(
      embedRetryDelayMs(
        { response: { status: 429, headers: { 'retry-after': '0' } } },
        3,
        'embed',
        BIG_BUDGET_MS,
      ),
    ).toBeNull();
  });

  test('records provider errors by status class even when not retrying', () => {
    embedRetryDelayMs({ response: { status: 503 } }, 1, 'embed', BIG_BUDGET_MS);
    expect(recordFileIndexProviderError).toHaveBeenCalledWith('embed', '5xx');
  });
});

describe('uploadVectors (KK20-195 WP0 containment)', () => {
  const os = require('os');
  const path = require('path');
  const realFs = require('fs');
  const {
    recordFileIndexEmbed,
    recordFileIndexProviderError,
    recordFileIndexEmbedRetry,
    generateShortLivedToken,
  } = require('@librechat/api');

  const OLD_URL = process.env.RAG_API_URL;
  const req = { user: { id: 'u1' } };
  let tmpFile;
  let file;

  beforeAll(() => {
    process.env.RAG_API_URL = 'http://rag.test';
    tmpFile = path.join(os.tmpdir(), `kk20-195-wp0-${process.pid}.txt`);
    realFs.writeFileSync(tmpFile, 'test-bytes');
    file = { path: tmpFile, size: 10, originalname: 'doc.pdf', mimetype: 'application/pdf' };
  });
  afterAll(() => {
    realFs.rmSync(tmpFile, { force: true });
    if (OLD_URL === undefined) {
      delete process.env.RAG_API_URL;
    } else {
      process.env.RAG_API_URL = OLD_URL;
    }
  });
  beforeEach(() => jest.clearAllMocks());

  test('passes a finite timeout to the embed POST and returns the file record', async () => {
    axios.post.mockResolvedValue({ data: { status: true, known_type: true } });

    const result = await uploadVectors({ req, file, file_id: 'f1' });

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [, , config] = axios.post.mock.calls[0];
    expect(config.timeout).toEqual(expect.any(Number));
    expect(config.timeout).toBeGreaterThan(0);
    expect(result).toEqual(
      expect.objectContaining({ embedded: true, bytes: 10, filename: 'doc.pdf' }),
    );
    expect(recordFileIndexEmbed).toHaveBeenCalledWith('embed', 'success', expect.any(Number));
  });

  test('retries a 429 honoring Retry-After, minting a FRESH token per attempt', async () => {
    axios.post
      .mockRejectedValueOnce({
        response: { status: 429, headers: { 'retry-after': '0' } },
        message: 'throttled',
      })
      .mockResolvedValueOnce({ data: { status: true, known_type: true } });

    const result = await uploadVectors({ req, file, file_id: 'f1' });

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(generateShortLivedToken).toHaveBeenCalledTimes(2);
    expect(recordFileIndexProviderError).toHaveBeenCalledWith('embed', '429');
    expect(recordFileIndexEmbedRetry).toHaveBeenCalledWith('embed');
    expect(result.embedded).toBe(true);
    // Success never triggers the compensating vector delete.
    expect(axios.delete).not.toHaveBeenCalled();
  });

  test('ambiguous 5xx fails FAST pre-WP1 and compensates (best-effort vector delete)', async () => {
    axios.post.mockRejectedValue({ response: { status: 503 }, message: 'unavailable' });
    axios.delete.mockResolvedValue({ status: 200 });

    await expect(uploadVectors({ req, file, file_id: 'f1' })).rejects.toThrow();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(recordFileIndexProviderError).toHaveBeenCalledWith('embed', '5xx');
    expect(recordFileIndexEmbed).toHaveBeenCalledWith('embed', 'failure', expect.any(Number));
    // Vectors may have landed before the failure — reconcile by file_id.
    expect(axios.delete).toHaveBeenCalledWith(
      'http://rag.test/documents',
      expect.objectContaining({ data: ['f1'] }),
    );
  });

  test('fails fast on a non-transient 4xx (no retry) and still compensates', async () => {
    axios.post.mockRejectedValue({ response: { status: 400 }, message: 'bad request' });
    axios.delete.mockResolvedValue({ status: 200 });

    await expect(uploadVectors({ req, file, file_id: 'f1' })).rejects.toThrow();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.delete).toHaveBeenCalledTimes(1);
  });

  test('does NOT retry after a timeout — the end-to-end budget is spent', async () => {
    axios.post.mockRejectedValue({ code: 'ECONNABORTED', message: 'timeout exceeded' });
    axios.delete.mockResolvedValue({ status: 200 });

    await expect(uploadVectors({ req, file, file_id: 'f1' })).rejects.toThrow();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(recordFileIndexEmbed).toHaveBeenCalledWith('embed', 'timeout', expect.any(Number));
  });

  test('a compensating-delete failure never masks the original embed error', async () => {
    axios.post.mockRejectedValue({ response: { status: 400 }, message: 'bad request' });
    axios.delete.mockRejectedValue({ response: { status: 400 }, message: 'delete refused' });

    await expect(uploadVectors({ req, file, file_id: 'f1' })).rejects.toThrow('bad request');
  });

  test('per-attempt timeout shrinks toward the single end-to-end deadline', async () => {
    axios.post
      .mockRejectedValueOnce({
        response: { status: 429, headers: { 'retry-after': '1' } },
        message: 'throttled',
      })
      .mockResolvedValueOnce({ data: { status: true, known_type: true } });

    await uploadVectors({ req, file, file_id: 'f1' });

    const firstTimeout = axios.post.mock.calls[0][2].timeout;
    const secondTimeout = axios.post.mock.calls[1][2].timeout;
    // Budget pinned to 5000 ms in this spec; the ~1 s Retry-After sleep must
    // come out of the SAME budget, not reset it.
    expect(firstTimeout).toBeLessThanOrEqual(5000);
    expect(secondTimeout).toBeLessThan(firstTimeout - 900);
  });

  test('no retry when Retry-After exceeds the remaining end-to-end budget', async () => {
    axios.post.mockRejectedValue({
      response: { status: 429, headers: { 'retry-after': '10' } },
      message: 'throttled',
    });
    axios.delete.mockResolvedValue({ status: 200 });

    await expect(uploadVectors({ req, file, file_id: 'f1' })).rejects.toThrow();
    // 10 s Retry-After ≥ 5 s budget → budget cannot fit the delay → single attempt.
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(recordFileIndexEmbedRetry).not.toHaveBeenCalled();
  });

  test('fails fast on unsupported type (known_type=false) with no retry', async () => {
    axios.post.mockResolvedValue({ data: { status: true, known_type: false } });

    await expect(uploadVectors({ req, file, file_id: 'f1' })).rejects.toThrow(/not supported/);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(recordFileIndexEmbed).toHaveBeenCalledWith(
      'embed',
      'unsupported_type',
      expect.any(Number),
    );
  });

  test('fails fast on a body-level failure inside an HTTP 200 (status=false)', async () => {
    axios.post.mockResolvedValue({ data: { status: false } });

    await expect(uploadVectors({ req, file, file_id: 'f1' })).rejects.toThrow(
      'File embedding failed.',
    );
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('rebuilds the multipart body per attempt (fresh read stream each retry)', async () => {
    axios.post
      .mockRejectedValueOnce({
        response: { status: 429, headers: { 'retry-after': '0' } },
        message: 'throttled',
      })
      .mockResolvedValueOnce({ data: { status: true, known_type: true } });

    await uploadVectors({ req, file, file_id: 'f1' });

    const [firstBody] = axios.post.mock.calls[0].slice(1);
    const [secondBody] = axios.post.mock.calls[1].slice(1);
    expect(firstBody).not.toBe(secondBody);
  });

  test('routes agent files to /agent/embed and tags metrics accordingly', async () => {
    const OLD_SEARCH = process.env.AZURE_SEARCH_ENABLED;
    process.env.AZURE_SEARCH_ENABLED = 'true';
    try {
      axios.post.mockResolvedValue({ data: { status: true, known_type: true } });

      await uploadVectors({ req, file, file_id: 'f1', entity_id: 'agent1', isAgentFile: true });

      expect(axios.post).toHaveBeenCalledWith(
        'http://rag.test/agent/embed',
        expect.anything(),
        expect.any(Object),
      );
      expect(recordFileIndexEmbed).toHaveBeenCalledWith(
        'agent_embed',
        'success',
        expect.any(Number),
      );
    } finally {
      if (OLD_SEARCH === undefined) {
        delete process.env.AZURE_SEARCH_ENABLED;
      } else {
        process.env.AZURE_SEARCH_ENABLED = OLD_SEARCH;
      }
    }
  });

  test('compensates an agent Azure-Search embed against Azure Search, not pgvector (KK20-195 review)', async () => {
    const OLD_SEARCH = process.env.AZURE_SEARCH_ENABLED;
    process.env.AZURE_SEARCH_ENABLED = 'true';
    try {
      axios.post.mockRejectedValue({ response: { status: 503 }, message: 'unavailable' });
      axios.delete.mockResolvedValue({ status: 200 });

      await expect(
        uploadVectors({ req, file, file_id: 'f1', entity_id: 'agent1', isAgentFile: true }),
      ).rejects.toThrow();

      // Partial vectors landed in Azure Search → compensate against the SAME
      // store (DELETE /agent/documents/:id), never the pgvector /documents route.
      expect(axios.delete).toHaveBeenCalledWith(
        'http://rag.test/agent/documents/f1',
        expect.any(Object),
      );
      expect(axios.delete).not.toHaveBeenCalledWith('http://rag.test/documents', expect.anything());
    } finally {
      if (OLD_SEARCH === undefined) {
        delete process.env.AZURE_SEARCH_ENABLED;
      } else {
        process.env.AZURE_SEARCH_ENABLED = OLD_SEARCH;
      }
    }
  });
});
// End [knauf]
