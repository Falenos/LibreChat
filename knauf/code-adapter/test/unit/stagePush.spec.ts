import { describe, expect, it } from 'vitest';
import { pushInputs } from '../../src/exec/stagePush.js';
import type { ResolvedInput } from '../../src/exec/stagePush.js';
import { FakeAcaClient, FakeBlobStore, FakeFilesRepo, testLogger } from '../helpers/fakes.js';

async function stageInputs(
  blob: FakeBlobStore,
  repo: FakeFilesRepo,
  names: string[],
): Promise<ResolvedInput[]> {
  const inputs: ResolvedInput[] = [];
  for (const name of names) {
    const data = Buffer.from(`content-of-${name}`);
    const doc = await repo.insertStaged({
      sessionId: 'karl-00000000000000000000000000000000',
      filename: name,
      size: data.length,
      contentType: 'application/octet-stream',
      origin: 'upload',
      readOnly: false,
      identity: { kind: 'user', id: 'u1' },
      userId: 'u1',
      tenantId: 't1',
    });
    await blob.put(doc.blobPath, data, doc.contentType);
    inputs.push({ ref: { id: doc.fileId, name }, doc, pushedAs: name, finalName: name });
  }
  return inputs;
}

describe('pushInputs', () => {
  // ACA session file upload is not concurrency-safe: parallel uploads clobber
  // each other and only one file survives (verified live, Aug 2026). Pushes
  // must be strictly sequential.
  it('pushes staged inputs one at a time, never overlapping', async () => {
    const blob = new FakeBlobStore();
    const repo = new FakeFilesRepo();
    const aca = new FakeAcaClient();
    const inputs = await stageInputs(blob, repo, [
      'SKILL.md',
      'reading.md',
      'authoring.md',
      'SOL101-quiz-import.xlsx',
    ]);

    await pushInputs(inputs, 'karl-11111111111111111111111111111111', {
      aca,
      blob,
      repo: repo.asRepo(),
      logger: testLogger(),
    });

    expect(aca.maxConcurrentPushes).toBe(1);
    expect(aca.pushed.map((p) => p.name)).toEqual([
      'SKILL.md',
      'reading.md',
      'authoring.md',
      'SOL101-quiz-import.xlsx',
    ]);
  });
});
