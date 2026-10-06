import { Types } from 'mongoose';
import { Readable } from 'stream';
import type { Response } from 'express';
import type { SkillsHandlersDeps } from '~/skills/handlers';
import type { ServerRequest } from '~/types';
import { isSandboxOnlySkillFile } from './sandboxOnlySkillFiles';
import { createSkillsHandlers } from '~/skills/handlers';

const SKILL_ID = new Types.ObjectId().toString();
const row = (relativePath: string, source = 'deployment') => ({
  _id: new Types.ObjectId(),
  skillId: SKILL_ID,
  relativePath,
  file_id: `f-${relativePath}`,
  filename: relativePath.split('/').pop(),
  filepath: `/app/skill/karl-brand/${relativePath}`,
  source,
  mimeType: 'application/octet-stream',
  bytes: 3,
  category: 'other',
  isExecutable: false,
  author: new Types.ObjectId(),
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
  };
  return res;
}

function handlers(files: ReturnType<typeof row>[]) {
  const getDownloadStream = jest.fn(async () => Readable.from(Buffer.from('abc')));
  const deps = {
    listSkillFiles: jest.fn(async () => files),
    getSkillFileByPath: jest.fn(
      async (_id: string, relativePath: string) =>
        files.find((f) => f.relativePath === relativePath) ?? null,
    ),
    getStrategyFunctions: jest.fn(() => ({ getDownloadStream })),
  } as unknown as SkillsHandlersDeps;
  return { h: createSkillsHandlers(deps), getDownloadStream };
}

describe('[knauf] sandbox-only deployment-skill files (KK20-397)', () => {
  it('classifies only deployment files under sandbox/', () => {
    expect(isSandboxOnlySkillFile(row('sandbox/knauf-fonts.zip'))).toBe(true);
    expect(isSandboxOnlySkillFile(row('assets/knauf-wordmark.png'))).toBe(false);
    expect(isSandboxOnlySkillFile(row('references/sandbox/notes.md'))).toBe(false);
    expect(isSandboxOnlySkillFile(row('sandbox/x.zip', 'local'))).toBe(false);
  });

  it('leaves sandbox-only files out of the Skills file listing', async () => {
    const { h } = handlers([row('sandbox/knauf-fonts.zip'), row('assets/knauf-wordmark.png')]);
    const res = fakeRes();
    await h.listFiles(
      { params: { id: SKILL_ID } } as unknown as ServerRequest,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(200);
    const listed = (res.body as { files: Array<{ relativePath: string }> }).files;
    expect(listed.map((f) => f.relativePath)).toEqual(['assets/knauf-wordmark.png']);
  });

  it('answers a direct download of a sandbox-only file like a missing file, and never streams it', async () => {
    const { h, getDownloadStream } = handlers([row('sandbox/knauf-fonts.zip')]);
    const res = fakeRes();
    await h.downloadFile(
      {
        params: { id: SKILL_ID, relativePath: encodeURIComponent('sandbox/knauf-fonts.zip') },
        query: { raw: 'true' },
      } as unknown as ServerRequest,
      res as unknown as Response,
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Skill file not found' });
    expect(getDownloadStream).not.toHaveBeenCalled();
  });
});
