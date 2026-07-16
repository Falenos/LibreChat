// [knauf] KK20-195 WP3c — seam test: the chat-send readiness gate 409s an
// explicit selection of a non-ready file BEFORE the SSE stream starts, trusts
// only owner-scoped server state (never the client payload), and fails open
// (enforcement must not take chat down).
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('~/models', () => ({
  getFiles: jest.fn(),
  getAssetsByAssetIds: jest.fn(),
}));

const { getFiles, getAssetsByAssetIds } = require('~/models');
const { knaufFileIndexReadiness } = require('./knaufFileIndexReadiness');

const makeRes = () => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return res;
};
const makeReq = (files) => ({ user: { id: 'u1' }, body: { files } });

beforeEach(() => {
  jest.clearAllMocks();
});

test('no files on the request → next()', async () => {
  const res = makeRes();
  const next = jest.fn();
  await knaufFileIndexReadiness(makeReq(undefined), res, next);
  await knaufFileIndexReadiness(makeReq([]), res, next);
  expect(next).toHaveBeenCalledTimes(2);
  expect(getFiles).not.toHaveBeenCalled();
});

test('ready assets and legacy rows pass through', async () => {
  getFiles.mockResolvedValue([
    { file_id: 'f1', knauf_asset_id: 'a1' },
    { file_id: 'f2' }, // legacy — no asset pointer
  ]);
  getAssetsByAssetIds.mockResolvedValue([
    { asset_id: 'a1', active_generation: 1, delete_requested_at: null },
  ]);
  const res = makeRes();
  const next = jest.fn();
  await knaufFileIndexReadiness(makeReq([{ file_id: 'f1' }, { file_id: 'f2' }]), res, next);
  expect(getFiles).toHaveBeenCalledWith({ file_id: { $in: ['f1', 'f2'] }, user: 'u1' }, null, {
    text: 0,
  });
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
});

test('a non-ready initial asset → 409 file_indexing_not_ready with the file ids', async () => {
  getFiles.mockResolvedValue([
    { file_id: 'f1', knauf_asset_id: 'a1' },
    { file_id: 'f2', knauf_asset_id: 'a2' },
  ]);
  getAssetsByAssetIds.mockResolvedValue([
    { asset_id: 'a1', active_generation: null, delete_requested_at: null }, // pending
    { asset_id: 'a2', active_generation: 1, delete_requested_at: null }, // ready
  ]);
  const res = makeRes();
  const next = jest.fn();
  await knaufFileIndexReadiness(makeReq([{ file_id: 'f1' }, { file_id: 'f2' }]), res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith({
    error: 'file_indexing_not_ready',
    file_ids: ['f1'],
  });
});

test('a delete-tombstoned asset also blocks the send', async () => {
  getFiles.mockResolvedValue([{ file_id: 'f1', knauf_asset_id: 'a1' }]);
  getAssetsByAssetIds.mockResolvedValue([
    { asset_id: 'a1', active_generation: 3, delete_requested_at: new Date() },
  ]);
  const res = makeRes();
  const next = jest.fn();
  await knaufFileIndexReadiness(makeReq([{ file_id: 'f1' }]), res, next);
  expect(res.status).toHaveBeenCalledWith(409);
});

test('a lookup failure fails open (chat must not go down)', async () => {
  getFiles.mockRejectedValue(new Error('mongo down'));
  const res = makeRes();
  const next = jest.fn();
  await knaufFileIndexReadiness(makeReq([{ file_id: 'f1' }]), res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
});
// End [knauf]
