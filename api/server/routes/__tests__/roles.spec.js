const express = require('express');
const request = require('supertest');
const {
  SystemRoles,
  roleDefaults,
  PermissionTypes,
  Permissions,
} = require('librechat-data-provider');

const mockGetRoleByName = jest.fn();
const mockHasCapability = jest.fn();
const mockUpdateRoleByName = jest.fn();

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: (...args) => mockHasCapability(...args),
  requireCapability: () => (_req, _res, next) => next(),
}));

jest.mock('~/models', () => ({
  getRoleByName: (...args) => mockGetRoleByName(...args),
  updateRoleByName: (...args) => mockUpdateRoleByName(...args),
}));

const rolesRouter = require('../roles');

function createApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/roles', rolesRouter);
  return app;
}

const staffRole = {
  name: 'STAFF',
  permissions: {
    PROMPTS: { USE: true, CREATE: false },
  },
};

const userRole = roleDefaults[SystemRoles.USER];
const adminRole = roleDefaults[SystemRoles.ADMIN];

beforeEach(() => {
  jest.clearAllMocks();
  mockHasCapability.mockResolvedValue(false);
  mockGetRoleByName.mockResolvedValue(null);
  mockUpdateRoleByName.mockResolvedValue(null);
});

describe('GET /api/roles/:roleName — isOwnRole authorization', () => {
  it('allows a custom role user to fetch their own role', async () => {
    mockGetRoleByName.mockResolvedValue(staffRole);
    const app = createApp({ id: 'u1', role: 'STAFF' });

    const res = await request(app).get('/api/roles/STAFF');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('STAFF');
    expect(mockGetRoleByName).toHaveBeenCalledWith('STAFF', '-_id -__v');
  });

  it('returns 403 when a custom role user requests a different custom role', async () => {
    const app = createApp({ id: 'u1', role: 'STAFF' });

    const res = await request(app).get('/api/roles/MANAGER');

    expect(res.status).toBe(403);
    expect(mockGetRoleByName).not.toHaveBeenCalled();
  });

  it('returns 403 when a custom role user requests ADMIN', async () => {
    const app = createApp({ id: 'u1', role: 'STAFF' });

    const res = await request(app).get('/api/roles/ADMIN');

    expect(res.status).toBe(403);
    expect(mockGetRoleByName).not.toHaveBeenCalled();
  });

  it('allows USER to fetch the USER role (roleDefaults key)', async () => {
    mockGetRoleByName.mockResolvedValue(userRole);
    const app = createApp({ id: 'u1', role: SystemRoles.USER });

    const res = await request(app).get(`/api/roles/${SystemRoles.USER}`);

    expect(res.status).toBe(200);
  });

  it('returns 403 when USER requests the ADMIN role', async () => {
    const app = createApp({ id: 'u1', role: SystemRoles.USER });

    const res = await request(app).get(`/api/roles/${SystemRoles.ADMIN}`);

    expect(res.status).toBe(403);
  });

  it('allows ADMIN user to fetch their own ADMIN role via isOwnRole', async () => {
    mockHasCapability.mockResolvedValue(false);
    mockGetRoleByName.mockResolvedValue(adminRole);
    const app = createApp({ id: 'u1', role: SystemRoles.ADMIN });

    const res = await request(app).get(`/api/roles/${SystemRoles.ADMIN}`);

    expect(res.status).toBe(200);
  });

  it('allows any user with READ_ROLES capability to fetch any role', async () => {
    mockHasCapability.mockResolvedValue(true);
    mockGetRoleByName.mockResolvedValue(staffRole);
    const app = createApp({ id: 'u1', role: SystemRoles.USER });

    const res = await request(app).get('/api/roles/STAFF');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('STAFF');
  });

  it('returns 404 when the requested role does not exist', async () => {
    mockGetRoleByName.mockResolvedValue(null);
    const app = createApp({ id: 'u1', role: 'GHOST' });

    const res = await request(app).get('/api/roles/GHOST');

    expect(res.status).toBe(404);
  });

  it('returns 500 when getRoleByName throws', async () => {
    mockGetRoleByName.mockRejectedValue(new Error('db error'));
    const app = createApp({ id: 'u1', role: SystemRoles.USER });

    const res = await request(app).get(`/api/roles/${SystemRoles.USER}`);

    expect(res.status).toBe(500);
  });

  it('returns 403 for prototype property names like constructor (no prototype pollution)', async () => {
    const app = createApp({ id: 'u1', role: 'STAFF' });

    const res = await request(app).get('/api/roles/constructor');

    expect(res.status).toBe(403);
    expect(mockGetRoleByName).not.toHaveBeenCalled();
  });

  it('treats hasCapability failure as no capability (does not 500)', async () => {
    mockHasCapability.mockRejectedValue(new Error('capability check failed'));
    const app = createApp({ id: 'u1', role: 'STAFF' });
    mockGetRoleByName.mockResolvedValue(staffRole);

    const res = await request(app).get('/api/roles/STAFF');

    expect(res.status).toBe(200);
  });
});

// [knauf] Pin Admin UI ownership on the legacy prompt-permission route.
describe('PUT /api/roles/:roleName/prompts — Admin-managed permissions', () => {
  it('preserves the complete USER prompt-sharing choice from Admin', async () => {
    const previous = process.env.KNAUF_RESTRICT_USER_PERMISSIONS;
    process.env.KNAUF_RESTRICT_USER_PERMISSIONS = 'true';
    const role = {
      name: SystemRoles.USER,
      permissions: {
        [PermissionTypes.PROMPTS]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: false,
          [Permissions.SHARE]: false,
          [Permissions.SHARE_PUBLIC]: false,
        },
      },
    };
    mockGetRoleByName.mockResolvedValue(role);
    mockUpdateRoleByName.mockResolvedValue(role);

    try {
      const app = createApp({ id: 'admin', role: SystemRoles.ADMIN });
      const res = await request(app)
        .put(`/api/roles/${SystemRoles.USER}/prompts`)
        .send({
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
          [Permissions.SHARE]: true,
          [Permissions.SHARE_PUBLIC]: true,
        });

      expect(res.status).toBe(200);
      expect(mockUpdateRoleByName).toHaveBeenCalledWith(SystemRoles.USER, {
        permissions: {
          [PermissionTypes.PROMPTS]: {
            [Permissions.USE]: true,
            [Permissions.CREATE]: true,
            [Permissions.SHARE]: true,
            [Permissions.SHARE_PUBLIC]: true,
          },
        },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.KNAUF_RESTRICT_USER_PERMISSIONS;
      } else {
        process.env.KNAUF_RESTRICT_USER_PERMISSIONS = previous;
      }
    }
  });
});
// End [knauf]
