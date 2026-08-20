const mongoose = require('mongoose');
const { createMethods } = require('@librechat/data-schemas');
const { matchModelName, findMatchingPattern } = require('@librechat/api');
const getLogStores = require('~/cache/getLogStores');
const { ensureAgentBuilderRole } = require('~/knauf/roles/agentBuilderRole');

const methods = createMethods(mongoose, {
  matchModelName,
  findMatchingPattern,
  getCache: getLogStores,
});

const seedDatabase = async () => {
  await methods.initializeRoles();
  // [knauf] KK20-286 — keep the governed Agent Builder role schema-complete without overwriting Admin values.
  await ensureAgentBuilderRole({ Role: mongoose.models.Role, getCache: getLogStores });
  // End [knauf]
  await methods.seedDefaultRoles();
  await methods.ensureDefaultCategories();
  await methods.seedSystemGrants();
};

module.exports = {
  ...methods,
  seedDatabase,
};
