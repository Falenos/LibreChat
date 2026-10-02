import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { budgetedDiskStorage } from '../../src/routes/budgetedDiskStorage.js';
import {
  FakeAcaClient,
  FakeBlobStore,
  FakeFilesRepo,
  testConfig,
  testLogger,
  testMetrics,
} from '../helpers/fakes.js';

vi.mock('../../src/routes/budgetedDiskStorage.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/routes/budgetedDiskStorage.js')>();
  return { budgetedDiskStorage: vi.fn(original.budgetedDiskStorage) };
});

// Review of #386 (P1): the batch budget is enforced by the storage engine while parsing. This
// pins the route to that engine, so a return to multer's plain `dest:` spooling is caught.
describe('upload routes spool through the budgeted storage engine', () => {
  it('builds the engine with the batch byte budget', () => {
    createApp({
      config: testConfig({ UPLOAD_BATCH_MAX_TOTAL_BYTES: '4096' }),
      logger: testLogger(),
      aca: new FakeAcaClient(),
      blob: new FakeBlobStore(),
      repo: new FakeFilesRepo().asRepo(),
      metadataReadiness: async () => undefined,
      metrics: testMetrics(),
    });
    expect(budgetedDiskStorage).toHaveBeenCalledWith(expect.any(String), 4096);
  });
});
