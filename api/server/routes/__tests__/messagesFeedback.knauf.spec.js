// [knauf] KK20-327 — Seam test for the Langfuse PII gate on message feedback.
// Two layers are pinned here: (1) the authenticated boundary rejects anything that is
// not `{ rating: enum, tag: enum, text?: ≤1024 }` before it is stored, and (2) the
// route hands the STORED record to the Knauf egress adapter — never to the upstream
// transport directly. The adapter's own outbound contract (what actually leaves the
// process) is covered by packages/api/src/knauf/langfuse/feedbackEgress.spec.ts.
// Mock/supertest shape follows `messages.knauf.spec.js`.
// See knauf/docs/privacy/workstream.md §5 (P0-1).
// End [knauf]

const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  unescapeLaTeX: jest.fn((x) => x),
  countTokens: jest.fn().mockResolvedValue(10),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
  sendKnaufFeedbackScore: jest.fn().mockResolvedValue({ sent: true, feedback: null }),
  traceIdForMessage: jest.fn((id) => `trace-${id}`),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('~/models', () => ({
  saveConvo: jest.fn(),
  getMessage: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
  getConvosQueried: jest.fn(),
  searchMessages: jest.fn(),
  getMessagesByCursor: jest.fn(),
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(),
  replaceArtifactContent: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    req.user = { id: 'u1' };
    next();
  },
  validateMessageReq: (req, res, next) => next(),
}));

jest.mock('~/server/services/Files/Azure/refreshMessageAttachments', () => ({
  refreshMessageAttachmentUrls: jest.fn(async (m) => m),
  refreshAttachment: jest.fn(async (a) => a),
  DEFAULT_BUFFER_SECONDS: 300,
}));

const db = require('~/models');
const { sendFeedbackScore, sendKnaufFeedbackScore } = require('@librechat/api');
const routes = require('../messages');

const CANARY = 'customer Alice discussed contract X with Bob Müller';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/messages', routes);
  return app;
};

const putFeedback = (app, feedback) =>
  request(app).put('/api/messages/c1/m1/feedback').send({ feedback });

const stored = (feedback) => ({
  messageId: 'm1',
  conversationId: 'c1',
  endpoint: 'agents',
  sender: 'Karl',
  feedback,
});

describe('PUT /api/messages/:conversationId/:messageId/feedback — Langfuse PII gate', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  describe('boundary validation (before anything is stored)', () => {
    test.each([
      ['prose in rating', { rating: CANARY, tag: 'inaccurate' }],
      [
        'object-shaped rating',
        { rating: { value: 'thumbsDown', note: CANARY }, tag: 'inaccurate' },
      ],
      ['prose in tag', { rating: 'thumbsDown', tag: CANARY }],
      [
        'legacy tag object (client sends the key string)',
        { rating: 'thumbsDown', tag: { key: 'inaccurate' } },
      ],
      ['unexpected property', { rating: 'thumbsDown', tag: 'inaccurate', comment: CANARY }],
      [
        'nested unexpected property',
        { rating: 'thumbsDown', tag: 'inaccurate', meta: { note: CANARY } },
      ],
      ['text over 1024 chars', { rating: 'thumbsDown', tag: 'inaccurate', text: 'x'.repeat(1025) }],
      ['missing tag', { rating: 'thumbsDown' }],
      ['array', [{ rating: 'thumbsDown', tag: 'inaccurate' }]],
      ['string', 'thumbsDown'],
    ])('rejects %s with 400 and stores nothing', async (_name, feedback) => {
      const res = await putFeedback(app, feedback).expect(400);
      expect(res.body).toEqual({ error: 'Invalid feedback' });
      expect(db.updateMessage).not.toHaveBeenCalled();
      expect(sendKnaufFeedbackScore).not.toHaveBeenCalled();
      expect(sendFeedbackScore).not.toHaveBeenCalled();
    });

    test('accepts the shape the real client sends and stores the parsed object (text kept in Mongo)', async () => {
      db.updateMessage.mockResolvedValue(
        stored({ rating: 'thumbsDown', tag: 'inaccurate', text: CANARY }),
      );

      await putFeedback(app, { rating: 'thumbsDown', tag: 'inaccurate', text: CANARY }).expect(200);

      expect(db.updateMessage).toHaveBeenCalledWith(
        'u1',
        { messageId: 'm1', feedback: { rating: 'thumbsDown', tag: 'inaccurate', text: CANARY } },
        { context: 'updateFeedback' },
      );
    });

    test('nullish feedback is the "clear my rating" request and is stored as null', async () => {
      db.updateMessage.mockResolvedValue(stored(null));

      await putFeedback(app, null).expect(200);

      expect(db.updateMessage).toHaveBeenCalledWith(
        'u1',
        { messageId: 'm1', feedback: null },
        { context: 'updateFeedback' },
      );
    });
  });

  describe('egress goes through the Knauf adapter only', () => {
    test('hands the STORED record to the adapter, never to the upstream transport', async () => {
      db.updateMessage.mockResolvedValue(
        stored({ rating: 'thumbsDown', tag: 'inaccurate', text: CANARY }),
      );

      await putFeedback(app, { rating: 'thumbsDown', tag: 'inaccurate', text: CANARY }).expect(200);

      expect(sendFeedbackScore).not.toHaveBeenCalled();
      expect(sendKnaufFeedbackScore).toHaveBeenCalledTimes(1);
      const call = sendKnaufFeedbackScore.mock.calls[0][0];
      expect(call.traceId).toBe('trace-m1');
      // The adapter — not this route — decides what leaves; the route passes the stored
      // record so a legacy row is re-validated at egress too.
      expect(call.storedFeedback).toEqual({
        rating: 'thumbsDown',
        tag: 'inaccurate',
        text: CANARY,
      });
    });

    test('a legacy stored record with prose in rating still goes to the adapter (which fails it closed)', async () => {
      // Rows written before the boundary parse existed can hold anything.
      db.updateMessage.mockResolvedValue(stored({ rating: CANARY, tag: { key: 'inaccurate' } }));

      await putFeedback(app, null).expect(200);

      expect(sendKnaufFeedbackScore).toHaveBeenCalledTimes(1);
      expect(sendKnaufFeedbackScore.mock.calls[0][0].storedFeedback.rating).toBe(CANARY);
      expect(sendFeedbackScore).not.toHaveBeenCalled();
    });

    test('nullish stored feedback reaches the adapter so the score-DELETE path can fire', async () => {
      db.updateMessage.mockResolvedValue(stored(null));

      await putFeedback(app, null).expect(200);

      expect(sendKnaufFeedbackScore).toHaveBeenCalledTimes(1);
      expect(sendKnaufFeedbackScore.mock.calls[0][0].storedFeedback).toBeNull();
    });

    test('skips Langfuse entirely for Assistants messages (no deterministic trace)', async () => {
      db.updateMessage.mockResolvedValue({
        ...stored({ rating: 'thumbsUp', tag: 'accurate_reliable' }),
        endpoint: 'assistants',
      });

      await putFeedback(app, { rating: 'thumbsUp', tag: 'accurate_reliable' }).expect(200);

      expect(sendKnaufFeedbackScore).not.toHaveBeenCalled();
    });

    test('identity posture: only pseudonymous ids and server-set facts are offered as metadata', async () => {
      db.updateMessage.mockResolvedValue(stored({ rating: 'thumbsDown', tag: 'inaccurate' }));

      await putFeedback(app, { rating: 'thumbsDown', tag: 'inaccurate' }).expect(200);

      const { metadata } = sendKnaufFeedbackScore.mock.calls[0][0];
      expect(Object.keys(metadata).sort()).toEqual(
        [
          'messageId',
          'parentMessageId',
          'conversationId',
          'sessionId',
          'userId',
          'endpoint',
          'sender',
          'isCreatedByUser',
          'tokenCount',
        ].sort(),
      );
      expect(metadata.userId).toBe('u1');
      expect(metadata.sessionId).toBe('c1');
      for (const value of Object.values(metadata)) {
        expect(String(value ?? '')).not.toMatch(/@/); // no email-shaped identifier
      }
      expect(JSON.stringify(metadata)).not.toContain(CANARY);
    });
  });

  test('the response body still returns the user their own text', async () => {
    db.updateMessage.mockResolvedValue(
      stored({ rating: 'thumbsDown', tag: 'inaccurate', text: CANARY }),
    );

    const res = await putFeedback(app, {
      rating: 'thumbsDown',
      tag: 'inaccurate',
      text: CANARY,
    }).expect(200);

    expect(res.body.feedback.text).toBe(CANARY);
  });
});
// End [knauf]
