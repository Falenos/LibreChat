const {
  CacheKeys,
  Permissions,
  PermissionTypes,
  permissionsSchema,
} = require('librechat-data-provider');
const { logger, runAsSystem, scopedCacheKey } = require('@librechat/data-schemas');

const AGENT_BUILDER_ROLE = 'AGENT_BUILDER';
const AGENT_BUILDER_DESCRIPTION =
  'AI Champions - can create private agents and use approved sharing features. No agent publishing or admin panel access.';

const AGENT_BUILDER_PERMISSIONS = {
  [PermissionTypes.PROMPTS]: {
    [Permissions.USE]: true,
    [Permissions.CREATE]: true,
    [Permissions.SHARE]: true,
    [Permissions.SHARE_PUBLIC]: false,
  },
  [PermissionTypes.BOOKMARKS]: {
    [Permissions.USE]: true,
  },
  [PermissionTypes.MEMORIES]: {
    [Permissions.USE]: false,
    [Permissions.CREATE]: false,
    [Permissions.UPDATE]: false,
    [Permissions.READ]: false,
    [Permissions.OPT_OUT]: false,
  },
  [PermissionTypes.AGENTS]: {
    [Permissions.USE]: true,
    [Permissions.CREATE]: true,
    [Permissions.SHARE]: false,
    [Permissions.SHARE_PUBLIC]: false,
  },
  [PermissionTypes.MULTI_CONVO]: {
    [Permissions.USE]: true,
  },
  [PermissionTypes.TEMPORARY_CHAT]: {
    [Permissions.USE]: true,
  },
  [PermissionTypes.RUN_CODE]: {
    [Permissions.USE]: false,
  },
  [PermissionTypes.WEB_SEARCH]: {
    [Permissions.USE]: true,
  },
  [PermissionTypes.PEOPLE_PICKER]: {
    [Permissions.VIEW_USERS]: true,
    [Permissions.VIEW_GROUPS]: false,
    [Permissions.VIEW_ROLES]: false,
  },
  [PermissionTypes.MARKETPLACE]: {
    [Permissions.USE]: true,
  },
  [PermissionTypes.FILE_SEARCH]: {
    [Permissions.USE]: true,
  },
  [PermissionTypes.FILE_CITATIONS]: {
    [Permissions.USE]: true,
  },
  [PermissionTypes.MCP_SERVERS]: {
    [Permissions.USE]: false,
    [Permissions.CREATE]: false,
    [Permissions.SHARE]: false,
    [Permissions.SHARE_PUBLIC]: false,
    [Permissions.CONFIGURE_OBO]: false,
  },
  [PermissionTypes.REMOTE_AGENTS]: {
    [Permissions.USE]: false,
    [Permissions.CREATE]: false,
    [Permissions.SHARE]: false,
    [Permissions.SHARE_PUBLIC]: false,
  },
  [PermissionTypes.SKILLS]: {
    [Permissions.USE]: true,
    [Permissions.CREATE]: false,
    [Permissions.SHARE]: false,
    [Permissions.SHARE_PUBLIC]: false,
  },
  [PermissionTypes.SHARED_LINKS]: {
    [Permissions.CREATE]: true,
    [Permissions.SHARE]: true,
    [Permissions.SHARE_PUBLIC]: true,
  },
};

function isAgentBuilderRole(name) {
  return typeof name === 'string' && name.toUpperCase() === AGENT_BUILDER_ROLE;
}

function permissionEntries() {
  return Object.entries(AGENT_BUILDER_PERMISSIONS).flatMap(([permissionType, values]) =>
    Object.entries(values).map(([permission, value]) => ({
      path: `permissions.${permissionType}.${permission}`,
      value,
    })),
  );
}

function getPath(value, path) {
  return path.split('.').reduce((current, segment) => current?.[segment], value);
}

async function ensureAgentBuilderRole({ Role, getCache, roleLogger = logger }) {
  if (!Role) {
    throw new Error('Role model is required');
  }

  return await runAsSystem(async () => {
    const baseRoleFilter = { name: AGENT_BUILDER_ROLE, tenantId: null };
    const createResult = await Role.updateOne(
      baseRoleFilter,
      {
        $setOnInsert: {
          name: AGENT_BUILDER_ROLE,
          description: AGENT_BUILDER_DESCRIPTION,
          permissions: AGENT_BUILDER_PERMISSIONS,
        },
      },
      { upsert: true },
    ).exec();

    const addedPaths = [];
    for (const { path, value } of permissionEntries()) {
      const result = await Role.updateOne(
        { ...baseRoleFilter, [path]: { $exists: false } },
        { $set: { [path]: value } },
      ).exec();
      if (result.modifiedCount > 0) {
        addedPaths.push(path);
      }
    }

    const created = createResult.upsertedCount > 0;
    if (created || addedPaths.length > 0) {
      const cache = getCache?.(CacheKeys.ROLES);
      if (cache) {
        await cache.set(scopedCacheKey(AGENT_BUILDER_ROLE), null);
      }
      roleLogger.info(
        `[agentBuilderRole] ${created ? 'created role' : `added ${addedPaths.join(', ')}`}`,
      );
    }

    const role = await Role.findOne(baseRoleFilter).lean().exec();
    if (!role) {
      throw new Error(`Failed to initialize ${AGENT_BUILDER_ROLE}`);
    }

    const missingPaths = permissionEntries()
      .map(({ path }) => path)
      .filter((path) => getPath(role, path) === undefined);
    if (missingPaths.length > 0) {
      throw new Error(
        `${AGENT_BUILDER_ROLE} is missing permission paths: ${missingPaths.join(', ')}`,
      );
    }

    return { role, created, addedPaths };
  });
}

function getPermissionSchemaPaths() {
  return Object.entries(permissionsSchema.shape).flatMap(([permissionType, schema]) =>
    Object.keys(schema.shape).map((permission) => `permissions.${permissionType}.${permission}`),
  );
}

module.exports = {
  AGENT_BUILDER_ROLE,
  AGENT_BUILDER_DESCRIPTION,
  AGENT_BUILDER_PERMISSIONS,
  ensureAgentBuilderRole,
  getPermissionSchemaPaths,
  isAgentBuilderRole,
  permissionEntries,
};
