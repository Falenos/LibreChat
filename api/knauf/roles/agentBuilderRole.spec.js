const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const { Permissions, PermissionTypes, SystemRoles } = require('librechat-data-provider');
const {
  AGENT_BUILDER_ROLE,
  AGENT_BUILDER_DESCRIPTION,
  AGENT_BUILDER_PERMISSIONS,
  ensureAgentBuilderRole,
  getPermissionSchemaPaths,
  isAgentBuilderRole,
  permissionEntries,
} = require('./agentBuilderRole');

describe('ensureAgentBuilderRole', () => {
  let mongoServer;
  let Role;
  const cache = { set: jest.fn() };
  const getCache = jest.fn(() => cache);
  const roleLogger = { info: jest.fn() };

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    Role = mongoose.models.Role;
    await Role.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Role.deleteMany({});
    jest.clearAllMocks();
  });

  it('creates one complete base role with the intended Skills access', async () => {
    const result = await ensureAgentBuilderRole({ Role, getCache, roleLogger });

    expect(result.created).toBe(true);
    expect(await Role.countDocuments({ name: AGENT_BUILDER_ROLE })).toBe(1);
    expect(result.role).toMatchObject({
      name: AGENT_BUILDER_ROLE,
      description: AGENT_BUILDER_DESCRIPTION,
      permissions: AGENT_BUILDER_PERMISSIONS,
    });
    expect(result.role.permissions[PermissionTypes.SKILLS]).toEqual({
      [Permissions.USE]: true,
      [Permissions.CREATE]: false,
      [Permissions.SHARE]: false,
      [Permissions.SHARE_PUBLIC]: false,
    });
    expect(cache.set).toHaveBeenCalledWith(AGENT_BUILDER_ROLE, null);
  });

  it('adds only missing permission types and bits', async () => {
    await Role.create({
      name: AGENT_BUILDER_ROLE,
      permissions: {
        [PermissionTypes.SKILLS]: {
          [Permissions.CREATE]: false,
          [Permissions.SHARE]: false,
          [Permissions.SHARE_PUBLIC]: false,
        },
        [PermissionTypes.MCP_SERVERS]: {
          [Permissions.USE]: false,
          [Permissions.CREATE]: false,
          [Permissions.SHARE]: false,
          [Permissions.SHARE_PUBLIC]: false,
        },
      },
    });

    const result = await ensureAgentBuilderRole({ Role, getCache, roleLogger });

    expect(result.addedPaths).toEqual(
      expect.arrayContaining([
        'permissions.SKILLS.USE',
        'permissions.MCP_SERVERS.CONFIGURE_OBO',
        'permissions.AGENTS.USE',
      ]),
    );
    expect(result.role.permissions[PermissionTypes.SKILLS][Permissions.USE]).toBe(true);
    expect(result.role.permissions[PermissionTypes.MCP_SERVERS][Permissions.CONFIGURE_OBO]).toBe(
      false,
    );
  });

  it('preserves explicit values, description, and unrelated Admin choices', async () => {
    await Role.create({
      name: AGENT_BUILDER_ROLE,
      description: 'Admin-owned description',
      permissions: {
        [PermissionTypes.SKILLS]: {
          [Permissions.USE]: false,
          [Permissions.CREATE]: true,
        },
        [PermissionTypes.PROMPTS]: {
          [Permissions.USE]: false,
          [Permissions.CREATE]: false,
          [Permissions.SHARE]: false,
          [Permissions.SHARE_PUBLIC]: true,
        },
        [PermissionTypes.PEOPLE_PICKER]: {
          [Permissions.VIEW_USERS]: false,
          [Permissions.VIEW_GROUPS]: true,
          [Permissions.VIEW_ROLES]: true,
        },
      },
    });

    const { role } = await ensureAgentBuilderRole({ Role, getCache, roleLogger });

    expect(role.description).toBe('Admin-owned description');
    expect(role.permissions[PermissionTypes.SKILLS][Permissions.USE]).toBe(false);
    expect(role.permissions[PermissionTypes.SKILLS][Permissions.CREATE]).toBe(true);
    expect(role.permissions[PermissionTypes.PROMPTS]).toEqual({
      [Permissions.USE]: false,
      [Permissions.CREATE]: false,
      [Permissions.SHARE]: false,
      [Permissions.SHARE_PUBLIC]: true,
    });
    expect(role.permissions[PermissionTypes.PEOPLE_PICKER]).toEqual({
      [Permissions.VIEW_USERS]: false,
      [Permissions.VIEW_GROUPS]: true,
      [Permissions.VIEW_ROLES]: true,
    });
  });

  it('is safe under concurrent startup calls', async () => {
    await Promise.all([
      ensureAgentBuilderRole({ Role, getCache, roleLogger }),
      ensureAgentBuilderRole({ Role, getCache, roleLogger }),
    ]);

    const roles = await Role.find({ name: AGENT_BUILDER_ROLE }).lean();
    expect(roles).toHaveLength(1);
    for (const { path } of permissionEntries()) {
      const value = path.split('.').reduce((current, segment) => current?.[segment], roles[0]);
      expect(value).not.toBeUndefined();
    }
  });

  it('does not invalidate cache or touch tenant-scoped copies on a no-op run', async () => {
    await Role.create([
      {
        name: AGENT_BUILDER_ROLE,
        description: AGENT_BUILDER_DESCRIPTION,
        permissions: AGENT_BUILDER_PERMISSIONS,
      },
      {
        name: AGENT_BUILDER_ROLE,
        tenantId: 'tenant-1',
        description: 'Tenant-owned role',
        permissions: { [PermissionTypes.SKILLS]: { [Permissions.USE]: false } },
      },
    ]);

    const result = await ensureAgentBuilderRole({ Role, getCache, roleLogger });
    const tenantRole = await Role.findOne({
      name: AGENT_BUILDER_ROLE,
      tenantId: 'tenant-1',
    }).lean();

    expect(result.created).toBe(false);
    expect(result.addedPaths).toEqual([]);
    expect(cache.set).not.toHaveBeenCalled();
    expect(tenantRole.description).toBe('Tenant-owned role');
    expect(tenantRole.permissions[PermissionTypes.SKILLS]).toEqual({ [Permissions.USE]: false });
  });

  it('covers every permission bit in the current LibreChat schema', () => {
    expect(
      permissionEntries()
        .map(({ path }) => path)
        .sort(),
    ).toEqual(getPermissionSchemaPaths().sort());
  });

  it('remains a normal custom role name', () => {
    expect(isAgentBuilderRole('agent_builder')).toBe(true);
    expect(isAgentBuilderRole('USER')).toBe(false);
    expect(Object.values(SystemRoles)).not.toContain(AGENT_BUILDER_ROLE);
  });
});
