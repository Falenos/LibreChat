import { describe, expect, it, vi } from 'vitest';
import { assignPushNames, pushInputs } from '../../src/exec/stagePush.js';
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
    const bufferedRead = vi.spyOn(blob, 'getBuffer');
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
    expect(bufferedRead).not.toHaveBeenCalled();
    expect(aca.pushed.map((p) => p.name)).toEqual([
      'SKILL.md',
      'reading.md',
      'authoring.md',
      'SOL101-quiz-import.xlsx',
    ]);
  });

  // [knauf] KK20-397 — the serial cost is bounded for the optional tail only.
  it('skips optional inputs once the push budget is spent, never mandatory ones', async () => {
    const blob = new FakeBlobStore();
    const repo = new FakeFilesRepo();
    const aca = new FakeAcaClient();
    const inputs = await stageInputs(blob, repo, [
      'named.docx',
      'sibling.py',
      'old-1.csv',
      'old-2.csv',
    ]);

    const result = await pushInputs(
      inputs,
      'karl-11111111111111111111111111111111',
      { aca, blob, repo: repo.asRepo(), logger: testLogger() },
      undefined,
      { budgetMs: -1, mandatoryCount: 2 },
    );

    expect(aca.maxConcurrentPushes).toBe(1);
    expect(aca.pushed.map((p) => p.name)).toEqual(['named.docx', 'sibling.py']);
    expect(result.pushed.map((i) => i.finalName)).toEqual(['named.docx', 'sibling.py']);
    expect(result.skipped.map((i) => i.finalName)).toEqual(['old-1.csv', 'old-2.csv']);
  });
});

describe('assignPushNames', () => {
  it('numbers only nested inputs, densely, after selection', () => {
    const doc = { filename: 'x' } as never;
    const pushed = assignPushNames([
      { ref: { id: '1', name: 'a.csv' }, doc, finalName: 'a.csv', index: 5 },
      { ref: { id: '2', name: 'k/b.md' }, doc, finalName: 'k/b.md', index: 9 },
      { ref: { id: '3', name: 'k/c.md' }, doc, finalName: 'k/c.md', index: 2 },
    ]);
    expect(pushed.map((p) => p.pushedAs)).toEqual(['a.csv', '.karl_in_0', '.karl_in_1']);
  });
});
