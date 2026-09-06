const mongoose = require('mongoose');
// [knauf] Wait for queued reconciliation mutations instead of only accepting them.
const { MeiliSearch, MeiliSearchTimeOutError } = require('meilisearch');
// End [knauf]
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { isEnabled, FlowStateManager } = require('@librechat/api');
// [knauf] Serialize the full Meilisearch reconciliation operation across API replicas.
const { withMeiliSyncLock } = require('~/knauf/db/meiliSyncLock');
// End [knauf]
const { getLogStores } = require('~/cache');
const { batchResetMeiliFlags } = require('./utils');

const searchEnabled = isEnabled(process.env.SEARCH);
const indexingDisabled = isEnabled(process.env.MEILI_NO_SYNC);

// [knauf] Periodically repair drift after an ephemeral Meilisearch restart.
const reconciliationIntervalMs = 15 * 60 * 1000;
let reconciliationInterval = null;
// End [knauf]

const defaultSyncThreshold = 1000;
const syncThreshold = process.env.MEILI_SYNC_THRESHOLD
  ? parseInt(process.env.MEILI_SYNC_THRESHOLD, 10)
  : defaultSyncThreshold;

class MeiliSearchClient {
  static instance = null;

  static getInstance() {
    if (!MeiliSearchClient.instance) {
      if (!process.env.MEILI_HOST || !process.env.MEILI_MASTER_KEY) {
        throw new Error('Meilisearch configuration is missing.');
      }
      MeiliSearchClient.instance = new MeiliSearch({
        host: process.env.MEILI_HOST,
        apiKey: process.env.MEILI_MASTER_KEY,
      });
    }
    return MeiliSearchClient.instance;
  }
}

// [knauf] Keep the operation lease until a queued Meilisearch mutation is terminal.
async function waitForSuccessfulTask(client, taskUid, operation) {
  while (true) {
    try {
      const task = await client.waitForTask(taskUid, { timeOutMs: 10_000, intervalMs: 250 });
      if (task.status !== 'succeeded') {
        throw new Error(`${operation} task ${taskUid} ended with ${task.status}`);
      }
      return;
    } catch (error) {
      if (error instanceof MeiliSearchTimeOutError) {
        continue;
      }
      throw error;
    }
  }
}
// End [knauf]

// [knauf] Treat a missing ephemeral index as empty without hiding other provider failures.
async function getIndexDocumentCount(index) {
  try {
    return (await index.getStats()).numberOfDocuments;
  } catch (error) {
    if (error.code === 'index_not_found') {
      return 0;
    }
    throw error;
  }
}
// End [knauf]

/**
 * Deletes documents from MeiliSearch index that are missing the user field
 * @param {import('meilisearch').Index} index - MeiliSearch index instance
 * @param {string} indexName - Name of the index for logging
 * @param {string} primaryKey - Primary key configured for the index
 * @returns {Promise<number>} - Number of documents deleted
 */
// [knauf] Use each index's real primary key and detect cleanup pages that cannot advance.
async function deleteDocumentsWithoutUserField(index, indexName, primaryKey) {
  let deletedCount = 0;
  let offset = 0;
  let previousPageSignature;
  const batchSize = 1000;
  // End [knauf]

  try {
    while (true) {
      const searchResult = await index.search('', {
        limit: batchSize,
        offset: offset,
      });

      if (searchResult.hits.length === 0) {
        break;
      }

      // [knauf] Fail retryably instead of renewing the operation lease around a stalled page.
      const orphanedHits = searchResult.hits.filter((hit) => !hit.user);
      if (orphanedHits.some((hit) => hit[primaryKey] == null)) {
        throw new Error(`[indexSync] Cannot clean ${indexName} document without ${primaryKey}`);
      }
      const pageSignature = `${offset}:${searchResult.hits
        .map((hit) => String(hit[primaryKey]))
        .join(',')}`;
      if (pageSignature === previousPageSignature) {
        throw new Error(`[indexSync] ${indexName} cleanup made no progress`);
      }
      previousPageSignature = pageSignature;
      const idsToDelete = orphanedHits.map((hit) => hit[primaryKey]);
      // End [knauf]

      if (idsToDelete.length > 0) {
        logger.info(
          `[indexSync] Deleting ${idsToDelete.length} documents without user field from ${indexName} index`,
        );
        // [knauf] Confirm cleanup before releasing reconciliation ownership.
        const deletion = await index.deleteDocuments(idsToDelete);
        await waitForSuccessfulTask(MeiliSearchClient.getInstance(), deletion.taskUid, indexName);
        // End [knauf]
        deletedCount += idsToDelete.length;
      }

      if (searchResult.hits.length < batchSize) {
        break;
      }

      // [knauf] Completed deletions compact the result set; advance only past retained hits.
      offset += searchResult.hits.length - idsToDelete.length;
      // End [knauf]
    }

    if (deletedCount > 0) {
      logger.info(`[indexSync] Deleted ${deletedCount} orphaned documents from ${indexName} index`);
    }
  } catch (error) {
    logger.error(`[indexSync] Error deleting documents from ${indexName}:`, error);
    // [knauf] Keep failed cleanup retryable under the operation lease.
    throw error;
    // End [knauf]
  }

  return deletedCount;
}

/**
 * Ensures indexes have proper filterable attributes configured and checks if documents have user field
 * @param {MeiliSearch} client - MeiliSearch client instance
 * @returns {Promise<{settingsUpdated: boolean, orphanedDocsFound: boolean}>} - Status of what was done
 */
async function ensureFilterableAttributes(client) {
  let settingsUpdated = false;
  let hasOrphanedDocs = false;

  try {
    // Check and update messages index
    try {
      const messagesIndex = client.index('messages');
      const settings = await messagesIndex.getSettings();

      if (!settings.filterableAttributes || !settings.filterableAttributes.includes('user')) {
        logger.info('[indexSync] Configuring messages index to filter by user...');
        const settingsTask = await messagesIndex.updateSettings({
          filterableAttributes: ['user'],
        });
        // [knauf] Confirm settings application before resetting durable sync flags.
        await waitForSuccessfulTask(client, settingsTask.taskUid, 'messages settings');
        // End [knauf]
        logger.info('[indexSync] Messages index configured for user filtering');
        settingsUpdated = true;
      }

      // Check if existing documents have user field indexed
      try {
        const searchResult = await messagesIndex.search('', { limit: 1 });
        if (searchResult.hits.length > 0 && !searchResult.hits[0].user) {
          logger.info(
            '[indexSync] Existing messages missing user field, will clean up orphaned documents...',
          );
          hasOrphanedDocs = true;
        }
      } catch (searchError) {
        logger.debug('[indexSync] Could not check message documents:', searchError.message);
      }
    } catch (error) {
      if (error.code !== 'index_not_found') {
        logger.warn('[indexSync] Could not check/update messages index settings:', error.message);
        // [knauf] Do not release reconciliation ownership as successful after a failed settings task.
        throw error;
        // End [knauf]
      }
    }

    // Check and update conversations index
    try {
      const convosIndex = client.index('convos');
      const settings = await convosIndex.getSettings();

      if (!settings.filterableAttributes || !settings.filterableAttributes.includes('user')) {
        logger.info('[indexSync] Configuring convos index to filter by user...');
        const settingsTask = await convosIndex.updateSettings({
          filterableAttributes: ['user'],
        });
        // [knauf] Confirm settings application before resetting durable sync flags.
        await waitForSuccessfulTask(client, settingsTask.taskUid, 'convos settings');
        // End [knauf]
        logger.info('[indexSync] Convos index configured for user filtering');
        settingsUpdated = true;
      }

      // Check if existing documents have user field indexed
      try {
        const searchResult = await convosIndex.search('', { limit: 1 });
        if (searchResult.hits.length > 0 && !searchResult.hits[0].user) {
          logger.info(
            '[indexSync] Existing conversations missing user field, will clean up orphaned documents...',
          );
          hasOrphanedDocs = true;
        }
      } catch (searchError) {
        logger.debug('[indexSync] Could not check conversation documents:', searchError.message);
      }
    } catch (error) {
      if (error.code !== 'index_not_found') {
        logger.warn('[indexSync] Could not check/update convos index settings:', error.message);
        // [knauf] Do not release reconciliation ownership as successful after a failed settings task.
        throw error;
        // End [knauf]
      }
    }

    // If either index has orphaned documents, clean them up (but don't force resync)
    if (hasOrphanedDocs) {
      try {
        const messagesIndex = client.index('messages');
        // [knauf] Meilisearch message documents are keyed by messageId, not a generic id.
        await deleteDocumentsWithoutUserField(messagesIndex, 'messages', 'messageId');
        // End [knauf]
      } catch (error) {
        // [knauf] Tolerate only an index that disappeared; propagate real cleanup failures.
        if (error.code === 'index_not_found') {
          logger.debug('[indexSync] Messages index disappeared before cleanup');
        } else {
          throw error;
        }
        // End [knauf]
      }

      try {
        const convosIndex = client.index('convos');
        // [knauf] Meilisearch conversation documents are keyed by conversationId.
        await deleteDocumentsWithoutUserField(convosIndex, 'convos', 'conversationId');
        // End [knauf]
      } catch (error) {
        // [knauf] Tolerate only an index that disappeared; propagate real cleanup failures.
        if (error.code === 'index_not_found') {
          logger.debug('[indexSync] Conversations index disappeared before cleanup');
        } else {
          throw error;
        }
        // End [knauf]
      }

      logger.info('[indexSync] Orphaned documents cleaned up without forcing resync.');
    }

    if (settingsUpdated) {
      logger.info('[indexSync] Index settings updated. Full re-sync will be triggered.');
    }
  } catch (error) {
    logger.error('[indexSync] Error ensuring filterable attributes:', error);
    // [knauf] Failed preflight mutations must fail the leased reconciliation attempt.
    throw error;
    // End [knauf]
  }

  return { settingsUpdated, orphanedDocsFound: hasOrphanedDocs };
}

/**
 * Performs the actual sync operations for messages and conversations
 * @param {FlowStateManager} flowManager - Flow state manager instance
 * @param {string} flowId - Flow identifier
 * @param {string} flowType - Flow type
 */
async function performSync(flowManager, flowId, flowType) {
  try {
    if (indexingDisabled === true) {
      logger.info('[indexSync] Indexing is disabled, skipping...');
      return { messagesSync: false, convosSync: false };
    }

    const Message = mongoose.models.Message;
    const Conversation = mongoose.models.Conversation;
    if (!Message || !Conversation) {
      throw new Error(
        '[indexSync] Models not registered. Ensure createModels() has been called before indexSync.',
      );
    }

    const client = MeiliSearchClient.getInstance();

    const { status } = await client.health();
    if (status !== 'available') {
      throw new Error('Meilisearch not available');
    }

    /** Ensures indexes have proper filterable attributes configured */
    const { settingsUpdated, orphanedDocsFound: _orphanedDocsFound } =
      await ensureFilterableAttributes(client);

    let messagesSync = false;
    let convosSync = false;

    // Only reset flags if settings were actually updated (not just for orphaned doc cleanup)
    if (settingsUpdated) {
      logger.info(
        '[indexSync] Settings updated. Forcing full re-sync to reindex with new configuration...',
      );

      // Reset sync flags to force full re-sync
      await batchResetMeiliFlags(Message.collection);
      await batchResetMeiliFlags(Conversation.collection);
    }

    // Check if we need to sync messages
    logger.info('[indexSync] Requesting message sync progress...');
    let messageProgress = await Message.getSyncProgress();
    // [knauf] Mongo flags survive Meilisearch pod resets; reset them when the index falls behind.
    const messagesInMeili = await getIndexDocumentCount(client.index('messages'));
    const messagesIndexBehind = messagesInMeili < messageProgress.totalProcessed;
    if (messagesIndexBehind) {
      logger.warn(
        `[indexSync] Messages index has ${messagesInMeili} documents but Mongo marks ${messageProgress.totalProcessed} indexed. Forcing full re-sync.`,
      );
      await batchResetMeiliFlags(Message.collection);
      messageProgress = await Message.getSyncProgress();
    }
    // End [knauf]
    if (!messageProgress.isComplete || settingsUpdated || messagesIndexBehind) {
      logger.info(
        `[indexSync] Messages need syncing: ${messageProgress.totalProcessed}/${messageProgress.totalDocuments} indexed`,
      );

      const messageCount = messageProgress.totalDocuments;
      const messagesIndexed = messageProgress.totalProcessed;
      const unindexedMessages = messageCount - messagesIndexed;
      const noneIndexed = messagesIndexed === 0 && unindexedMessages > 0;

      if (
        settingsUpdated ||
        messagesIndexBehind ||
        noneIndexed ||
        unindexedMessages > syncThreshold
      ) {
        if (noneIndexed && !settingsUpdated) {
          logger.info('[indexSync] No messages marked as indexed, forcing full sync');
        }
        logger.info(`[indexSync] Starting message sync (${unindexedMessages} unindexed)`);
        await Message.syncWithMeili();
        messagesSync = true;
      } else if (unindexedMessages > 0) {
        logger.info(
          `[indexSync] ${unindexedMessages} messages unindexed (below threshold: ${syncThreshold}, skipping)`,
        );
      }
    } else {
      logger.info(
        `[indexSync] Messages are fully synced: ${messageProgress.totalProcessed}/${messageProgress.totalDocuments}`,
      );
    }

    // Check if we need to sync conversations
    let convoProgress = await Conversation.getSyncProgress();
    // [knauf] Apply the same persisted-flag reconciliation to the conversations index.
    const convosInMeili = await getIndexDocumentCount(client.index('convos'));
    const convosIndexBehind = convosInMeili < convoProgress.totalProcessed;
    if (convosIndexBehind) {
      logger.warn(
        `[indexSync] Conversations index has ${convosInMeili} documents but Mongo marks ${convoProgress.totalProcessed} indexed. Forcing full re-sync.`,
      );
      await batchResetMeiliFlags(Conversation.collection);
      convoProgress = await Conversation.getSyncProgress();
    }
    // End [knauf]
    if (!convoProgress.isComplete || settingsUpdated || convosIndexBehind) {
      logger.info(
        `[indexSync] Conversations need syncing: ${convoProgress.totalProcessed}/${convoProgress.totalDocuments} indexed`,
      );

      const convoCount = convoProgress.totalDocuments;
      const convosIndexed = convoProgress.totalProcessed;
      const unindexedConvos = convoCount - convosIndexed;
      const noneConvosIndexed = convosIndexed === 0 && unindexedConvos > 0;

      if (
        settingsUpdated ||
        convosIndexBehind ||
        noneConvosIndexed ||
        unindexedConvos > syncThreshold
      ) {
        if (noneConvosIndexed && !settingsUpdated) {
          logger.info('[indexSync] No conversations marked as indexed, forcing full sync');
        }
        logger.info(`[indexSync] Starting convos sync (${unindexedConvos} unindexed)`);
        await Conversation.syncWithMeili();
        convosSync = true;
      } else if (unindexedConvos > 0) {
        logger.info(
          `[indexSync] ${unindexedConvos} convos unindexed (below threshold: ${syncThreshold}, skipping)`,
        );
      }
    } else {
      logger.info(
        `[indexSync] Conversations are fully synced: ${convoProgress.totalProcessed}/${convoProgress.totalDocuments}`,
      );
    }

    return { messagesSync, convosSync };
  } finally {
    if (indexingDisabled === true) {
      logger.info('[indexSync] Indexing is disabled, skipping cleanup...');
    } else if (flowManager && flowId && flowType) {
      try {
        await flowManager.deleteFlow(flowId, flowType);
        logger.debug('[indexSync] Flow state cleaned up');
      } catch (cleanupErr) {
        logger.debug('[indexSync] Could not clean up flow state:', cleanupErr.message);
      }
    }
  }
}

/**
 * Main index sync function that uses FlowStateManager to prevent concurrent execution
 */
async function runIndexSync() {
  logger.info('[indexSync] Starting index synchronization check...');

  // Get or create FlowStateManager instance
  const flowsCache = getLogStores(CacheKeys.FLOWS);
  if (!flowsCache) {
    logger.warn('[indexSync] Flows cache not available, falling back to direct sync');
    return await performSync(null, null, null);
  }

  const flowManager = new FlowStateManager(flowsCache, {
    ttl: 60000 * 10, // 10 minutes TTL for sync operations
  });

  // Use a unique flow ID for the sync operation
  const flowId = 'meili-index-sync';
  const flowType = 'MEILI_SYNC';

  try {
    // This will only execute the handler if no other instance is running the sync
    // [knauf] FlowStateManager owns completion; omit its context so upstream handler cleanup stays unreachable.
    const result = await flowManager.createFlowWithHandler(flowId, flowType, () => performSync());
    // End [knauf]

    if (result.messagesSync || result.convosSync) {
      logger.info('[indexSync] Sync completed successfully');
    } else {
      logger.debug('[indexSync] No sync was needed');
    }

    return result;
  } catch (err) {
    if (err.message.includes('flow already exists')) {
      logger.info('[indexSync] Sync already running on another instance');
      return;
    }

    // [knauf] Only provider-confirmed missing indexes may launch a full recovery sync.
    const isMissingIndex = err?.code === 'index_not_found';
    // End [knauf]
    if (isMissingIndex) {
      logger.debug('[indexSync] Creating indices...');
      // [knauf] Keep missing-index recovery inside the cross-replica operation lease.
      try {
        const Message = mongoose.models.Message;
        const Conversation = mongoose.models.Conversation;
        if (!Message || !Conversation) {
          throw new Error(
            '[indexSync] Models not registered. Ensure createModels() has been called before indexSync.',
          );
        }
        await Message.syncWithMeili();
        await Conversation.syncWithMeili();
      } catch (syncError) {
        logger.error('[indexSync] Trouble creating indices, try restarting the server.', syncError);
        throw syncError;
      }
      // End [knauf]
    } else if (err.message.includes('Meilisearch not configured')) {
      logger.info('[indexSync] Meilisearch not configured, search will be disabled.');
    } else {
      logger.error('[indexSync] error', err);
      throw err;
    }
  }
}

// [knauf] Hold one renewable Mongo lease for every destructive reconciliation phase.
async function indexSync() {
  if (!searchEnabled) {
    return;
  }

  return withMeiliSyncLock(mongoose, runIndexSync, { waitForLease: true });
}
// End [knauf]

// [knauf] Run a silent bounded preflight; the operation lease owns any required sync.
async function needsReconciliation() {
  const Message = mongoose.models.Message;
  const Conversation = mongoose.models.Conversation;
  if (!Message || !Conversation) {
    return false;
  }

  const client = MeiliSearchClient.getInstance();
  const [messageProgress, convoProgress, messagesInMeili, convosInMeili] = await Promise.all([
    Message.getSyncProgress(),
    Conversation.getSyncProgress(),
    getIndexDocumentCount(client.index('messages')),
    getIndexDocumentCount(client.index('convos')),
  ]);

  return (
    messagesInMeili < messageProgress.totalProcessed ||
    convosInMeili < convoProgress.totalProcessed ||
    messageProgress.totalDocuments - messageProgress.totalProcessed > syncThreshold ||
    convoProgress.totalDocuments - convoProgress.totalProcessed > syncThreshold
  );
}

indexSync.startReconciliation = () => {
  if (!searchEnabled || indexingDisabled || reconciliationInterval) {
    return;
  }
  reconciliationInterval = setInterval(async () => {
    try {
      await withMeiliSyncLock(mongoose, async () => {
        if (await needsReconciliation()) {
          await runIndexSync();
        }
      });
    } catch (error) {
      logger.warn('[indexSync] Periodic reconciliation check failed:', error.message);
    }
  }, reconciliationIntervalMs);
  reconciliationInterval.unref?.();
};

indexSync.stopReconciliation = () => {
  clearInterval(reconciliationInterval);
  reconciliationInterval = null;
};
// End [knauf]

process.on('exit', () => {
  // [knauf] Release the periodic reconciliation timer during shutdown.
  indexSync.stopReconciliation();
  // End [knauf]
});

module.exports = indexSync;
