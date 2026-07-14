const EUR_PER_MILLION_TOKENS = 1_000_000;
const COST_CACHE_NAMESPACE = 'knauf:conversation-costs';
const COST_CACHE_TTL_MS = 86_400_000;
const COST_LOOKUP_INDEX = { user: 1, conversationId: 1, updatedAt: -1, _id: -1 };
const COST_LOOKUP_INDEX_NAME = 'knauf_cost_user_conversation_updatedAt_id';
const TRANSACTION_COST_FIELDS =
  'model context tokenType rawAmount inputTokens writeTokens readTokens messageId updatedAt';

const RATE_SOURCE = 'azure-retail-eur-swedencentral-global-2026-07-14';
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
  if (value.includes('gpt-5.5') || value.includes('gpt-55')) {
    return 'gpt-5.5';
  }
  if (value.includes('gpt-5.4') || value.includes('gpt-54')) {
    return 'gpt-5.4';
  }
  if (value.includes('gpt-image-1')) {
    return 'gpt-image-1';
  }
  return value || 'unknown';
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
}

function calculateTransactionCost(transaction) {
  const model = normalizeModel(transaction.model);
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
  };

  const rate = EUR_RATES[model];
  if (rate) {
    base.cost =
      ((base.inputTokens + base.cachedInputTokens) / EUR_PER_MILLION_TOKENS) *
        rate.inputPerMillion +
      (base.outputTokens / EUR_PER_MILLION_TOKENS) * rate.outputPerMillion;
    return base;
  }

  if (model === 'gpt-image-1') {
    base.imageInputTokens =
      transaction.tokenType === 'prompt' ? promptTokens + cachedInputTokens : 0;
    base.imageOutputTokens = outputTokens;
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
  return `${RATE_SOURCE}:${String(userId)}:${conversationId}`;
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
  readTransactionFingerprint,
  sameFingerprint,
};
