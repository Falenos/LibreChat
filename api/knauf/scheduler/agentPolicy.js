'use strict';

const {
  PermissionBits,
  Permissions,
  PermissionTypes,
  ResourceType,
} = require('librechat-data-provider');

const SNAPSHOT_FIELDS = [
  'name',
  'description',
  'instructions',
  'provider',
  'model',
  'model_parameters',
  'artifacts',
  'recursion_limit',
  'tools',
  'skills',
  'skills_enabled',
  'tool_kwargs',
  'actions',
  'hide_sequential_outputs',
  'end_after_tools',
  'agent_ids',
  'edges',
  'conversation_starters',
  'tool_resources',
  'category',
  'support_contact',
  'mcpServerNames',
  'tool_options',
  'subagents',
  'spec',
];

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

function createAgentSnapshot(agent) {
  const snapshot = {
    id: agent.id,
    author: String(agent.author),
    version: Array.isArray(agent.versions) ? agent.versions.length : 0,
  };
  for (const field of SNAPSHOT_FIELDS) {
    if (agent[field] !== undefined) {
      snapshot[field] = cloneValue(agent[field]);
    }
  }
  if (
    typeof snapshot.artifacts === 'string' &&
    snapshot.artifacts !== '' &&
    !snapshot.tools?.includes('edit_artifact')
  ) {
    snapshot.tools = [...(snapshot.tools ?? []), 'edit_artifact'];
  }
  return snapshot;
}

async function resolveSchedulableAgent({
  agentId,
  user,
  getAgent,
  getRoleByName,
  checkPermission,
}) {
  const agent = await getAgent({ id: agentId });
  if (agent == null) {
    return null;
  }
  const role = await getRoleByName(user?.role);
  if (role?.permissions?.[PermissionTypes.AGENTS]?.[Permissions.USE] !== true) {
    return null;
  }
  const ownsAgent = String(agent.author) === String(user?.id);
  const mayEdit =
    ownsAgent ||
    (await checkPermission({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
      requiredPermission: PermissionBits.EDIT,
    }));
  return mayEdit ? { agent, snapshot: createAgentSnapshot(agent) } : null;
}

module.exports = { createAgentSnapshot, resolveSchedulableAgent };
