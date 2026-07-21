const {
  aggregateConversationCosts,
  calculateTransactionCost,
  COST_LOOKUP_INDEX,
  COST_LOOKUP_INDEX_NAME,
  EUR_RATES,
  getConversationCosts,
  normalizeModel,
  resolveModelPricing,
  RATE_SOURCE,
} = require('./costs');

function chain(result) {
  return {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

function createCache(initialValue) {
  return {
    get: jest.fn().mockResolvedValue(initialValue),
    set: jest.fn().mockResolvedValue(undefined),
  };
}

describe('knauf costs', () => {
  it.each([
    ['gpt-54-nano-2026-03-17', 'gpt-5.4-nano'],
    ['azure/gpt-5.4-mini-2026-03-17', 'gpt-5.4-mini'],
    ['gpt-54', 'gpt-5.4'],
    ['gpt-55-2026-04-24', 'gpt-5.5'],
    ['azure/gpt-5.6-sol-2026-07-09', 'gpt-5.6-sol'],
    ['model-router-chat', 'model-router'],
    ['gpt-image-2-2026-04-21', 'gpt-image-2'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeModel(input)).toBe(expected);
  });

  it.each([
    ['gpt-55-2026-04-24', 'exact-version', false],
    ['gpt-5.5', 'model-family', false],
    ['model-router-chat', 'router-fallback', true],
    ['unknown-model', 'unknown', false],
  ])('resolves %s as %s', (model, pricingMatch, isEstimated) => {
    expect(resolveModelPricing(model)).toMatchObject({ pricingMatch, isEstimated });
  });

  it.each([
    ['gpt-5.4-nano', 0.1755, 1.097],
    ['gpt-5.4-mini', 0.6582, 3.9491],
    ['gpt-5.4', 2.1939, 13.1637],
    ['gpt-5.5', 4.3879, 26.3273],
    ['gpt-5.6-sol', 4.3879, 26.3273],
  ])('calculates %s input and output prices', (model, inputPrice, outputPrice) => {
    const input = calculateTransactionCost({
      model,
      tokenType: 'prompt',
      rawAmount: -100_000,
    });
    const output = calculateTransactionCost({
      model,
      tokenType: 'completion',
      rawAmount: -1_000_000,
    });

    expect(input.cost).toBeCloseTo(inputPrice / 10);
    expect(output.cost).toBeCloseTo(outputPrice);
  });

  it('stores effective model versions with the static retail rates', () => {
    expect(RATE_SOURCE).toBe('azure-retail-eur-swedencentral-global-2026-07-21');
    expect(EUR_RATES['gpt-5.5']).toMatchObject({
      modelVersion: '2026-04-24',
      effectiveFrom: '2026-05-01',
    });
    expect(EUR_RATES['gpt-5.6-sol']).toMatchObject({
      modelVersion: '2026-07-09',
      effectiveFrom: '2026-07-01',
      pricingBasis: 'Azure Retail Prices API, Global Standard',
      inputPerMillion: 4.3879,
      outputPerMillion: 26.3273,
    });
  });

  it('counts cache reads at the discounted cached-input rate', () => {
    const result = calculateTransactionCost({
      model: 'gpt-54',
      tokenType: 'prompt',
      inputTokens: -100_000,
      readTokens: -100_000,
    });

    expect(result.inputTokens).toBe(100_000);
    expect(result.cachedInputTokens).toBe(100_000);
    expect(result.cost).toBeCloseTo(0.24133);
  });

  it('adds the Model Router input fee to the selected model rate', () => {
    const input = calculateTransactionCost({
      model: 'gpt-5.4-mini-2026-03-17',
      knauf_requestedModel: 'model-router-chat',
      tokenType: 'prompt',
      rawAmount: -1_000_000,
    });
    const output = calculateTransactionCost({
      model: 'gpt-5.4-mini-2026-03-17',
      knauf_requestedModel: 'model-router-chat',
      tokenType: 'completion',
      rawAmount: -1_000_000,
    });

    expect(input.cost).toBeCloseTo(0.6582 + 0.1229);
    expect(output.cost).toBeCloseTo(3.9491);
    expect(input.isEstimated).toBe(false);
  });

  it('does not add the Model Router fee to a direct model call', () => {
    const input = calculateTransactionCost({
      model: 'gpt-5.4-mini-2026-03-17',
      knauf_requestedModel: 'gpt-5.4-mini',
      tokenType: 'prompt',
      rawAmount: -1_000_000,
    });

    expect(input.cost).toBeCloseTo(0.6582);
  });

  it.each([
    ['gpt-5.4', 4.3879, 19.7455],
    ['gpt-5.5', 8.7758, 39.491],
    ['gpt-5.6-sol', 8.7758, 39.491],
  ])('uses %s long-context rates above 272k input tokens', (model, inputPrice, outputPrice) => {
    const input = calculateTransactionCost({
      model,
      tokenType: 'prompt',
      rawAmount: -1_000_000,
      inputTokenCount: 272_001,
    });
    const output = calculateTransactionCost({
      model,
      tokenType: 'completion',
      rawAmount: -1_000_000,
      inputTokenCount: 272_001,
    });

    expect(input.cost).toBeCloseTo(inputPrice);
    expect(output.cost).toBeCloseTo(outputPrice);
  });

  it.each([
    [272_000, 100_000, 0.54849],
    [272_001, 1_000_000, 10.9697],
  ])(
    'uses the gpt-5.6-sol cache-write meter at %i total input tokens',
    (inputTokenCount, writeTokens, expectedCost) => {
      const result = calculateTransactionCost({
        model: 'gpt-5.6-sol',
        tokenType: 'prompt',
        writeTokens: -writeTokens,
        inputTokenCount,
      });

      expect(result.cost).toBeCloseTo(expectedCost);
    },
  );

  it('uses the conservative fallback when Azure reports only the router alias', () => {
    const input = calculateTransactionCost({
      model: 'model-router-chat',
      tokenType: 'prompt',
      rawAmount: -1_000_000,
    });
    const output = calculateTransactionCost({
      model: 'model-router',
      tokenType: 'completion',
      rawAmount: -1_000_000,
    });

    expect(input.cost).toBeCloseTo(8.7758 + 0.1229);
    expect(output.cost).toBeCloseTo(EUR_RATES['gpt-5.5'].outputPerMillion);
    expect(input).toMatchObject({
      isEstimated: true,
      estimateReason: 'router-model-not-reported',
    });
  });

  it('keeps unknown model tokens explicit', () => {
    const result = calculateTransactionCost({
      model: 'unknown-model',
      tokenType: 'prompt',
      rawAmount: -123,
    });

    expect(result).toMatchObject({ cost: 0, unsupportedTokens: 123, hasUnsupported: true });
  });

  it('aggregates per conversation and per message', () => {
    const result = aggregateConversationCosts([
      {
        model: 'gpt-54',
        tokenType: 'prompt',
        rawAmount: -100_000,
        messageId: 'm1',
      },
      {
        model: 'gpt-54',
        tokenType: 'completion',
        rawAmount: -1_000_000,
        messageId: 'm1',
      },
    ]);

    expect(result.currency).toBe('EUR');
    expect(result.conversation.cost).toBeCloseTo(13.38309);
    expect(result.messages.m1.cost).toBeCloseTo(13.38309);
  });

  it.each([
    ['gpt-image-1', 4.4, 8.8, 35.1],
    ['gpt-image-2', 4.3879, 7.0206, 26.3273],
  ])(
    'calculates %s text input, image input, and image output prices',
    (model, textInputPrice, imageInputPrice, outputPrice) => {
      const input = calculateTransactionCost({
        model,
        tokenType: 'prompt',
        inputTokens: -1_000_000,
        writeTokens: -1_000_000,
      });
      const output = calculateTransactionCost({
        model,
        tokenType: 'completion',
        rawAmount: -1_000_000,
      });

      expect(input.cost).toBeCloseTo(textInputPrice + imageInputPrice);
      expect(input.inputTokens).toBe(1_000_000);
      expect(input.imageInputTokens).toBe(1_000_000);
      expect(output.cost).toBeCloseTo(outputPrice);
      expect(output.outputTokens).toBe(0);
      expect(output.imageOutputTokens).toBe(1_000_000);
      expect(output.hasUnsupported).toBe(false);
    },
  );

  it('returns cached aggregate when the transaction fingerprint is unchanged', async () => {
    const summary = aggregateConversationCosts([]);
    const Transaction = {
      collection: { createIndex: jest.fn().mockResolvedValue(COST_LOOKUP_INDEX_NAME) },
      countDocuments: jest.fn(),
      findOne: jest.fn(() =>
        chain({ _id: 'tx-latest', updatedAt: new Date('2026-06-26T10:00:00.000Z') }),
      ),
      find: jest.fn(),
    };
    const cache = createCache({
      fingerprint: {
        latestTransactionId: 'tx-latest',
        latestUpdatedAt: '2026-06-26T10:00:00.000Z',
      },
      summary,
    });

    const result = await getConversationCosts({
      userId: 'user-1',
      conversationId: 'conversation-1',
      Transaction,
      cache,
    });

    expect(result).toBe(summary);
    expect(Transaction.collection.createIndex).toHaveBeenCalledWith(COST_LOOKUP_INDEX, {
      name: COST_LOOKUP_INDEX_NAME,
    });
    expect(Transaction.countDocuments).not.toHaveBeenCalled();
    expect(Transaction.find).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('refreshes and caches aggregate when the transaction fingerprint changes', async () => {
    const Transaction = {
      countDocuments: jest.fn(),
      findOne: jest.fn(() =>
        chain({ _id: 'tx-new', updatedAt: new Date('2026-06-26T10:00:00.000Z') }),
      ),
      find: jest.fn(() =>
        chain([
          {
            model: 'gpt-54',
            tokenType: 'prompt',
            rawAmount: -1_000_000,
            messageId: 'message-1',
          },
        ]),
      ),
    };
    const cache = createCache({
      fingerprint: { latestTransactionId: 'tx-old', latestUpdatedAt: null },
      summary: aggregateConversationCosts([]),
    });

    const result = await getConversationCosts({
      userId: 'user-1',
      conversationId: 'conversation-1',
      Transaction,
      cache,
    });

    expect(Transaction.countDocuments).not.toHaveBeenCalled();
    expect(Transaction.find).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conversation-1',
    });
    expect(result.conversation.cost).toBeCloseTo(4.3879);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('conversation-1'),
      expect.objectContaining({
        fingerprint: {
          latestTransactionId: 'tx-new',
          latestUpdatedAt: '2026-06-26T10:00:00.000Z',
        },
        summary: result,
      }),
      expect.any(Number),
    );
  });

  it('persists router pricing provenance on transaction rows', async () => {
    const bulkWrite = jest.fn().mockResolvedValue(undefined);
    const Transaction = {
      bulkWrite,
      findOne: jest.fn(() => chain({ _id: 'tx-router', updatedAt: new Date(0) })),
      find: jest.fn(() =>
        chain([
          {
            _id: 'tx-router',
            model: 'model-router-chat',
            tokenType: 'prompt',
            rawAmount: -100,
          },
        ]),
      ),
    };

    await getConversationCosts({
      userId: 'user-1',
      conversationId: 'conversation-1',
      Transaction,
      cache: createCache(null),
    });

    expect(bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: { _id: 'tx-router' },
            update: {
              $set: {
                knauf_costEstimated: true,
                knauf_costEstimateReason: 'router-model-not-reported',
                knauf_costRateSource: RATE_SOURCE,
                knauf_pricingMatch: 'router-fallback',
              },
            },
          },
        },
      ],
      { ordered: false, timestamps: false },
    );
  });
});
