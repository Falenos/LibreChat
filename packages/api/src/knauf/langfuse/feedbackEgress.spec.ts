// [knauf] KK20-327 — adversarial coverage for the Langfuse feedback egress adapter.
// Runs the REAL upstream transport with `fetch` mocked, and asserts on the serialized
// outbound request — URL, method, headers and body — not on an intermediate object.
jest.mock(
  '@librechat/data-schemas',
  () => ({ logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } }),
  { virtual: true },
);

const CANARY = 'customer Alice discussed contract X with Bob Müller';

const ENV_KEYS = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_HOST',
  'LANGFUSE_BASEURL',
  'LANGFUSE_TRACING_ENABLED',
  'LANGFUSE_ENABLED',
  'LANGFUSE_SAMPLE_RATE',
  'LANGFUSE_TRACING_ENVIRONMENT',
];

let fetchMock: jest.SpiedFunction<typeof fetch>;

function clearEnv(): void {
  for (const k of ENV_KEYS) {
    delete process.env[k];
  }
}

async function load(): Promise<typeof import('./feedbackEgress')> {
  jest.resetModules();
  return import('./feedbackEgress');
}

/** Every byte that left the process, as one string. */
function everythingSent(): string {
  return JSON.stringify(
    fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
    })),
  );
}

function postBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

const baseMetadata = {
  messageId: 'm1',
  parentMessageId: 'p1',
  conversationId: 'c1',
  sessionId: 'c1',
  userId: '507f1f77bcf86cd799439011',
  endpoint: 'agents',
  sender: 'Karl',
  isCreatedByUser: false,
  tokenCount: 42,
};

describe('Langfuse feedback egress adapter', () => {
  beforeEach(() => {
    clearEnv();
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    process.env.LANGFUSE_SECRET_KEY = 'sk';
    process.env.LANGFUSE_HOST = 'https://langfuse.test';
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    clearEnv();
    fetchMock.mockRestore();
  });

  describe('the outbound contract', () => {
    it('sends exactly { value, comment=tag, metadata ⊆ allow-list } for a valid record', async () => {
      const { sendKnaufFeedbackScore } = await load();
      const result = await sendKnaufFeedbackScore({
        traceId: 't1',
        storedFeedback: { rating: 'thumbsDown', tag: 'inaccurate', text: CANARY },
        metadata: baseMetadata,
      });

      expect(result).toEqual({ sent: true, feedback: { rating: 'thumbsDown', tag: 'inaccurate' } });
      const [body] = postBodies();
      expect(body).toEqual({
        id: 'feedback-t1',
        traceId: 't1',
        name: 'user-feedback',
        value: 0,
        dataType: 'BOOLEAN',
        comment: 'inaccurate',
        metadata: { ...baseMetadata, rating: 'thumbsDown', tag: 'inaccurate' },
      });
      expect(everythingSent()).not.toContain(CANARY);
    });

    it('normalises the legacy { key, label } tag object to its key and drops the label', async () => {
      const { sendKnaufFeedbackScore } = await load();
      await sendKnaufFeedbackScore({
        traceId: 't1',
        storedFeedback: { rating: 'thumbsUp', tag: { key: 'accurate_reliable', label: CANARY } },
      });
      const [body] = postBodies();
      expect(body.comment).toBe('accurate_reliable');
      expect(everythingSent()).not.toContain(CANARY);
    });
  });

  describe('adversarial stored records', () => {
    it('prose in rating ⇒ no score is created; the DELETE path fires and the prose never leaves', async () => {
      const { sendKnaufFeedbackScore } = await load();
      const result = await sendKnaufFeedbackScore({
        traceId: 't1',
        storedFeedback: { rating: CANARY, tag: 'inaccurate' },
        metadata: baseMetadata,
      });

      expect(result).toEqual({ sent: true, feedback: null });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(init?.method).toBe('DELETE');
      expect(String(url)).toBe('https://langfuse.test/api/public/scores/feedback-t1');
      expect(postBodies()).toEqual([]);
      expect(everythingSent()).not.toContain(CANARY);
    });

    it('object-shaped rating and nested values are rejected, not stringified', async () => {
      const { sendKnaufFeedbackScore } = await load();
      for (const rating of [
        { value: 'thumbsDown', note: CANARY },
        ['thumbsDown', CANARY],
        { toString: () => 'thumbsDown', note: CANARY },
        { $gt: '' },
      ]) {
        fetchMock.mockClear();
        const result = await sendKnaufFeedbackScore({ traceId: 't1', storedFeedback: { rating } });
        expect(result.sent && result.feedback).toBeNull();
        expect(postBodies()).toEqual([]);
        expect(everythingSent()).not.toContain(CANARY);
      }
    });

    it('unexpected properties on the record cannot reach the payload', async () => {
      const { sendKnaufFeedbackScore } = await load();
      await sendKnaufFeedbackScore({
        traceId: 't1',
        storedFeedback: {
          rating: 'thumbsDown',
          tag: 'other',
          text: CANARY,
          comment: CANARY,
          note: CANARY,
          metadata: { leak: CANARY },
          nested: { deeper: { value: CANARY } },
        },
      });
      const [body] = postBodies();
      expect(Object.keys(body).sort()).toEqual(
        ['comment', 'dataType', 'id', 'metadata', 'name', 'traceId', 'value'].sort(),
      );
      expect(body.comment).toBe('other');
      expect(everythingSent()).not.toContain(CANARY);
    });

    it('prose in tag is dropped and the score still carries the rating', async () => {
      const { sendKnaufFeedbackScore } = await load();
      await sendKnaufFeedbackScore({
        traceId: 't1',
        storedFeedback: { rating: 'thumbsDown', tag: CANARY },
      });
      const [body] = postBodies();
      expect(body.value).toBe(0);
      expect(body).not.toHaveProperty('comment');
      expect(everythingSent()).not.toContain(CANARY);
    });

    it('metadata: unknown keys, object values and oversized strings are dropped', async () => {
      const { sendKnaufFeedbackScore } = await load();
      await sendKnaufFeedbackScore({
        traceId: 't1',
        storedFeedback: { rating: 'thumbsUp' },
        metadata: {
          ...baseMetadata,
          email: 'alice@knauf.com',
          text: CANARY,
          sender: { name: CANARY },
          endpoint: 'x'.repeat(129),
        },
      });
      const [body] = postBodies();
      const metadata = body.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(
        [
          'messageId',
          'parentMessageId',
          'conversationId',
          'sessionId',
          'userId',
          'isCreatedByUser',
          'tokenCount',
          'rating',
        ].sort(),
      );
      expect(everythingSent()).not.toContain(CANARY);
      expect(everythingSent()).not.toContain('@');
    });

    it('nullish and non-object records take the DELETE path', async () => {
      const { sendKnaufFeedbackScore } = await load();
      for (const storedFeedback of [null, undefined, 'thumbsDown', 7, [CANARY]]) {
        fetchMock.mockClear();
        const result = await sendKnaufFeedbackScore({ traceId: 't1', storedFeedback });
        expect(result).toEqual({ sent: true, feedback: null });
        expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
      }
    });
  });

  describe('kill switches — disabling Langfuse produces NO outbound request', () => {
    it.each([
      ['LANGFUSE_ENABLED', 'false'],
      ['LANGFUSE_ENABLED', '0'],
      ['LANGFUSE_TRACING_ENABLED', 'false'],
      ['LANGFUSE_TRACING_ENABLED', 'off'],
    ])('%s=%s stops score creation and deletion alike', async (key, value) => {
      process.env[key] = value;
      const { sendKnaufFeedbackScore } = await load();
      const created = await sendKnaufFeedbackScore({
        traceId: 't1',
        storedFeedback: { rating: 'thumbsDown', tag: 'inaccurate' },
      });
      const cleared = await sendKnaufFeedbackScore({ traceId: 't1', storedFeedback: null });
      expect(created).toEqual({ sent: false, reason: 'disabled' });
      expect(cleared).toEqual({ sent: false, reason: 'disabled' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('missing credentials disable it', async () => {
      delete process.env.LANGFUSE_SECRET_KEY;
      const { sendKnaufFeedbackScore, isKnaufLangfuseFeedbackEnabled } = await load();
      expect(isKnaufLangfuseFeedbackEnabled()).toBe(false);
      await sendKnaufFeedbackScore({ traceId: 't1', storedFeedback: { rating: 'thumbsUp' } });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is evaluated per call, so an operator flip takes effect without a restart', async () => {
      const { isKnaufLangfuseFeedbackEnabled } = await load();
      expect(isKnaufLangfuseFeedbackEnabled()).toBe(true);
      process.env.LANGFUSE_ENABLED = 'false';
      expect(isKnaufLangfuseFeedbackEnabled()).toBe(false);
    });
  });

  describe('pure helpers', () => {
    it('toLangfuseFeedback returns a fresh two-field object at most', async () => {
      const { toLangfuseFeedback } = await load();
      const stored = { rating: 'thumbsUp', tag: 'clear_well_written', text: CANARY, extra: 1 };
      const out = toLangfuseFeedback(stored);
      expect(out).toEqual({ rating: 'thumbsUp', tag: 'clear_well_written' });
      expect(out).not.toBe(stored);
      expect(toLangfuseFeedback({ rating: 'thumbsUp' })).toEqual({ rating: 'thumbsUp' });
    });
  });
});
// End [knauf]
