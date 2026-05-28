const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  logAgentMigrationWarning,
  logPromptMigrationWarning,
  checkAgentPermissionsMigration,
  checkPromptPermissionsMigration,
} = require('@librechat/api');
const { findRoleByIdentifier } = require('~/models');
// [knauf] KK20-123 — one-time migration from the deprecated
// `interface.knauf.defaultAgentId` yaml field to the per-agent `isDefault`
// flag. See migrateKnaufDefaultAgent below.
const loadCustomConfig = require('~/server/services/Config/loadCustomConfig');
// End [knauf]

// [knauf] KK20-123 — one-shot migration that seeds the per-agent `isDefault`
// flag from `librechat.yaml`'s deprecated `interface.knauf.defaultAgentId`.
// Idempotent: if any agent already has `isDefault: true`, this is a no-op.
// Once an admin has set the default via the UI toggle, the YAML value is
// permanently ignored. Logs once on the run where it actually migrates.
async function migrateKnaufDefaultAgent() {
  try {
    const AgentModel = mongoose.models.Agent;
    if (!AgentModel) return;

    const existing = await AgentModel.findOne({ isDefault: true }).select({ id: 1 }).lean();
    if (existing) return;

    const config = await loadCustomConfig();
    const yamlDefaultId = config?.interface?.knauf?.defaultAgentId;
    if (!yamlDefaultId || typeof yamlDefaultId !== 'string') return;

    const target = await AgentModel.findOne({ id: yamlDefaultId }).select({ id: 1 }).lean();
    if (!target) {
      logger.warn(
        `[knauf:KK20-123] interface.knauf.defaultAgentId points at "${yamlDefaultId}" but no matching agent exists — skipping default-agent migration.`,
      );
      return;
    }

    await AgentModel.updateOne({ id: yamlDefaultId }, { $set: { isDefault: true } });
    logger.info(
      `[knauf:KK20-123] Migrated deprecated interface.knauf.defaultAgentId ("${yamlDefaultId}") to per-agent isDefault flag. The yaml value is now ignored at runtime; manage the default via the agent builder's "Set as default" toggle.`,
    );
  } catch (error) {
    logger.error('[knauf:KK20-123] Failed to migrate default-agent yaml flag:', error);
  }
}
// End [knauf]

/**
 * Check if permissions migrations are needed for shared resources
 * This runs at the end to ensure all systems are initialized
 */
async function checkMigrations() {
  try {
    const agentMigrationResult = await checkAgentPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      AgentModel: mongoose.models.Agent,
    });
    logAgentMigrationWarning(agentMigrationResult);
  } catch (error) {
    logger.error('Failed to check agent permissions migration:', error);
  }
  try {
    const promptMigrationResult = await checkPromptPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      PromptGroupModel: mongoose.models.PromptGroup,
    });
    logPromptMigrationWarning(promptMigrationResult);
  } catch (error) {
    logger.error('Failed to check prompt permissions migration:', error);
  }
  // [knauf] KK20-123 — seed isDefault from yaml on first run after upgrade.
  await migrateKnaufDefaultAgent();
  // End [knauf]
}

module.exports = {
  checkMigrations,
};
