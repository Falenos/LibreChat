// [knauf] KK20-195 review R6 — seam test: the mutating retry endpoint needs
// ownership or agent EDIT; a viewer of a shared agent (VIEW-only, exactly
// what fileAccess grants) is denied, and any check failure denies.
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/models', () => ({
  getAgents: jest.fn(),
}));
jest.mock('~/server/services/PermissionService', () => ({
  getEffectivePermissions: jest.fn(),
}));

const { PermissionBits } = require('librechat-data-provider');
const { getEffectivePermissions } = require('~/server/services/PermissionService');
const { getAgents } = require('~/models');
const { knaufFileIndexRetryAuth } = require('./knaufFileIndexRetryAuth');

const mockedGetAgents = getAgents;
const mockedPerms = getEffectivePermissions;

const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
const makeReq = (file) => ({
  user: { id: 'viewer-1', role: 'USER' },
  fileAccess: { file },
});

beforeEach(() => {
  jest.clearAllMocks();
});

test('the file owner may always retry', async () => {
  const res = makeRes();
  const next = jest.fn();
  await knaufFileIndexRetryAuth(makeReq({ file_id: 'f1', user: 'viewer-1' }), res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(mockedGetAgents).not.toHaveBeenCalled();
});

test('EDIT on an agent carrying the file allows the retry', async () => {
  mockedGetAgents.mockResolvedValue([{ _id: 'agent-oid', id: 'agent-1' }]);
  mockedPerms.mockResolvedValue(PermissionBits.VIEW | PermissionBits.EDIT);
  const res = makeRes();
  const next = jest.fn();

  await knaufFileIndexRetryAuth(makeReq({ file_id: 'f1', user: 'owner-9' }), res, next);

  expect(next).toHaveBeenCalledTimes(1);
});

test('a VIEWER of a shared agent is denied (403) — the exact fileAccess gap', async () => {
  mockedGetAgents.mockResolvedValue([{ _id: 'agent-oid', id: 'agent-1' }]);
  mockedPerms.mockResolvedValue(PermissionBits.VIEW);
  const res = makeRes();
  const next = jest.fn();

  await knaufFileIndexRetryAuth(makeReq({ file_id: 'f1', user: 'owner-9' }), res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: 'file_index_retry_forbidden' });
});

test('no agent carries the file → denied', async () => {
  mockedGetAgents.mockResolvedValue([]);
  const res = makeRes();
  const next = jest.fn();
  await knaufFileIndexRetryAuth(makeReq({ file_id: 'f1', user: 'owner-9' }), res, next);
  expect(res.status).toHaveBeenCalledWith(403);
});

test('a check failure denies — never passes through', async () => {
  mockedGetAgents.mockRejectedValue(new Error('mongo down'));
  const res = makeRes();
  const next = jest.fn();
  await knaufFileIndexRetryAuth(makeReq({ file_id: 'f1', user: 'owner-9' }), res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
});
// End [knauf]
