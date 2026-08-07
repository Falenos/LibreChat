import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { AcaSessionNotFoundError, AcaTimeoutError } from '../../src/types/aca.js';
import {
  FakeAcaClient,
  FakeBlobStore,
  FakeFilesRepo,
  testConfig,
  testLogger,
  testMetrics,
} from '../helpers/fakes.js';
import type { Express } from 'express';
import type { AcaExecOutcome } from '../../src/types/aca.js';

/**
 * /exec contract tests replaying CodeExecutor / BashExecutor /
 * readSandboxFile shapes against a programmable fake pool.
 */
describe('POST /v1/exec contract', () => {
  let app: Express;
  let aca: FakeAcaClient;
  let repo: FakeFilesRepo;
  let blob: FakeBlobStore;

  /** Simulate the pool running our wrapper: parse the embedded sentinel pieces. */
  const sentinelOutcome = (
    code: string,
    rc: number,
    stdout: string,
    stderr = '',
  ): AcaExecOutcome => {
    const delimiter = /KARL_[0-9a-f]{12}/.exec(code)?.[0];
    if (delimiter == null) {
      throw new Error('wrapper delimiter not found in submitted code');
    }
    const out = Buffer.byteLength(stdout, 'utf8');
    const err = Buffer.byteLength(stderr, 'utf8');
    return {
      succeeded: true,
      stdout: `${delimiter} RC=${rc} OUT=${out} ERR=${err}\n${stdout}${delimiter}_ERR\n${stderr}`,
      stderr: '',
      raw: {},
    };
  };

  beforeEach(() => {
    aca = new FakeAcaClient();
    repo = new FakeFilesRepo();
    blob = new FakeBlobStore();
    app = createApp({
      config: testConfig(),
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      mongo: { db: { command: async () => ({ ok: 1 }) } } as never,
      metrics: testMetrics(),
    });
  });

  it('CodeExecutor shape: py exec wraps user code as a python subprocess and returns real rc', async () => {
    aca.executeImpl = async (_sid, code) => {
      // both langs submit a Python wrapper to the one code-interpreter pool
      expect(code).toContain('subprocess.run');
      expect(code).toContain('/tmp/karl_user.py');
      return sentinelOutcome(code, 0, '42\n');
    };
    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(40+2)', user_id: 'user-1' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ stdout: '42\n', stderr: '', code: 0, files: [] });
    expect(response.body.session_id).toMatch(/^karl-[0-9a-f]{32}$/);
  });

  it('BashExecutor shape: lang=bash runs via a python-hosted bash subprocess with a real exit code', async () => {
    aca.executeImpl = async (_sid, code) => {
      // bash runs on the same code-interpreter pool, launched as subprocess(['bash', …])
      expect(code).toContain('subprocess.run');
      expect(code).toContain("'bash'");
      expect(code).toContain('/tmp/karl_user.sh');
      return sentinelOutcome(code, 2, '', 'grep: no match\n');
    };
    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'bash', code: 'grep nope /etc/hosts', user_id: 'user-1' });
    expect(response.status).toBe(200);
    expect(response.body.code).toBe(2);
    expect(response.body.stderr).toBe('grep: no match\n');
    expect(aca.pushed).toHaveLength(0);
  });

  it('unsupported lang → 501 (adapter contract)', async () => {
    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'node', code: 'console.log(1)' });
    expect(response.status).toBe(501);
    expect(response.body.error).toContain("Language 'node'");
  });

  it('/exec/programmatic → 501 PTC_NOT_SUPPORTED', async () => {
    const response = await request(app).post('/v1/exec/programmatic').send({});
    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe('PTC_NOT_SUPPORTED');
  });

  it('timeout → HTTP 200 {code:1} with a model-actionable stderr, never 5xx', async () => {
    aca.executeImpl = async () => {
      throw new AcaTimeoutError();
    };
    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'while True: pass' });
    expect(response.status).toBe(200);
    expect(response.body.code).toBe(1);
    expect(response.body.stderr).toContain('220-second limit');
  });

  it('readSandboxFile shape: staged files are pushed before exec', async () => {
    const doc = await repo.insertStaged({
      sessionId: 'karl-' + 'a'.repeat(32),
      filename: 'notes.txt',
      size: 5,
      contentType: 'text/plain',
      origin: 'upload',
      readOnly: false,
      identity: { kind: 'user', id: 'local' },
      userId: 'local',
      tenantId: 'local',
    });
    await blob.put(doc.blobPath, Buffer.from('hello'), 'text/plain');

    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'hello');
    const response = await request(app)
      .post('/v1/exec')
      .send({
        lang: 'bash',
        code: "cat 'notes.txt'",
        session_id: doc.sessionId,
        files: [
          { id: doc.fileId, name: 'notes.txt', storage_session_id: doc.sessionId, kind: 'user' },
        ],
      });
    expect(response.status).toBe(200);
    expect(aca.pushed).toHaveLength(1);
    expect(aca.pushed[0]!.name).toBe('notes.txt');
    // unchanged input is echoed back inherited:true with its storage session
    const echoed = response.body.files.find((f: { name: string }) => f.name === 'notes.txt');
    expect(echoed.inherited).toBe(true);
    expect(echoed.storage_session_id).toBe(doc.sessionId);
  });

  it('expired staged input → 200 {code:1} explaining re-attach (not 5xx)', async () => {
    const response = await request(app)
      .post('/v1/exec')
      .send({
        lang: 'py',
        code: 'print(1)',
        files: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'gone.csv',
            storage_session_id: 'karl-' + 'b'.repeat(32),
            kind: 'user',
          },
        ],
      });
    expect(response.status).toBe(200);
    expect(response.body.code).toBe(1);
    expect(response.body.stderr).toContain("Input file 'gone.csv'");
    expect(response.body.stderr).toContain('Re-attach');
  });

  it('SessionWithIdentifierNotFound mid-run → transparent retry with re-push', async () => {
    const doc = await repo.insertStaged({
      sessionId: 'karl-' + 'c'.repeat(32),
      filename: 'data.csv',
      size: 3,
      contentType: 'text/csv',
      origin: 'upload',
      readOnly: false,
      identity: { kind: 'user', id: 'local' },
      userId: 'local',
      tenantId: 'local',
    });
    await blob.put(doc.blobPath, Buffer.from('1,2'), 'text/csv');

    let attempts = 0;
    aca.executeImpl = async (_sid, code) => {
      attempts += 1;
      if (attempts === 1) {
        throw new AcaSessionNotFoundError();
      }
      return sentinelOutcome(code, 0, 'ok');
    };
    const response = await request(app)
      .post('/v1/exec')
      .send({
        lang: 'py',
        code: 'print("ok")',
        files: [
          { id: doc.fileId, name: 'data.csv', storage_session_id: doc.sessionId, kind: 'user' },
        ],
      });
    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    expect(attempts).toBe(2);
    expect(aca.pushed).toHaveLength(2); // pushed again on the retry
  });

  it('new files written by the code are captured and downloadable after the session dies', async () => {
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'saved\n');
    aca.sessionFiles = [
      { name: 'chart.png', type: 'File', sizeInBytes: 4, contentType: 'image/png' },
    ];
    aca.fileContents.set('chart.png', Buffer.from('PNG!'));

    const exec = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'save chart', user_id: 'user-1' });
    expect(exec.status).toBe(200);
    const file = exec.body.files.find((f: { name: string }) => f.name === 'chart.png');
    expect(file).toBeDefined();
    expect(file.path).toBe('/mnt/data/chart.png');
    expect(file.storage_session_id).toBe(exec.body.session_id);
    expect(file.inherited).toBeUndefined();

    // processCodeOutput then downloads it — served from blob, session-independent
    const download = await request(app)
      .get(`/v1/download/${exec.body.session_id}/${file.id}`)
      .query({ kind: 'user', id: 'local' });
    expect(download.status).toBe(200);
    expect(download.body.toString()).toBe('PNG!');
  });

  it('reused session returns only THIS exec’s new files, not accumulated ones (KK20-257 regression)', async () => {
    // Same session across three execs. The sandbox is reused, so /mnt/data
    // accumulates — but each exec must return only the file it created, or the
    // growing set breaks the follow-up model request (the pandas-chart 400).
    const S = 'karl-' + 'd'.repeat(32);
    const addFile = (name: string, content: string, t: string) => {
      aca.sessionFiles.push({ name, type: 'File', sizeInBytes: content.length, lastModifiedAt: t });
      aca.fileContents.set(name, Buffer.from(content));
    };
    const names = (r: { body: { files: { name: string }[] } }) =>
      r.body.files.map((f) => f.name).sort();

    aca.executeImpl = async (_sid, code) => {
      addFile('out1.txt', 'aaa', 't1'); // this exec writes out1
      return sentinelOutcome(code, 0, 'ok');
    };
    const r1 = await request(app).post('/v1/exec').send({ lang: 'py', code: 'a', session_id: S });
    expect(names(r1)).toEqual(['out1.txt']);

    aca.executeImpl = async (_sid, code) => {
      addFile('out2.txt', 'bbb', 't2'); // out1 already sits in the reused sandbox
      return sentinelOutcome(code, 0, 'ok');
    };
    const r2 = await request(app).post('/v1/exec').send({ lang: 'py', code: 'b', session_id: S });
    expect(names(r2)).toEqual(['out2.txt']); // NOT [out1, out2]

    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'ok'); // writes nothing
    const r3 = await request(app).post('/v1/exec').send({ lang: 'py', code: 'c', session_id: S });
    expect(names(r3)).toEqual([]); // no new files → nothing re-returned

    // an overwrite (same name, changed size) IS returned again
    aca.executeImpl = async (_sid, code) => {
      const e = aca.sessionFiles.find((f) => f.name === 'out1.txt')!;
      e.sizeInBytes = 9999;
      e.lastModifiedAt = 't4';
      aca.fileContents.set('out1.txt', Buffer.from('x'.repeat(9999)));
      return sentinelOutcome(code, 0, 'ok');
    };
    const r4 = await request(app).post('/v1/exec').send({ lang: 'py', code: 'd', session_id: S });
    expect(names(r4)).toEqual(['out1.txt']);
  });

  it('wrapper sentinel missing → raw stdout + synthesized 0/1 (degraded mode)', async () => {
    aca.executeImpl = async () => ({
      succeeded: true,
      stdout: 'raw pool output, no sentinel',
      stderr: '',
      raw: {},
    });
    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)' });
    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    expect(response.body.stdout).toBe('raw pool output, no sentinel');
  });
});
