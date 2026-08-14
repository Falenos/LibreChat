import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Readable } from 'node:stream';
import { createApp } from '../../src/app.js';
import { AcaSessionNotFoundError, AcaTimeoutError } from '../../src/types/aca.js';
import {
  FakeAcaClient,
  FakeBlobStore,
  FakeFilesRepo,
  ownedSessionId,
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

  it('rejects excess per-pod work without queueing or allocating another sandbox', async () => {
    let startFirst!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let executions = 0;
    aca.executeImpl = async (_sid, code) => {
      executions += 1;
      startFirst();
      await holdFirst;
      return sentinelOutcome(code, 0, 'done');
    };

    const first = request(app).post('/v1/exec').send({ lang: 'py', code: 'first' });
    const firstResponse = first.then((response) => response);
    await firstStarted;
    const second = await request(app).post('/v1/exec').send({ lang: 'py', code: 'second' });

    expect(second.status).toBe(200);
    expect(second.body.code).toBe(1);
    expect(second.body.stderr).toMatch(/at capacity/i);
    expect(executions).toBe(1);

    releaseFirst();
    await expect(firstResponse).resolves.toMatchObject({ status: 200 });
  });

  // [knauf] KK20-257 review F5. `runtime_session_hint` is the only continuity field the
  // locked client puts on the wire (and only when the host sets
  // toolExecution.sandbox.statefulSessions). Same hint ⇒ same sandbox; the hint itself is
  // never used as the ACA identifier, since it is a guessable LibreChat conversation id.
  it('derives one stable sandbox from runtime_session_hint, and echoes it back', async () => {
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'ok');

    const first = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(1)', runtime_session_hint: 'thread-abc' });
    const second = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(2)', runtime_session_hint: 'thread-abc' });
    const other = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(3)', runtime_session_hint: 'thread-xyz' });

    expect(first.body.session_id).toBe(second.body.session_id);
    expect(other.body.session_id).not.toBe(first.body.session_id);
    // Stays inside our own namespace, and does not leak the conversation id.
    expect(first.body.session_id).toMatch(/^karl-[0-9a-f]{32}$/);
    expect(JSON.stringify(first.body)).not.toContain('thread-abc');
    // Echoed for observability only when the session came from a hint.
    expect(first.body.runtime_session_id).toBe(first.body.session_id);
  });

  it('mints a fresh sandbox per exec when no hint and no session_id are sent', async () => {
    // The default path with the current client: continuity is off, so each execution is
    // isolated. Pinned so enabling statefulSessions later is a visible behaviour change.
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'ok');
    const a = await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)' });
    const b = await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)' });

    expect(a.body.session_id).not.toBe(b.body.session_id);
    expect(a.body.runtime_session_id).toBeUndefined();
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

  // [knauf] KK20-257 review F3. Byte length does not prove a writable input is untouched:
  // `abc` → `xyz` keeps the size. Echoing that as inherited:true returns the ORIGINAL file
  // and throws the user's edit away, while the exec reports success. The pre-exec baseline
  // (taken after inputs are pushed) is what makes the difference detectable.
  it('captures a same-size overwrite of a writable input instead of echoing it', async () => {
    const doc = await repo.insertStaged({
      sessionId: 'karl-' + 'b'.repeat(32),
      filename: 'data.csv',
      size: 3,
      contentType: 'text/csv',
      origin: 'upload',
      readOnly: false,
      identity: { kind: 'user', id: 'local' },
      userId: 'local',
      tenantId: 'local',
    });
    await blob.put(doc.blobPath, Buffer.from('abc'), 'text/csv');

    // Same size before and after; only the modification time moves, exactly as an
    // in-place rewrite behaves.
    let listedAt = '2026-08-10T10:00:00Z';
    aca.sessionFiles = [
      { name: 'data.csv', type: 'File', sizeInBytes: 3, lastModifiedAt: listedAt },
    ];
    aca.fileContents.set('data.csv', Buffer.from('xyz'));
    aca.executeImpl = async (_sid, code) => {
      listedAt = '2026-08-10T10:00:05Z';
      aca.sessionFiles = [
        { name: 'data.csv', type: 'File', sizeInBytes: 3, lastModifiedAt: listedAt },
      ];
      return sentinelOutcome(code, 0, '');
    };

    const response = await request(app)
      .post('/v1/exec')
      .send({
        lang: 'py',
        code: "open('data.csv','w').write('xyz')",
        files: [
          { id: doc.fileId, name: 'data.csv', storage_session_id: doc.sessionId, kind: 'user' },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    const returned = response.body.files.find((f: { name: string }) => f.name === 'data.csv');
    // Captured as this exec's output, NOT echoed as the untouched original.
    expect(returned.inherited).toBeUndefined();
    expect(returned.storage_session_id).toBe(response.body.session_id);
  });

  // The same bug, on the nested path — review finding A3. A nested input is pushed flat as
  // `.karl_in_<n>` and renamed by the wrapper *inside* the execution, so the baseline holds
  // the flat name while the post-exec listing shows the nested one. Keying the baseline
  // lookup on the listed name misses it and falls back to comparing byte length, which a
  // same-size rewrite passes — so the edit was reported inherited and discarded.
  it('captures a same-size overwrite of a NESTED writable input (A3 regression)', async () => {
    const doc = await repo.insertStaged({
      sessionId: 'karl-' + 'c'.repeat(32),
      filename: 'reports/data.csv', // nested ⇒ pushed as .karl_in_0, then renamed
      size: 3,
      contentType: 'text/csv',
      origin: 'upload',
      readOnly: false,
      identity: { kind: 'user', id: 'local' },
      userId: 'local',
      tenantId: 'local',
    });
    await blob.put(doc.blobPath, Buffer.from('abc'), 'text/csv');

    // Pre-exec the sandbox lists the FLAT push name (the rename has not happened yet).
    aca.sessionFiles = [
      { name: '.karl_in_0', type: 'File', sizeInBytes: 3, lastModifiedAt: '2026-08-10T10:00:00Z' },
    ];
    aca.fileContents.set('reports/data.csv', Buffer.from('xyz'));
    aca.executeImpl = async (_sid, code) => {
      // Post-exec it lists the nested name, same size, later mtime — an in-place rewrite.
      aca.sessionFiles = [
        {
          name: 'reports/data.csv',
          type: 'File',
          sizeInBytes: 3,
          lastModifiedAt: '2026-08-10T10:00:05Z',
        },
      ];
      return sentinelOutcome(code, 0, '');
    };

    const response = await request(app)
      .post('/v1/exec')
      .send({
        lang: 'py',
        code: "open('reports/data.csv','w').write('xyz')",
        files: [
          {
            id: doc.fileId,
            name: 'reports/data.csv',
            storage_session_id: doc.sessionId,
            kind: 'user',
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    const returned = response.body.files.find(
      (f: { name: string }) => f.name === 'reports/data.csv',
    );
    expect(returned.inherited).toBeUndefined();
    expect(returned.storage_session_id).toBe(response.body.session_id);
  });

  // [knauf] KK20-257 review F6. `@librechat/agents` (3.2.65 and 3.2.46) formats only
  // stdout/stderr and never reads `result.code`, so a silent non-zero exit renders as
  // "stdout: Empty" and reads as success. The adapter has to put the failure where the
  // caller will actually show it.
  it('synthesizes stderr when a non-zero exit produced no output at all', async () => {
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 7, '', '');
    const response = await request(app).post('/v1/exec').send({ lang: 'bash', code: 'exit 7' });

    expect(response.status).toBe(200);
    expect(response.body.code).toBe(7);
    expect(response.body.stderr).toMatch(/exit status 7/i);
    expect(response.body.stderr).toMatch(/failure, not an empty result/i);
  });

  it('leaves a real stderr alone on a non-zero exit', async () => {
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 1, '', 'Traceback: boom');
    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'raise' });

    expect(response.body.code).toBe(1);
    expect(response.body.stderr).toContain('Traceback: boom');
    expect(response.body.stderr).not.toMatch(/exit status/i);
  });

  // [knauf] KK20-257 review F7. A capture failure used to drop the file and still return
  // code:0, so a generated deliverable could disappear while the tool reported success.
  it('reports generated files it could not persist instead of silently dropping them', async () => {
    aca.sessionFiles = [{ name: 'chart.png', type: 'File', sizeInBytes: 10 }];
    // Present in the sandbox, but unfetchable — stands in for an ACA/Blob/Mongo failure.
    aca.fetchFileContent = async () => {
      throw new Error('blob write failed');
    };
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'done');

    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: "open('chart.png','wb').write(b'x')" });

    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    expect(response.body.files).toHaveLength(0);
    expect(response.body.stderr).toMatch(/could not be saved/i);
  });

  it('streams unsized output and enforces the byte budget on actual chunks', async () => {
    const app2 = createApp({
      config: testConfig({ CAPTURE_MAX_TOTAL_BYTES: '10' }),
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      mongo: { db: { command: async () => ({ ok: 1 }) } } as never,
      metrics: testMetrics(),
    });
    aca.sessionFiles = [{ name: 'unsized.bin', type: 'File' }];
    aca.fetchFileContent = async () => {
      throw new Error('buffering path must not be used for output capture');
    };
    aca.fetchFileStream = async () => ({
      stream: Readable.from([Buffer.alloc(6), Buffer.alloc(6)]),
    });
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'done');

    const response = await request(app2).post('/v1/exec').send({ lang: 'py', code: 'x' });

    expect(response.body.files).toHaveLength(0);
    expect(response.body.stderr).toContain('not captured');
    expect(blob.blobs.size).toBe(0);
    expect(repo.docs.size).toBe(0);
  });

  it('supports the full 256 MiB capture contract without buffering the file', async () => {
    const limit = 256 * 1024 * 1024;
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    let uploadedBytes = 0;
    blob.put = async (_path, data) => {
      if (Buffer.isBuffer(data)) {
        uploadedBytes += data.length;
        return;
      }
      for await (const part of data) {
        uploadedBytes += Buffer.isBuffer(part)
          ? part.length
          : Buffer.byteLength(part as Uint8Array);
      }
    };
    aca.sessionFiles = [{ name: 'full.bin', type: 'File', sizeInBytes: limit }];
    aca.fetchFileStream = async () => ({
      stream: Readable.from(
        (async function* () {
          for (let sent = 0; sent < limit; sent += chunk.length) {
            yield chunk;
          }
        })(),
      ),
      contentLength: limit,
    });
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'done');

    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'x' });

    expect(response.status).toBe(200);
    expect(response.body.files.map((file: { name: string }) => file.name)).toContain('full.bin');
    expect(uploadedBytes).toBe(limit);
    const stored = [...repo.docs.values()].find((doc) => doc.filename === 'full.bin');
    expect(stored?.size).toBe(limit);
  });

  it('removes the uploaded candidate Blob when the Mongo commit fails', async () => {
    aca.sessionFiles = [{ name: 'report.csv', type: 'File', sizeInBytes: 3 }];
    aca.fileContents.set('report.csv', Buffer.from('abc'));
    repo.upsertCaptured = async () => {
      throw new Error('mongo unavailable');
    };
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'done');

    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'x' });

    expect(response.body.files).toHaveLength(0);
    expect(response.body.stderr).toContain('could not be saved');
    expect(blob.blobs.size).toBe(0);
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
    // Must be an id this caller owns — /exec ignores a foreign one and allocates fresh,
    // which would silently turn this reuse test into a no-reuse test.
    const S = ownedSessionId(testConfig());
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
    const firstOut1 = r1.body.files.find((f: { name: string }) => f.name === 'out1.txt');
    const replacedOut1 = r4.body.files.find((f: { name: string }) => f.name === 'out1.txt');
    expect(replacedOut1.id).toBe(firstOut1.id);
    const stored = await repo.find(S, replacedOut1.id);
    expect(stored).not.toBeNull();
    expect(blob.blobs.get(stored!.blobPath)?.data).toEqual(Buffer.from('x'.repeat(9999)));
    expect([...blob.blobs.keys()].filter((path) => path.startsWith(`${S}/`))).toHaveLength(2);
  });

  it('does not return files that exceed the capture byte budget — sized or unsized', async () => {
    // Small cap so one output blows the budget. An unsized listing entry must be
    // treated as the whole remaining budget (not 0), so it can't slip the cap.
    const app2 = createApp({
      config: testConfig({ CAPTURE_MAX_TOTAL_BYTES: '10' }),
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      mongo: { db: { command: async () => ({ ok: 1 }) } } as never,
      metrics: testMetrics(),
    });
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'done');

    // (a) sized-too-big
    aca.sessionFiles = [{ name: 'big.bin', type: 'File', sizeInBytes: 1000 }];
    aca.fileContents.set('big.bin', Buffer.alloc(1000));
    const sized = await request(app2).post('/v1/exec').send({ lang: 'py', code: 'x' });
    expect(sized.body.files.map((f: { name: string }) => f.name)).not.toContain('big.bin');
    expect(sized.body.stderr).toContain('not captured');

    // (b) unsized (no sizeInBytes) but actually large → still excluded, not fetched unbounded
    aca.sessionFiles = [{ name: 'huge.bin', type: 'File' }];
    aca.fileContents.set('huge.bin', Buffer.alloc(1000));
    const unsized = await request(app2).post('/v1/exec').send({ lang: 'py', code: 'y' });
    expect(unsized.body.files.map((f: { name: string }) => f.name)).not.toContain('huge.bin');
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
