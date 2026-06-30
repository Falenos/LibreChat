const express = require('express');
const request = require('supertest');
const costs = require('./costs');

const mockGetConversationCosts = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

jest.mock('mongoose', () => ({
  models: {
    Transaction: jest.fn(),
  },
}));

jest.mock('~/server/services/knauf/costs', () => ({
  getConversationCosts: (...args) => mockGetConversationCosts(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

function createApp() {
  const app = express();
  app.use('/costs', costs);
  return app;
}

describe('knauf costs route', () => {
  beforeEach(() => {
    mockGetConversationCosts.mockReset();
  });

  it('returns current-user conversation costs from the cached transaction cost service', async () => {
    mockGetConversationCosts.mockResolvedValue({
      currency: 'EUR',
      conversation: { cost: 1.9567367651485807 },
      messages: {
        'message-1': { inputTokens: 1_000_000 },
      },
    });

    const response = await request(createApp()).get('/costs/conversations/conversation-1');

    expect(response.status).toBe(200);
    expect(mockGetConversationCosts).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'conversation-1',
      Transaction: expect.any(Function),
    });
    expect(response.body.currency).toBe('EUR');
    expect(response.body.conversation.cost).toBeCloseTo(1.9567367651485807);
    expect(response.body.messages['message-1'].inputTokens).toBe(1_000_000);
  });
});
