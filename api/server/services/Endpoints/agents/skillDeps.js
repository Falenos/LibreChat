const crypto = require('crypto');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { batchUploadCodeEnvFiles } = require('~/server/services/Files/Code/crud');
const {
  getSessionInfo,
  checkIfActive,
  readSandboxFile,
  writeSandboxFile,
} = require('~/server/services/Files/Code/process');
const {
  checkAccess,
  // [knauf] KK20-243 — request-cached variant for the per-run SKILLS.USE gate;
  // see `canUseSkills`. The plain `checkAccess` below stays for `canCreateSkill`.
  checkAccessWithRequestCache,
  // End [knauf]
  getStorageMetadata,
  resolveRequestTenantId,
  enrichWithSkillConfigurable,
  mergeDeploymentSkillIds,
  createDeploymentSkillMethods,
  isDeploymentSkillFileSource,
  getDeploymentSkillDownloadStream,
} = require('@librechat/api');
const {
  Permissions,
  FileContext,
  ResourceType,
  PermissionBits,
  AccessRoleIds,
  PrincipalType,
  PermissionTypes,
  isEphemeralAgentId,
} = require('librechat-data-provider');
const { checkPermission, grantPermission } = require('~/server/services/PermissionService');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const db = require('~/models');

const deploymentSkillMethods = createDeploymentSkillMethods({
  getSkillById: db.getSkillById,
  getSkillByName: db.getSkillByName,
  listSkillsByAccess: db.listSkillsByAccess,
  listAlwaysApplySkills: db.listAlwaysApplySkills,
  listSkillFiles: db.listSkillFiles,
  getSkillFileByPath: db.getSkillFileByPath,
  updateSkillFileContent: db.updateSkillFileContent,
  updateSkillFileCodeEnvIds: db.updateSkillFileCodeEnvIds,
});

function getSkillDbMethods() {
  return deploymentSkillMethods;
}

function withDeploymentSkillIds(ids = []) {
  return mergeDeploymentSkillIds(ids);
}

function getSkillStrategyFunctions(source) {
  if (isDeploymentSkillFileSource(source)) {
    return {
      getDownloadStream: (_req, filepath) => getDeploymentSkillDownloadStream(filepath),
    };
  }
  return getStrategyFunctions(source);
}

function resolveSkillStorage(req, { isImage = false } = {}) {
  const source = getFileStrategy(req.config, { context: FileContext.skill_file, isImage });
  const strategy = getStrategyFunctions(source);
  if (!strategy.saveBuffer) {
    throw new Error(`Storage backend "${source}" does not support file writes`);
  }
  return { saveBuffer: strategy.saveBuffer, source };
}

function basename(relativePath) {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1 ? relativePath : relativePath.slice(slash + 1);
}

async function saveSkillFileContent({ req, skillId, relativePath, content, mimeType }) {
  const existingFile = await db.getSkillFileByPath(skillId, relativePath);
  const tenantId = resolveRequestTenantId(req);
  const fileId = crypto.randomUUID();
  const filename = basename(relativePath);
  const storageFileName = `${fileId}__${filename}`;
  const buffer = Buffer.from(content, 'utf8');
  const storage = resolveSkillStorage(req, { isImage: mimeType.startsWith('image/') });
  const filepath = await storage.saveBuffer({
    userId: req.user.id,
    buffer,
    fileName: storageFileName,
    basePath: 'uploads',
    tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source: storage.source });

  let result;
  try {
    result = await db.upsertSkillFile({
      skillId,
      relativePath,
      file_id: fileId,
      filename,
      filepath,
      ...storageMetadata,
      source: storage.source,
      mimeType,
      bytes: buffer.length,
      isExecutable: false,
      author: req.user._id ?? req.user.id,
      tenantId,
    });
    if (!result) {
      const error = new Error('Skill file save failed to persist metadata');
      error.code = 'SKILL_FILE_UPSERT_NOT_FOUND';
      throw error;
    }
  } catch (error) {
    const { deleteFile } = getStrategyFunctions(storage.source);
    if (deleteFile) {
      await deleteFile(req, { filepath, user: req.user.id, tenantId }).catch(() => undefined);
    }
    throw error;
  }

  if (existingFile && existingFile.filepath !== filepath) {
    const { deleteFile } = getStrategyFunctions(existingFile.source);
    if (deleteFile) {
      deleteFile(req, {
        filepath: existingFile.filepath,
        storageKey: existingFile.storageKey,
        storageRegion: existingFile.storageRegion,
        user: existingFile.author ?? req.user.id,
        tenantId: existingFile.tenantId ?? tenantId,
      }).catch(() => undefined);
    }
  }

  return { bytes: result.bytes, relativePath: result.relativePath };
}

function canCreateSkill({ req }) {
  return checkAccess({
    req,
    user: req.user,
    permissionType: PermissionTypes.SKILLS,
    permissions: [Permissions.USE, Permissions.CREATE],
    getRoleByName: db.getRoleByName,
  });
}

// [knauf] KK20-243 — SKILLS.USE gate for the chat execution path.
/**
 * The SKILLS.USE role permission, checked while building a run.
 *
 * Upstream enforces `SKILLS.USE` only on the skills REST surface
 * (`api/server/routes/skills.js`, via `checkSkillAccess`) and inside
 * `canCreateSkill`, which gates authoring. Nothing checked it while building a
 * run: `accessibleSkillIds` came from `findAccessibleResources` — resource ACLs,
 * a different axis entirely — and `mergeDeploymentSkillIds` then appends every
 * deployment skill id unconditionally, by design, since deployment skills carry
 * no ACL rows. The result was that a role with `SKILLS.USE: false` still
 * received the deployment catalog and could invoke `karl-brand` /
 * `karl-artifacts` in a default KARL chat.
 *
 * That mattered concretely rather than theoretically: AGENT_BUILDER has
 * `SKILLS.USE: false` until a human runs `knauf/scripts/seed-agent-builder-role.js`,
 * so the window between deploying the image and running mongosh granted exactly
 * what the seed script exists to grant. It also made the "three gates" claim in
 * `librechat.yaml` and the rollout plan untrue, and left us no way to deny skills
 * to a role later.
 *
 * Fails closed: `checkAccessWithRequestCache` returns `false` for a missing user,
 * a missing role document, or an absent permission block — it never throws.
 *
 * Cached per request because both agent init paths call this once per run and
 * `canCreateSkill` hits the same role document; without the cache this would add
 * a `getRoleByName` round trip to every send.
 */
function canUseSkills({ req }) {
  return checkAccessWithRequestCache({
    req,
    user: req.user,
    permissionType: PermissionTypes.SKILLS,
    permissions: [Permissions.USE],
    getRoleByName: db.getRoleByName,
  });
}
// End [knauf]

function canEditSkill({ req, skillId }) {
  return checkPermission({
    userId: req.user.id,
    role: req.user.role,
    resourceType: ResourceType.SKILL,
    resourceId: skillId,
    requiredPermission: PermissionBits.EDIT,
  });
}

function isAgentSkillsEnabledForRun({ agent, skillsCapabilityEnabled, ephemeralSkillsToggle }) {
  if (!skillsCapabilityEnabled) {
    return false;
  }
  if (isEphemeralAgentId(agent.id)) {
    if (agent.skills_enabled === false) {
      return false;
    }
    if (agent.skills_enabled === true) {
      return true;
    }
    return ephemeralSkillsToggle === true;
  }
  return agent.skills_enabled === true;
}

function canAuthorSkillFiles({
  agent,
  scopedEditableSkillIds = [],
  skillCreateAllowed,
  skillsCapabilityEnabled,
  ephemeralSkillsToggle,
}) {
  return (
    isAgentSkillsEnabledForRun({ agent, skillsCapabilityEnabled, ephemeralSkillsToggle }) &&
    (scopedEditableSkillIds.length > 0 || skillCreateAllowed === true)
  );
}

function grantSkillOwner({ req, skillId }) {
  return grantPermission({
    principalType: PrincipalType.USER,
    principalId: req.user.id,
    resourceType: ResourceType.SKILL,
    resourceId: skillId,
    accessRoleId: AccessRoleIds.SKILL_OWNER,
    grantedBy: req.user.id,
  });
}

function getAuthorSkillByName({ req, name }) {
  const author = req.user?._id ?? req.user?.id;
  if (!author) {
    return null;
  }
  return db.getAuthorSkillByName({
    name,
    author,
    tenantId: resolveRequestTenantId(req),
  });
}

/**
 * Builds the `skillPrimedIdsByName` map threaded through
 * `buildAgentToolContext`. Centralized here so every runtime route shares
 * one source of truth — if `ResolvedManualSkill` ever renames `_id` or
 * gains new identifying fields, only this helper changes.
 *
 * Combines both manual (`$`-popover) primes AND always-apply primes so
 * `read_file` can:
 *  - Relax the `disable-model-invocation: true` gate for either source
 *    (the body is already in context; blocking its own files would be
 *    nonsensical).
 *  - Pin same-name collision lookups to the exact `_id` the resolver
 *    primed (otherwise a newer same-name duplicate could shadow the
 *    body/file pair within a single turn).
 *
 * On the rare overlap (a name appears in both arrays because upstream
 * dedup was skipped), manual wins — manual invocation is explicit user
 * intent and carries the authoritative `_id` for this turn.
 *
 * Returns `undefined` (not `{}`) when both arrays are empty, so the
 * downstream `enrichWithSkillConfigurable` cleanly omits the field from
 * `mergedConfigurable` rather than threading an empty object.
 *
 * @param {Array<{ name: string, _id: { toString(): string } }> | undefined} manualSkillPrimes
 * @param {Array<{ name: string, _id: { toString(): string } }> | undefined} alwaysApplySkillPrimes
 * @returns {Record<string, string> | undefined}
 */
function buildSkillPrimedIdsByName(manualSkillPrimes, alwaysApplySkillPrimes) {
  const manualCount = manualSkillPrimes?.length ?? 0;
  const alwaysApplyCount = alwaysApplySkillPrimes?.length ?? 0;
  if (manualCount === 0 && alwaysApplyCount === 0) {
    return undefined;
  }
  const out = {};
  /* Order matters on the edge case where the same name appears in both
     lists: always-apply goes in first, then manual overwrites — manual
     wins because it's explicit user intent for this turn. */
  if (alwaysApplyCount > 0) {
    for (const p of alwaysApplySkillPrimes) {
      out[p.name] = p._id.toString();
    }
  }
  if (manualCount > 0) {
    for (const p of manualSkillPrimes) {
      out[p.name] = p._id.toString();
    }
  }
  return out;
}

/**
 * Builds the per-agent context consumed by ON_TOOL_EXECUTE. Keeping this
 * shape in one Adapter gives every runtime path the same configurable
 * fields and the same primed-skill pinning behavior.
 *
 * @param {object} params
 * @param {object} params.agent
 * @param {object} params.config
 * @param {Record<string, import('@librechat/api').LCAvailableTools>} [params.config.mcpAvailableTools]
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.config.requestScopedConnections]
 * @returns {object}
 */
function buildAgentToolContext({ agent, config }) {
  return {
    agent,
    /** Per-agent resolved endpoint token/pricing config. Retained here because
     *  `agentToolContexts` is the one map that holds every agent — including
     *  pure subagents pruned from `agentConfigs` — so usage can be priced with
     *  the producing agent's config in multi-endpoint graphs. */
    endpointTokenConfig: config.endpointTokenConfig,
    toolRegistry: config.toolRegistry,
    mcpAvailableTools: config.mcpAvailableTools,
    requestScopedConnections: config.requestScopedConnections,
    userMCPAuthMap: config.userMCPAuthMap,
    tool_resources: config.tool_resources,
    actionsEnabled: config.actionsEnabled,
    accessibleSkillIds: config.accessibleSkillIds,
    activeSkillNames: config.activeSkillNames,
    codeEnvAvailable: config.codeEnvAvailable,
    skillAuthoringAvailable: config.skillAuthoringAvailable,
    fileAuthoringToolNames: config.fileAuthoringToolNames,
    skillPrimedIdsByName:
      buildSkillPrimedIdsByName(config.manualSkillPrimes, config.alwaysApplySkillPrimes) ?? {},
  };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

/**
 * Applies per-agent runtime context to a loadToolsForExecution result.
 *
 * @param {object} params
 * @param {{ loadedTools: unknown[], configurable?: Record<string, unknown> }} params.result
 * @param {object} params.req
 * @param {object | undefined} params.ctx
 * @param {object | undefined} [params.fallback]
 * @returns {{ loadedTools: unknown[], configurable: Record<string, unknown> }}
 */
function enrichLoadedToolsWithAgentContext({ result, req, ctx = {}, fallback = {} }) {
  const codeEnvAvailable = hasOwn(ctx, 'codeEnvAvailable')
    ? ctx.codeEnvAvailable === true
    : fallback.codeEnvAvailable === true;
  const skillAuthoringAvailable = hasOwn(ctx, 'skillAuthoringAvailable')
    ? ctx.skillAuthoringAvailable === true
    : fallback.skillAuthoringAvailable === true;

  return enrichWithSkillConfigurable({
    result,
    context: {
      req,
      codeEnvAvailable,
      accessibleSkillIds: ctx.accessibleSkillIds ?? fallback.accessibleSkillIds,
      skillPrimedIdsByName: ctx.skillPrimedIdsByName ?? fallback.skillPrimedIdsByName,
      activeSkillNames: ctx.activeSkillNames ?? fallback.activeSkillNames,
      skillAuthoringAvailable,
      fileAuthoringToolNames: ctx.fileAuthoringToolNames ?? fallback.fileAuthoringToolNames,
    },
  });
}

/** Skill-related properties for ToolExecuteOptions (stable references, allocated once). */
const skillToolDeps = {
  getSkillByName: deploymentSkillMethods.getSkillByName,
  getAuthorSkillByName,
  createSkill: db.createSkill,
  updateSkill: db.updateSkill,
  deleteSkill: db.deleteSkill,
  canCreateSkill,
  canEditSkill,
  grantSkillOwner,
  saveSkillFileContent,
  listSkillFiles: deploymentSkillMethods.listSkillFiles,
  getStrategyFunctions: getSkillStrategyFunctions,
  batchUploadCodeEnvFiles,
  getSessionInfo,
  checkIfActive,
  updateSkillFileCodeEnvIds: deploymentSkillMethods.updateSkillFileCodeEnvIds,
  getSkillFileByPath: deploymentSkillMethods.getSkillFileByPath,
  updateSkillFileContent: deploymentSkillMethods.updateSkillFileContent,
  /**
   * `read_file` falls back to a sandbox `cat` for `/mnt/data/...` paths
   * and for `{firstSegment}/...` paths whose first segment isn't a known
   * skill name. The handler routes through this when the agent has code
   * execution enabled; the codeapi base URL comes from
   * `LIBRECHAT_CODE_BASEURL` and the sandbox session id is forwarded by
   * the agents-side `ToolNode` via `tc.codeSessionContext`.
   */
  readSandboxFile,
  writeSandboxFile,
};

function getSkillToolDeps() {
  return skillToolDeps;
}

module.exports = {
  getSkillToolDeps,
  // [knauf] KK20-243 — exported so BOTH agent-init paths gate on it. See the
  // SEAMS rows: initialize.js and controllers/agents/openai.js carry duplicate
  // scope-resolution blocks upstream, and an upstream merge that touches one
  // must not silently drop the gate from the other.
  canUseSkills,
  // End [knauf]
  canAuthorSkillFiles,
  isAgentSkillsEnabledForRun,
  getSkillDbMethods,
  withDeploymentSkillIds,
  getSkillStrategyFunctions,
  enrichWithSkillConfigurable,
  buildSkillPrimedIdsByName,
  buildAgentToolContext,
  enrichLoadedToolsWithAgentContext,
};
