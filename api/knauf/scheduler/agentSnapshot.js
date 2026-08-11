'use strict';

function extractSchedulerAgentSnapshot(req) {
  const snapshot = req.body?.knaufAgentSnapshot;
  if (snapshot == null) {
    return;
  }
  delete req.body.knaufAgentSnapshot;
  if (typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    req.knaufSchedulerAgentSnapshot = snapshot;
  }
}

function getSchedulerAgentSnapshot(req, agentId) {
  const snapshot = req.knaufSchedulerAgentSnapshot;
  if (
    req.knaufSchedulerFire == null ||
    snapshot == null ||
    snapshot.id !== agentId ||
    typeof snapshot.provider !== 'string' ||
    typeof snapshot.model !== 'string'
  ) {
    return null;
  }
  return snapshot;
}

module.exports = { extractSchedulerAgentSnapshot, getSchedulerAgentSnapshot };
