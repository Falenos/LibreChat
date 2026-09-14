const EUR_PER_MILLION_TOKENS = 1_000_000;
const COST_CACHE_NAMESPACE = 'knauf:conversation-costs';
const COST_CACHE_FORMAT_VERSION = 'v3';
const COST_CACHE_TTL_MS = 86_400_000;
const COST_LOOKUP_INDEX = { user: 1, conversationId: 1, updatedAt: -1, _id: -1 };
const COST_LOOKUP_INDEX_NAME = 'knauf_cost_user_conversation_updatedAt_id';
const TRANSACTION_COST_FIELDS =
  '_id model context tokenType rawAmount inputTokens inputTokenCount writeTokens readTokens messageId updatedAt knauf_requestedModel knauf_costEstimated knauf_costEstimateReason knauf_costRateSource knauf_pricingMatch';

const RATE_SOURCE = 'azure-retail-eur-swedencentral-global-2026-09-11';
const RATE_SOURCE_LABEL =
  'Azure Retail Prices API · Global Standard · EUR · 2026-09-11 · conservative router fallback';
const LONG_CONTEXT_THRESHOLD = 272_000;
const MODEL_ROUTER_INPUT_PER_MILLION = 0.1229;
const EUR_RATES = {
  'gpt-5.4-nano': {
    modelVersion: '2026-03-17',
    effectiveFrom: '2026-03-01',
    inputPerMillion: 0.1755,
    cachedInputPerMillion: 0.0176,
    outputPerMillion: 1.097,
  },
  'gpt-5.4-mini': {
    modelVersion: '2026-03-17',
    effectiveFrom: '2026-03-01',
    inputPerMillion: 0.6582,
    cachedInputPerMillion: 0.0658,
    outputPerMillion: 3.9491,
  },
  'gpt-5.4': {
    modelVersion: '2026-03-05',
    effectiveFrom: '2026-03-01',
    inputPerMillion: 2.1939,
    cachedInputPerMillion: 0.2194,
    outputPerMillion: 13.1637,
    longContext: {
      inputPerMillion: 4.3879,
      cachedInputPerMillion: 0.4388,
      outputPerMillion: 19.7455,
    },
  },
  'gpt-5.5': {
    modelVersion: '2026-04-24',
    effectiveFrom: '2026-05-01',
    inputPerMillion: 4.3879,
    cachedInputPerMillion: 0.4388,
    outputPerMillion: 26.3273,
    longContext: {
      inputPerMillion: 8.7758,
      cachedInputPerMillion: 0.8776,
      outputPerMillion: 39.491,
    },
  },
  'gpt-5.6-sol': {
    modelVersion: '2026-07-09',
    effectiveFrom: '2026-07-01',
    pricingBasis: 'Conservative retained rate above the current Azure Global Standard meter',
    inputPerMillion: 4.3879,
    cacheWritePerMillion: 5.4849,
    cachedInputPerMillion: 0.4388,
    outputPerMillion: 26.3273,
    longContext: {
      inputPerMillion: 8.7758,
      cacheWritePerMillion: 10.9697,
      cachedInputPerMillion: 0.8776,
      outputPerMillion: 39.491,
    },
  },
  'gpt-5.6-terra': {
    modelVersion: '2026-07-09',
    effectiveFrom: '2026-08-01',
    pricingBasis: 'Azure Retail Prices API, Global Standard',
    inputPerMillion: 1.7173,
    cacheWritePerMillion: 2.1467,
    cachedInputPerMillion: 0.1717,
    outputPerMillion: 10.304,
    longContext: {
      inputPerMillion: 3.4347,
      cacheWritePerMillion: 4.2933,
      cachedInputPerMillion: 0.3435,
      outputPerMillion: 15.456,
    },
  },
  'gpt-5.6-luna': {
    modelVersion: '2026-07-09',
    effectiveFrom: '2026-08-01',
    pricingBasis: 'Azure Retail Prices API, Global Standard',
    inputPerMillion: 0.1717,
    cacheWritePerMillion: 0.2147,
    cachedInputPerMillion: 0.0172,
    outputPerMillion: 1.0304,
    longContext: {
      inputPerMillion: 0.3435,
      cacheWritePerMillion: 0.4293,
      cachedInputPerMillion: 0.0343,
      outputPerMillion: 1.5456,
    },
  },
  'model-router': {
    modelVersion: 'router-fallback',
    effectiveFrom: '2026-07-17',
    pricingBasis: 'Conservative fallback above the highest configured router-pool rate',
    inputPerMillion: 4.3879,
    cacheWritePerMillion: 5.4849,
    cachedInputPerMillion: 0.4388,
    outputPerMillion: 26.3273,
    routerInputPerMillion: MODEL_ROUTER_INPUT_PER_MILLION,
    longContext: {
      inputPerMillion: 8.7758,
      cacheWritePerMillion: 10.9697,
      cachedInputPerMillion: 0.8776,
      outputPerMillion: 39.491,
    },
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
  if (value.includes('gpt-5.4-nano') || value.includes('gpt-54-nano')) {
    return 'gpt-5.4-nano';
  }
  if (value.includes('gpt-5.4-mini') || value.includes('gpt-54-mini')) {
    return 'gpt-5.4-mini';
  }
  if (value.includes('gpt-5.6-sol') || value.includes('gpt-56-sol')) {
    return 'gpt-5.6-sol';
  }
  if (value.includes('gpt-5.6-terra') || value.includes('gpt-56-terra')) {
    return 'gpt-5.6-terra';
  }
  if (value.includes('gpt-5.6-luna') || value.includes('gpt-56-luna')) {
    return 'gpt-5.6-luna';
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
  if (value.includes('model-router')) {
    return 'model-router';
  }
  return value || 'unknown';
}

function isModelRouterRequest(transaction) {
  const requestedModel = transaction.knauf_requestedModel;
  if (requestedModel) {
    return String(requestedModel).toLowerCase().includes('model-router');
  }
  return String(transaction.model || '')
    .toLowerCase()
    .includes('model-router');
}

function resolveModelPricing(model, requestedModel) {
  const normalizedModel = normalizeModel(model);
  const rate = EUR_RATES[normalizedModel];
  if (!rate) {
    if (normalizeModel(requestedModel) === 'model-router') {
      return {
        normalizedModel,
        rate: EUR_RATES['model-router'],
        pricingMatch: 'router-fallback',
        isEstimated: true,
        estimateReason: 'router-model-rate-pending',
      };
    }
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

function emptyCostTotals() {
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

function emptySummary() {
  return { ...emptyCostTotals(), models: [] };
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

function addModelSummary(target, transaction, entry) {
  const returnedModel = String(transaction.model || 'unknown');
  const requestedModel = transaction.knauf_requestedModel
    ? String(transaction.knauf_requestedModel)
    : null;
  let modelSummary = target.models.find(
    (model) => model.returnedModel === returnedModel && model.requestedModel === requestedModel,
  );
  if (!modelSummary) {
    modelSummary = {
      returnedModel,
      requestedModel,
      pricingModel: normalizeModel(returnedModel),
      ...emptyCostTotals(),
    };
    target.models.push(modelSummary);
  }
  addSummary(modelSummary, entry);
}

function calculateTransactionCost(transaction) {
  const pricing = resolveModelPricing(transaction.model, transaction.knauf_requestedModel);
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

  const inputTokenCount =
    absNumber(transaction.inputTokenCount) ||
    (transaction.tokenType === 'prompt' ? promptTokens + cachedInputTokens : 0);
  const rate =
    pricing.rate?.longContext && inputTokenCount > LONG_CONTEXT_THRESHOLD
      ? { ...pricing.rate, ...pricing.rate.longContext }
      : pricing.rate;
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
    const standardInputTokens = Math.max(0, base.inputTokens - writeTokens);
    base.cost =
      (standardInputTokens / EUR_PER_MILLION_TOKENS) * rate.inputPerMillion +
      (writeTokens / EUR_PER_MILLION_TOKENS) * (rate.cacheWritePerMillion ?? rate.inputPerMillion) +
      (base.cachedInputTokens / EUR_PER_MILLION_TOKENS) *
        (rate.cachedInputPerMillion ?? rate.inputPerMillion) +
      (base.outputTokens / EUR_PER_MILLION_TOKENS) * rate.outputPerMillion;
    if (transaction.tokenType === 'prompt' && isModelRouterRequest(transaction)) {
      base.cost +=
        ((base.inputTokens + base.cachedInputTokens) / EUR_PER_MILLION_TOKENS) *
        MODEL_ROUTER_INPUT_PER_MILLION;
    }
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
    addModelSummary(conversation, transaction, entry);

    const messageId = transaction.messageId || unassignedMessageId;
    if (!messages[messageId]) {
      messages[messageId] = emptySummary();
    }
    addSummary(messages[messageId], entry);
    addModelSummary(messages[messageId], transaction, entry);
  }

  conversation.models.sort((left, right) => right.cost - left.cost);
  Object.values(messages).forEach((message) =>
    message.models.sort((left, right) => right.cost - left.cost),
  );

  return {
    currency: 'EUR',
    source: RATE_SOURCE_LABEL,
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
    const pricing = resolveModelPricing(transaction.model, transaction.knauf_requestedModel);
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
  RATE_SOURCE_LABEL,
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
