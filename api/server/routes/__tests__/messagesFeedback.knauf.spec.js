// [knauf] KK20-327 — Seam test for the Langfuse PII gate on message feedback.
// Pins that the user's free-text comment (`feedback.text`) never reaches
// Langfuse while the structured signal (`rating`, `tag`) still does, and that
// nullish feedback still reaches upstream's score-DELETE path untouched.
// Mock/supertest shape follows `messages.knauf.spec.js`.
// See knauf/docs/privacy/workstream.md §5 (P0-1).
// End [knauf]

const express = require('express');
const request = require('supertest');

jest.mock('@librechat/api', () => ({
  unescapeLaTeX: jest.fn((x) => x),
  countTokens: jest.fn().mockResolvedValue(10),
  sendFeedbackScore: jest.fn().mockResolvedValue(undefined),
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
const { sendFeedbackScore } = require('@librechat/api');
const routes = require('../messages');

const SECRET = 'the quick brown fox jumped over the lazy dog';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/messages', routes);
  return app;
};

const putFeedback = (app) =>
  request(app)
    .put('/api/messages/c1/m1/feedback')
    .send({ feedback: { rating: 'thumbsDown' } });

describe('PUT /api/messages/:conversationId/:messageId/feedback — Langfuse PII gate', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test('does not forward the free-text comment to Langfuse', async () => {
    db.updateMessage.mockResolvedValue({
      messageId: 'm1',
      conversationId: 'c1',
      endpoint: 'agents',
      feedback: { rating: 'thumbsDown', tag: 'inaccurate', text: SECRET },
    });

    await putFeedback(app).expect(200);

    expect(sendFeedbackScore).toHaveBeenCalledTimes(1);
    const { feedback } = sendFeedbackScore.mock.calls[0][0];
    expect(feedback).toEqual({ rating: 'thumbsDown', tag: 'inaccurate' });
    expect(feedback).not.toHaveProperty('text');
    // Belt and braces: the secret must not appear anywhere in the payload.
    expect(JSON.stringify(sendFeedbackScore.mock.calls[0][0])).not.toContain(SECRET);
  });

  test('still forwards the structured signal (rating + tag)', async () => {
    db.updateMessage.mockResolvedValue({
      messageId: 'm1',
      conversationId: 'c1',
      endpoint: 'agents',
      // Must be a real FEEDBACK_REASON_KEYS member — invented tags are dropped by design.
      feedback: { rating: 'thumbsUp', tag: 'accurate_reliable', text: SECRET },
    });

    await putFeedback(app).expect(200);

    const { feedback } = sendFeedbackScore.mock.calls[0][0];
    expect(feedback.rating).toBe('thumbsUp');
    expect(feedback.tag).toBe('accurate_reliable');
  });

  test('passes nullish feedback through so the score-DELETE path still fires', async () => {
    db.updateMessage.mockResolvedValue({
      messageId: 'm1',
      conversationId: 'c1',
      endpoint: 'agents',
      feedback: null,
    });

    await putFeedback(app).expect(200);

    expect(sendFeedbackScore).toHaveBeenCalledTimes(1);
    expect(sendFeedbackScore.mock.calls[0][0].feedback).toBeNull();
  });

  test('keeps the response body unchanged — the user still sees their own text', async () => {
    db.updateMessage.mockResolvedValue({
      messageId: 'm1',
      conversationId: 'c1',
      endpoint: 'agents',
      feedback: { rating: 'thumbsDown', tag: 'inaccurate', text: SECRET },
    });

    const res = await putFeedback(app).expect(200);

    expect(res.body.feedback.text).toBe(SECRET);
  });

  test('drops a free-prose tag — the bypass around the text gate', async () => {
    db.updateMessage.mockResolvedValue({
      messageId: 'm1',
      conversationId: 'c1',
      endpoint: 'agents',
      // `tag` is Mixed and unvalidated on this route, so a crafted request can put the
      // same prose here that the gate strips from `text`.
      feedback: { rating: 'thumbsDown', tag: SECRET },
    });

    await putFeedback(app).expect(200);

    const { feedback } = sendFeedbackScore.mock.calls[0][0];
    expect(feedback.tag).toBeUndefined();
    expect(JSON.stringify(sendFeedbackScore.mock.calls[0][0])).not.toContain(SECRET);
  });

  test('normalises the legacy { key } tag object to its key', async () => {
    db.updateMessage.mockResolvedValue({
      messageId: 'm1',
      conversationId: 'c1',
      endpoint: 'agents',
      feedback: { rating: 'thumbsDown', tag: { key: 'inaccurate', label: 'Inaccurate' } },
    });

    await putFeedback(app).expect(200);

    expect(sendFeedbackScore.mock.calls[0][0].feedback.tag).toBe('inaccurate');
  });

  test('identity posture: only pseudonymous ids reach Langfuse metadata', async () => {
    db.updateMessage.mockResolvedValue({
      messageId: 'm1',
      conversationId: 'c1',
      endpoint: 'agents',
      feedback: { rating: 'thumbsDown', tag: 'inaccurate' },
    });

    await putFeedback(app).expect(200);

    const { metadata } = sendFeedbackScore.mock.calls[0][0];
    expect(metadata.userId).toBe('u1');
    expect(metadata.sessionId).toBe('c1');
    for (const value of Object.values(metadata)) {
      expect(String(value ?? '')).not.toMatch(/@/); // no email-shaped identifier
    }
  });
});
