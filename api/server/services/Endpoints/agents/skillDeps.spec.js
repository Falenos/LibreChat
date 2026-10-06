const mockSaveBuffer = jest.fn();
const mockDeleteFile = jest.fn();
const mockGetStrategyFunctions = jest.fn();
const mockGetFileStrategy = jest.fn();
const mockGetStorageMetadata = jest.fn();
const mockResolveRequestTenantId = jest.fn();
const mockCreateDeploymentSkillMethods = jest.fn((methods) => methods);
// [knauf] KK20-243 — see the '@librechat/api' mock below.
const mockCheckAccessWithRequestCache = jest.fn();
// End [knauf]
// [knauf] KK20-397 — the skill-file cache freshness pair. `skillToolDeps` is built at
// module load, so the stand-in pair must exist before `require('./skillDeps')`.
const mockCacheGetSessionInfo = jest.fn();
const mockCacheCheckIfActive = jest.fn();
// A plain function, not jest.fn: the call happens at module load, before the per-test
// mock clearing, so its argument is recorded here instead of in `mock.calls`.
let mockCacheProbe;
const mockKnaufSkillCacheDeps = (probe) => {
  mockCacheProbe = probe;
  return { getSessionInfo: mockCacheGetSessionInfo, checkIfActive: mockCacheCheckIfActive };
};
// End [knauf]

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: (...args) => mockGetStrategyFunctions(...args),
}));

jest.mock('~/server/services/Files/Code/crud', () => ({
  batchUploadCodeEnvFiles: jest.fn(),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  getSessionInfo: jest.fn(),
  checkIfActive: jest.fn(),
  readSandboxFile: jest.fn(),
  writeSandboxFile: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  checkAccess: jest.fn(),
  // [knauf] KK20-243 — the SKILLS.USE gate (`canUseSkills`) uses the
  // request-cached checker. This mock is exhaustive, so omitting it leaves the
  // import `undefined` and the gate throws at call time rather than failing a
  // clear assertion.
  checkAccessWithRequestCache: (...args) => mockCheckAccessWithRequestCache(...args),
  // End [knauf]
  createDeploymentSkillMethods: (...args) => mockCreateDeploymentSkillMethods(...args),
  enrichWithSkillConfigurable: jest.fn(),
  getDeploymentSkillDownloadStream: jest.fn(),
  getStorageMetadata: (...args) => mockGetStorageMetadata(...args),
  isDeploymentSkillFileSource: jest.fn(() => false),
  mergeDeploymentSkillIds: jest.fn((ids = []) => ids),
  resolveRequestTenantId: (...args) => mockResolveRequestTenantId(...args),
  // [knauf] KK20-397 — exhaustive mock; see the declaration at the top.
  knaufSkillCacheDeps: (...args) => mockKnaufSkillCacheDeps(...args),
  // End [knauf]
}));

jest.mock('librechat-data-provider', () => ({
  AccessRoleIds: { SKILL_OWNER: 'SKILL_OWNER' },
  FileContext: { skill_file: 'skill_file' },
  PermissionBits: { EDIT: 2 },
  Permissions: { USE: 'USE', CREATE: 'CREATE' },
  PermissionTypes: { SKILLS: 'SKILLS' },
  PrincipalType: { USER: 'USER' },
  ResourceType: { SKILL: 'SKILL' },
  isEphemeralAgentId: jest.fn(() => false),
}));

jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: jest.fn(),
  grantPermission: jest.fn(),
}));

jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: (...args) => mockGetFileStrategy(...args),
}));

const mockDb = {
  getSkillFileByPath: jest.fn(),
  upsertSkillFile: jest.fn(),
};

jest.mock('~/models', () => mockDb);

const { getSkillToolDeps, canUseSkills } = require('./skillDeps');

/**
 * [knauf] KK20-397 — `checkIfActive` is imported from Files/Code/process.js, which stopped
 * exporting it in KK20-316; undefined, it silently disabled the skill-file cache. The
 * knauf pair must be built from the real `getSessionInfo` and must win over the dead key.
 */
describe('[knauf] skill-file cache freshness wiring', () => {
  it('builds the freshness pair from process.js getSessionInfo and lets it override', () => {
    const { getSessionInfo } = require('~/server/services/Files/Code/process');
    expect(mockCacheProbe).toBe(getSessionInfo);
    const deps = getSkillToolDeps();
    expect(deps.getSessionInfo).toBe(mockCacheGetSessionInfo);
    expect(deps.checkIfActive).toBe(mockCacheCheckIfActive);
  });
});

/**
 * [knauf] KK20-243 — the SKILLS.USE gate for the chat execution path.
 *
 * Upstream checked this permission only on the skills REST routes and inside
 * `canCreateSkill` (authoring). Nothing checked it while building a run, so a
 * role with `SKILLS.USE: false` still received the deployment-skill catalog and
 * could invoke `karl-brand` / `karl-artifacts` in a default KARL chat. The
 * missing AGENT_BUILDER Skills block that triggered KK20-286 proved this path
 * needs an independent runtime authorization check.
 */
describe('[knauf] canUseSkills', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('asks for exactly SKILLS.USE — not CREATE, which would be a different gate', async () => {
    mockCheckAccessWithRequestCache.mockResolvedValue(true);
    const req = { user: { id: 'user-1', role: 'USER' } };

    await expect(canUseSkills({ req })).resolves.toBe(true);
    expect(mockCheckAccessWithRequestCache).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        user: req.user,
        permissionType: 'SKILLS',
        permissions: ['USE'],
      }),
    );
  });

  it('returns false when the role denies SKILLS.USE', async () => {
    mockCheckAccessWithRequestCache.mockResolvedValue(false);
    await expect(canUseSkills({ req: { user: { id: 'u', role: 'AGENT_BUILDER' } } })).resolves.toBe(
      false,
    );
  });

  it('uses the request-cached checker, so a send does not add a role round trip', () => {
    // `canCreateSkill` reads the same role document in the same request; the
    // cached variant is what keeps this off the hot path.
    mockCheckAccessWithRequestCache.mockResolvedValue(true);
    canUseSkills({ req: { user: { id: 'u', role: 'USER' } } });
    expect(mockCheckAccessWithRequestCache).toHaveBeenCalledTimes(1);
  });
});

describe('skillDeps saveSkillFileContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFileStrategy.mockReturnValue('s3');
    mockGetStrategyFunctions.mockReturnValue({
      saveBuffer: mockSaveBuffer,
      deleteFile: mockDeleteFile,
    });
    mockSaveBuffer.mockResolvedValue('https://files.example.test/uploads/file.txt');
    mockDeleteFile.mockResolvedValue(undefined);
    mockGetStorageMetadata.mockReturnValue({
      storageKey: 'uploads/file.txt',
      storageRegion: 'us-east-2',
    });
    mockResolveRequestTenantId.mockReturnValue('tenant-1');
    mockDb.getSkillFileByPath.mockResolvedValue(null);
  });

  it('cleans up the uploaded object when metadata upsert returns no row', async () => {
    mockDb.upsertSkillFile.mockResolvedValue(null);

    await expect(
      getSkillToolDeps().saveSkillFileContent({
        req: {
          user: { id: 'user-1', _id: 'user-1' },
          config: {},
        },
        skillId: 'skill-1',
        relativePath: 'references/template.html',
        content: '<html></html>',
        mimeType: 'text/html',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_UPSERT_NOT_FOUND' });

    expect(mockDeleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }),
      {
        filepath: 'https://files.example.test/uploads/file.txt',
        user: 'user-1',
        tenantId: 'tenant-1',
      },
    );
  });
});
