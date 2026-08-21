import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Readable } from 'node:stream';
import { createApp } from '../../src/app.js';
import {
  ACA_FILE_MANIFEST_TRUNCATED_NAME,
  AcaError,
  AcaSessionNotFoundError,
  AcaTimeoutError,
} from '../../src/types/aca.js';
import { fileSignature } from '../../src/exec/capture.js';
import {
  FakeAcaClient,
  FakeBlobStore,
  FakeFilesRepo,
  ownedSessionId,
  testConfig,
  testLogger,
  testMetrics,
} from '../helpers/fakes.js';
import { OUT_LOG } from '../../src/exec/wrapper.js';
import type { Express } from 'express';
import type { AcaExecOutcome } from '../../src/types/aca.js';
import type { Metrics } from '../../src/middleware/metrics.js';

/**
 * /exec contract tests replaying CodeExecutor / BashExecutor /
 * readSandboxFile shapes against a programmable fake pool.
 */
describe('POST /v1/exec contract', () => {
  let app: Express;
  let aca: FakeAcaClient;
  let repo: FakeFilesRepo;
  let blob: FakeBlobStore;
  let metrics: Metrics;

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
    metrics = testMetrics();
    app = createApp({
      config: testConfig(),
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      metadataReadiness: async () => undefined,
      metrics,
    });
  });

  it('normalizes ACA timestamps and wrapper nanoseconds to one file signature', () => {
    const epochSeconds = BigInt(Date.parse('2026-08-18T16:22:14Z')) / 1000n;
    const nanoseconds = epochSeconds * 1_000_000_000n + 810_699_504n;

    expect(
      fileSignature({
        sizeInBytes: 8,
        lastModifiedAt: '2026-08-18T16:22:14.8106995Z',
      }),
    ).toBe(fileSignature({ sizeInBytes: 8, lastModifiedAt: nanoseconds.toString() }));
  });

  it('captures bounded manifest results and reports when the recursive scan truncated', async () => {
    aca.sessionFiles = [
      {
        name: 'partial.csv',
        type: 'File',
        sizeInBytes: 3,
        lastModifiedAt: '1787070000000000000',
      },
      {
        name: ACA_FILE_MANIFEST_TRUNCATED_NAME,
        type: 'File',
        sizeInBytes: 0,
        lastModifiedAt: '',
      },
    ];
    aca.fileContents.set('partial.csv', Buffer.from('abc'));
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'ok');

    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)' });

    expect(response.status).toBe(200);
    expect(response.body.files).toEqual([expect.objectContaining({ name: 'partial.csv' })]);
    expect(response.body.files[0]).not.toHaveProperty('inherited');
    expect(response.body.stderr).toContain('some generated files were not captured');
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

  it('records input bytes once per execution', async () => {
    const observe = vi.spyOn(metrics.execInputBytes, 'observe');
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'ok');

    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)' });

    expect(response.status).toBe(200);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(0);
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
    expect(aca.deletedSessions).toEqual([a.body.session_id, b.body.session_id]);
  });

  it('does not delete caller-owned or hint-derived stateful sessions', async () => {
    const config = testConfig();
    app = createApp({
      config,
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      metadataReadiness: async () => undefined,
      metrics,
    });
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'ok');
    const owned = ownedSessionId(config);

    await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)', session_id: owned });
    await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(1)', runtime_session_hint: 'thread-1' });

    expect(aca.deletedSessions).toEqual([]);
  });

  it('does not fail a completed exec when best-effort stateless session deletion fails', async () => {
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'ok');
    aca.deleteSessionImpl = async () => {
      throw new Error('delete denied');
    };

    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ code: 0, stdout: 'ok' });
  });

  it('enforces one total request deadline and still attempts independent cleanup', async () => {
    app = createApp({
      config: testConfig({ EXEC_TOTAL_TIMEOUT_MS: '25' }),
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      metadataReadiness: async () => undefined,
      metrics,
    });
    aca.executeImpl = async (_sid, _code, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });

    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'while True: pass' });

    expect(response.status).toBe(200);
    expect(response.body.stderr).toContain('220-second limit');
    expect(aca.deletedSessions).toEqual([response.body.session_id]);
  });

  it('maps a deadline during capacity backoff to the bounded timeout response', async () => {
    app = createApp({
      config: testConfig({ EXEC_TOTAL_TIMEOUT_MS: '25' }),
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      metadataReadiness: async () => undefined,
      metrics,
    });
    aca.executeImpl = async () => {
      throw new AcaError('pool at capacity', 429, 'Capacity', 5);
    };

    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(1)' });

    expect(response.status).toBe(200);
    expect(response.body.stderr).toContain('220-second limit');
  });

  it('unsupported lang → 501 (adapter contract)', async () => {
    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'node', code: 'console.log(1)' });
    expect(response.status).toBe(501);
    expect(response.body.error).toContain("Language 'node'");
  });

  it('rejects malformed and excessive file-reference shapes before metadata access', async () => {
    const malformed = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(1)', files: [{ id: 42, name: 'bad.txt' }] });
    const excessive = await request(app)
      .post('/v1/exec')
      .send({
        lang: 'py',
        code: 'print(1)',
        files: Array.from({ length: 21 }, (_, index) => ({
          id: `file-${index}`,
          name: `file-${index}.txt`,
        })),
      });

    expect(malformed.status).toBe(400);
    expect(excessive.status).toBe(413);
    expect(aca.pushed).toHaveLength(0);
  });

  it('enforces metadata-backed per-file input limits before Blob download', async () => {
    const config = testConfig({ EXEC_INPUT_MAX_FILE_BYTES: '2' });
    app = createApp({
      config,
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      metadataReadiness: async () => undefined,
      metrics,
    });
    const doc = await repo.insertStaged({
      sessionId: ownedSessionId(config),
      filename: 'three.txt',
      size: 3,
      contentType: 'text/plain',
      origin: 'upload',
      readOnly: false,
      identity: { kind: 'user', id: 'local' },
      userId: 'local',
      tenantId: 'local',
    });
    await blob.put(doc.blobPath, Buffer.from('abc'), doc.contentType);

    const response = await request(app)
      .post('/v1/exec')
      .send({
        lang: 'py',
        code: 'print(1)',
        files: [{ id: doc.fileId, name: doc.filename, storage_session_id: doc.sessionId }],
      });

    expect(response.status).toBe(413);
    expect(aca.pushed).toHaveLength(0);
  });

  it('rejects immediately when active execution admission is full', async () => {
    app = createApp({
      config: testConfig({ EXEC_MAX_ACTIVE_REQUESTS: '1' }),
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      metadataReadiness: async () => undefined,
      metrics,
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    aca.executeImpl = async (_sid, code) => {
      markStarted();
      await finished;
      return sentinelOutcome(code, 0, 'ok');
    };

    const first = request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print(1)' })
      .then((response) => response);
    await started;
    const rejected = await request(app).post('/v1/exec').send({ lang: 'py', code: 'print(2)' });
    finish();
    const accepted = await first;

    expect(rejected.status).toBe(429);
    expect(rejected.body.error).toContain('capacity');
    expect(accepted.status).toBe(200);
  });

  it('/exec/programmatic → 501 PTC_NOT_SUPPORTED', async () => {
    const response = await request(app).post('/v1/exec/programmatic').send({});
    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe('PTC_NOT_SUPPORTED');
  });

  it('runs only the reviewed fixed payload through the authenticated canary endpoint', async () => {
    aca.executeImpl = async (_sid, code) => {
      const fixedPayload = [
        'from pathlib import Path',
        'Path("karl-code-canary.txt").write_text("ok", encoding="utf-8")',
        'print("KARL_CODE_CANARY_OK")',
      ].join('\n');
      expect(code).toContain(Buffer.from(fixedPayload, 'utf8').toString('base64'));
      expect(code).not.toContain('caller input must be ignored');
      aca.sessionFiles = [
        {
          name: 'karl-code-canary.txt',
          type: 'File',
          sizeInBytes: 2,
          lastModifiedAt: '2026-08-19T12:00:00Z',
        },
      ];
      aca.fileContents.set('karl-code-canary.txt', Buffer.from('ok'));
      return sentinelOutcome(code, 0, 'KARL_CODE_CANARY_OK\n');
    };

    const response = await request(app).post('/v1/internal/canary').send({
      code: 'raise RuntimeError("caller input must be ignored")',
    });

    expect(response.status).toBe(200);
    expect(response.body.stdout).toBe('KARL_CODE_CANARY_OK\n');
    expect(response.body.files).toEqual([
      expect.objectContaining({ name: 'karl-code-canary.txt' }),
    ]);
    expect(aca.deletedSessions).toEqual([response.body.session_id]);
  });

  it('records backend failures as canary errors', async () => {
    const canarySpy = vi.spyOn(metrics.canaryTotal, 'inc');
    aca.executeImpl = async () => {
      throw new AcaError('pool unavailable', 502, 'BackendUnavailable');
    };

    const response = await request(app).post('/v1/internal/canary').send({});

    expect(response.status).toBe(502);
    expect(canarySpy).toHaveBeenCalledWith({ outcome: 'error' });
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

  it('captures writable inputs conservatively when the pre-exec baseline cannot be read', async () => {
    const doc = await repo.insertStaged({
      sessionId: 'karl-' + 'e'.repeat(32),
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

    let listCalls = 0;
    aca.listFilesImpl = async () => {
      listCalls += 1;
      if (listCalls === 1) {
        throw new Error('baseline unavailable');
      }
      return [
        {
          name: 'data.csv',
          type: 'File',
          sizeInBytes: 3,
          lastModifiedAt: '2026-08-10T10:00:00Z',
        },
      ];
    };
    aca.fileContents.set('data.csv', Buffer.from('xyz'));
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, '');

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
    expect(response.body.files).toEqual([
      expect.objectContaining({
        name: 'data.csv',
        storage_session_id: response.body.session_id,
      }),
    ]);
    expect(response.body.files[0]).not.toHaveProperty('inherited');
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
    // Present in the sandbox, but unfetchable — stands in for an ACA/Blob/Table failure.
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
      metadataReadiness: async () => undefined,
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

  it('interrupts a single stalled capture when the total capture deadline expires', async () => {
    const app2 = createApp({
      config: testConfig({ CAPTURE_MAX_TOTAL_MS: '10' }),
      logger: testLogger(),
      aca,
      blob,
      repo: repo.asRepo(),
      metadataReadiness: async () => undefined,
      metrics: testMetrics(),
    });
    aca.sessionFiles = [{ name: 'stalled.bin', type: 'File' }];
    let sentPartial = false;
    aca.fetchFileStream = async () => ({
      stream: new Readable({
        read() {
          if (!sentPartial) {
            sentPartial = true;
            this.push(Buffer.from('partial'));
          }
        },
      }),
    });
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'done');

    const response = await request(app2).post('/v1/exec').send({ lang: 'py', code: 'x' });

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(0);
    expect(response.body.stderr).toMatch(/took longer than/i);
    expect(repo.docs.size).toBe(0);
  });

  it('contains ACA source-stream failures as a failed capture', async () => {
    aca.sessionFiles = [{ name: 'broken.bin', type: 'File' }];
    aca.fetchFileStream = async () => ({
      stream: new Readable({
        read() {
          this.destroy(new Error('ACA connection reset'));
        },
      }),
    });
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'done');

    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'x' });

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(0);
    expect(response.body.stderr).toMatch(/could not be saved/i);
  });

  it('retains the uploaded candidate Blob when the Table commit outcome is uncertain', async () => {
    aca.sessionFiles = [{ name: 'report.csv', type: 'File', sizeInBytes: 3 }];
    aca.fileContents.set('report.csv', Buffer.from('abc'));
    repo.upsertCaptured = async () => {
      throw new Error('table unavailable');
    };
    aca.executeImpl = async (_sid, code) => sentinelOutcome(code, 0, 'done');

    const response = await request(app).post('/v1/exec').send({ lang: 'py', code: 'x' });

    expect(response.body.files).toHaveLength(0);
    expect(response.body.stderr).toContain('could not be saved');
    expect(blob.blobs.size).toBe(1);
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
      metadataReadiness: async () => undefined,
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

  it('recovers truncated stdout from /mnt/data and increments the truncation-recovery metric', async () => {
    const fullStdout = `${'x'.repeat(200)}\n`;
    aca.fileContents.set(OUT_LOG, Buffer.from(fullStdout, 'utf8'));
    aca.executeImpl = async (_sid, code) => {
      const delimiter = /KARL_[0-9a-f]{12}/.exec(code)?.[0];
      if (delimiter == null) {
        throw new Error('wrapper delimiter not found in submitted code');
      }
      // Sentinel claims the full byte count, but the inline chunk is short — exactly
      // what the pool sends when its own inline truncation kicks in.
      const inlineStdout = 'x'.repeat(10);
      return {
        succeeded: true,
        stdout: `${delimiter} RC=0 OUT=${Buffer.byteLength(fullStdout, 'utf8')} ERR=0\n${inlineStdout}${delimiter}_ERR\n`,
        stderr: '',
        raw: {},
      };
    };

    const response = await request(app)
      .post('/v1/exec')
      .send({ lang: 'py', code: 'print("x" * 200)' });

    expect(response.status).toBe(200);
    expect(response.body.code).toBe(0);
    expect(response.body.stdout).toBe(fullStdout);

    const recovered = await metrics.truncationRecoveries.get();
    expect(recovered.values[0].value).toBe(1);
  });
});
