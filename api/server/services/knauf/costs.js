const EUR_PER_MILLION_TOKENS = 1_000_000;
const COST_CACHE_NAMESPACE = 'knauf:conversation-costs';
const COST_CACHE_FORMAT_VERSION = 'v2';
const COST_CACHE_TTL_MS = 86_400_000;
const COST_LOOKUP_INDEX = { user: 1, conversationId: 1, updatedAt: -1, _id: -1 };
const COST_LOOKUP_INDEX_NAME = 'knauf_cost_user_conversation_updatedAt_id';
const TRANSACTION_COST_FIELDS =
  '_id model context tokenType rawAmount inputTokens writeTokens readTokens messageId updatedAt knauf_costEstimated knauf_costEstimateReason knauf_costRateSource knauf_pricingMatch';

const RATE_SOURCE = 'azure-retail-eur-swedencentral-global-openai-parity-2026-07-17';
const EUR_RATES = {
  'gpt-5.4-nano': {
    modelVersion: '2026-03-17',
    effectiveFrom: '2026-03-01',
    inputPerMillion: 0.1755,
    outputPerMillion: 1.097,
  },
  'gpt-5.4-mini': {
    modelVersion: '2026-03-17',
    effectiveFrom: '2026-03-01',
    inputPerMillion: 0.6582,
    outputPerMillion: 3.9491,
  },
  'gpt-5.4': {
    modelVersion: '2026-03-05',
    effectiveFrom: '2026-03-01',
    inputPerMillion: 2.1939,
    outputPerMillion: 13.1637,
  },
  'gpt-5.5': {
    modelVersion: '2026-04-24',
    effectiveFrom: '2026-05-01',
    inputPerMillion: 4.3879,
    outputPerMillion: 26.3273,
  },
  'gpt-5.6-sol': {
    modelVersion: '2026-07-09',
    effectiveFrom: '2026-07-09',
    pricingBasis: 'OpenAI GPT-5.5 price parity; Azure EUR meter pending',
    inputPerMillion: 4.3879,
    outputPerMillion: 26.3273,
  },
  'model-router': {
    modelVersion: 'router-fallback',
    effectiveFrom: '2026-07-17',
    pricingBasis: 'Conservative fallback at the highest allowed router-pool rate',
    inputPerMillion: 4.3879,
    outputPerMillion: 26.3273,
  },
  'gpt-image-1': {
    modelVersion: '2025-04-15',
    effectiveFrom: '2025-04-01',
    inputPerMillion: 4.4,
    imageInputPerMillion: 8.8,
    outputPerMillion: 35.1,
  },
  'gpt-image-2': {
    modelVersion: '2026-04-21',
    effectiveFrom: '2026-05-01',
    inputPerMillion: 4.3879,
    imageInputPerMillion: 7.0206,
    outputPerMillion: 26.3273,
  },
};

function absNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.abs(number) : 0;
}

function normalizeModel(model) {
  const value = String(model || '').toLowerCase();
  if (value.includes('model-router')) {
    return 'model-router';
  }
  if (value.includes('gpt-5.4-nano') || value.includes('gpt-54-nano')) {
    return 'gpt-5.4-nano';
  }
  if (value.includes('gpt-5.4-mini') || value.includes('gpt-54-mini')) {
    return 'gpt-5.4-mini';
  }
  if (value.includes('gpt-5.6-sol') || value.includes('gpt-56-sol')) {
    return 'gpt-5.6-sol';
  }
  if (value.includes('gpt-5.5') || value.includes('gpt-55')) {
    return 'gpt-5.5';
  }
  if (value.includes('gpt-5.4') || value.includes('gpt-54')) {
    return 'gpt-5.4';
  }
  if (value.includes('gpt-image-2')) {
    return 'gpt-image-2';
  }
  if (value.includes('gpt-image-1')) {
    return 'gpt-image-1';
  }
  return value || 'unknown';
}

function resolveModelPricing(model) {
  const normalizedModel = normalizeModel(model);
  const rate = EUR_RATES[normalizedModel];
  if (!rate) {
    return {
      normalizedModel,
      rate: null,
      pricingMatch: 'unknown',
      isEstimated: false,
      estimateReason: null,
    };
  }
  if (normalizedModel === 'model-router') {
    return {
      normalizedModel,
      rate,
      pricingMatch: 'router-fallback',
      isEstimated: true,
      estimateReason: 'router-model-not-reported',
    };
  }
  return {
    normalizedModel,
    rate,
    pricingMatch: String(model || '')
      .toLowerCase()
      .includes(rate.modelVersion)
      ? 'exact-version'
      : 'model-family',
    isEstimated: false,
    estimateReason: null,
  };
}

function emptySummary() {
  return {
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    imageInputTokens: 0,
    imageOutputTokens: 0,
    unsupportedTokens: 0,
    hasUnsupported: false,
    isEstimated: false,
    estimateReason: null,
  };
}

function addSummary(target, entry) {
  target.cost += entry.cost;
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.cachedInputTokens += entry.cachedInputTokens;
  target.imageInputTokens += entry.imageInputTokens;
  target.imageOutputTokens += entry.imageOutputTokens;
  target.unsupportedTokens += entry.unsupportedTokens;
  target.hasUnsupported = target.hasUnsupported || entry.hasUnsupported;
  target.isEstimated = target.isEstimated || entry.isEstimated;
  target.estimateReason = target.estimateReason || entry.estimateReason;
}

function calculateTransactionCost(transaction) {
  const pricing = resolveModelPricing(transaction.model);
  const rawAmount = absNumber(transaction.rawAmount);
  const inputTokens = absNumber(transaction.inputTokens);
  const writeTokens = absNumber(transaction.writeTokens);
  const readTokens = absNumber(transaction.readTokens);
  const hasStructuredPrompt = inputTokens > 0 || writeTokens > 0 || readTokens > 0;
  const promptTokens = hasStructuredPrompt ? inputTokens + writeTokens : rawAmount;
  const cachedInputTokens = readTokens;
  const outputTokens = transaction.tokenType === 'completion' ? rawAmount : 0;
  const base = {
    cost: 0,
    inputTokens: transaction.tokenType === 'prompt' ? promptTokens : 0,
    outputTokens,
    cachedInputTokens,
    imageInputTokens: 0,
    imageOutputTokens: 0,
    unsupportedTokens: 0,
    hasUnsupported: false,
    isEstimated: false,
    estimateReason: null,
  };

  const { rate } = pricing;
  if (rate?.imageInputPerMillion) {
    base.inputTokens = transaction.tokenType === 'prompt' ? inputTokens || rawAmount : 0;
    base.cachedInputTokens = 0;
    base.outputTokens = 0;
    base.imageInputTokens = transaction.tokenType === 'prompt' ? writeTokens : 0;
    base.imageOutputTokens = outputTokens;
    base.cost =
      (base.inputTokens / EUR_PER_MILLION_TOKENS) * rate.inputPerMillion +
      (base.imageInputTokens / EUR_PER_MILLION_TOKENS) * rate.imageInputPerMillion +
      (base.imageOutputTokens / EUR_PER_MILLION_TOKENS) * rate.outputPerMillion;
    return base;
  }

  if (rate) {
    base.cost =
      ((base.inputTokens + base.cachedInputTokens) / EUR_PER_MILLION_TOKENS) *
        rate.inputPerMillion +
      (base.outputTokens / EUR_PER_MILLION_TOKENS) * rate.outputPerMillion;
    base.isEstimated = pricing.isEstimated;
    base.estimateReason = pricing.estimateReason;
    return base;
  }

  base.unsupportedTokens = promptTokens + cachedInputTokens + outputTokens;
  base.hasUnsupported = base.unsupportedTokens > 0;
  return base;
}

function aggregateConversationCosts(transactions = []) {
  const conversation = emptySummary();
  const messages = {};
  const unassignedMessageId = '__conversation__';

  for (const transaction of transactions) {
    if (!transaction || transaction.tokenType === 'credits') {
      continue;
    }
    const entry = calculateTransactionCost(transaction);
    addSummary(conversation, entry);

    const messageId = transaction.messageId || unassignedMessageId;
    if (!messages[messageId]) {
      messages[messageId] = emptySummary();
    }
    addSummary(messages[messageId], entry);
  }

  return {
    currency: 'EUR',
    source: RATE_SOURCE,
    rates: EUR_RATES,
    conversation,
    messages,
  };
}

let costCache;
let costIndexPromise;

function getCostCache() {
  if (!costCache) {
    const { standardCache } = require('@librechat/api');
    costCache = standardCache(COST_CACHE_NAMESPACE, COST_CACHE_TTL_MS);
  }
  return costCache;
}

function buildCostCacheKey(userId, conversationId) {
  return `${COST_CACHE_FORMAT_VERSION}:${RATE_SOURCE}:${String(userId)}:${conversationId}`;
}

function sameFingerprint(left, right) {
  return (
    (left?.latestTransactionId || null) === (right?.latestTransactionId || null) &&
    (left?.latestUpdatedAt || null) === (right?.latestUpdatedAt || null)
  );
}

function ensureCostLookupIndex(Transaction) {
  if (costIndexPromise || !Transaction?.collection?.createIndex) {
    return costIndexPromise;
  }

  costIndexPromise = Transaction.collection
    .createIndex(COST_LOOKUP_INDEX, { name: COST_LOOKUP_INDEX_NAME })
    .catch(() => undefined);
  return costIndexPromise;
}

async function readTransactionFingerprint(Transaction, filter) {
  const latest = await Transaction.findOne(filter)
    .sort({ updatedAt: -1, _id: -1 })
    .select({ _id: 1, updatedAt: 1 })
    .lean();

  return {
    latestTransactionId: latest?._id ? String(latest._id) : null,
    latestUpdatedAt: latest?.updatedAt ? new Date(latest.updatedAt).toISOString() : null,
  };
}

async function readTransactionCostRows(Transaction, filter) {
  return Transaction.find(filter).select(TRANSACTION_COST_FIELDS).lean();
}

async function persistTransactionCostProvenance(Transaction, transactions) {
  if (typeof Transaction?.bulkWrite !== 'function') {
    return;
  }
  const operations = transactions.flatMap((transaction) => {
    if (!transaction?._id) {
      return [];
    }
    const pricing = resolveModelPricing(transaction.model);
    const provenance = {
      knauf_costEstimated: pricing.isEstimated,
      knauf_costEstimateReason: pricing.estimateReason,
      knauf_costRateSource: RATE_SOURCE,
      knauf_pricingMatch: pricing.pricingMatch,
    };
    if (Object.entries(provenance).every(([key, value]) => transaction[key] === value)) {
      return [];
    }
    return [{ updateOne: { filter: { _id: transaction._id }, update: { $set: provenance } } }];
  });
  if (operations.length > 0) {
    await Transaction.bulkWrite(operations, { ordered: false, timestamps: false });
  }
}

async function safeGet(cache, key) {
  try {
    return await cache.get(key);
  } catch {
    return null;
  }
}

async function safeSet(cache, key, value) {
  try {
    await cache.set(key, value, COST_CACHE_TTL_MS);
  } catch {
    // Cache is an optimization only; the request has already computed a fresh result.
  }
}

async function getConversationCosts({
  userId,
  conversationId,
  Transaction,
  cache = getCostCache(),
}) {
  const filter = { user: userId, conversationId };
  void ensureCostLookupIndex(Transaction);
  const fingerprint = await readTransactionFingerprint(Transaction, filter);
  const key = buildCostCacheKey(userId, conversationId);
  const cached = await safeGet(cache, key);

  if (cached?.summary && sameFingerprint(cached.fingerprint, fingerprint)) {
    return cached.summary;
  }

  const transactions = await readTransactionCostRows(Transaction, filter);
  await persistTransactionCostProvenance(Transaction, transactions);
  const summary = aggregateConversationCosts(transactions);
  await safeSet(cache, key, { fingerprint, summary });
  return summary;
}

module.exports = {
  COST_CACHE_NAMESPACE,
  COST_CACHE_TTL_MS,
  RATE_SOURCE,
  EUR_RATES,
  aggregateConversationCosts,
  calculateTransactionCost,
  COST_LOOKUP_INDEX,
  COST_LOOKUP_INDEX_NAME,
  getConversationCosts,
  normalizeModel,
  persistTransactionCostProvenance,
  readTransactionFingerprint,
  resolveModelPricing,
  sameFingerprint,
};
