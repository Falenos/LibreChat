import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import {
  FakeAcaClient,
  FakeBlobStore,
  FakeFilesRepo,
  testConfig,
  testLogger,
  testMetrics,
} from '../helpers/fakes.js';
import type { Express } from 'express';

/**
 * Contract tests replaying the exact call shapes of
 * api/server/services/Files/Code/crud.js and process.js.
 * LOCAL_MODE bypasses JWT (auth is covered in auth.spec.ts).
 */
describe('file lifecycle contract (crud.js / process.js shapes)', () => {
  let app: Express;
  let repo: FakeFilesRepo;
  let blob: FakeBlobStore;

  beforeEach(() => {
    repo = new FakeFilesRepo();
    blob = new FakeBlobStore();
    app = createApp({
      config: testConfig(),
      logger: testLogger(),
      aca: new FakeAcaClient(),
      blob,
      repo: repo.asRepo(),
      metadataReadiness: async () => undefined,
      metrics: testMetrics(),
    });
  });

  const uploadOne = async () =>
    request(app)
      .post('/v1/upload')
      .field('kind', 'user')
      .field('id', 'user-1')
      .attach('file', Buffer.from('a,b\n1,2\n'), 'data.csv');

  it('POST /upload returns the exact crud.js contract shape', async () => {
    const response = await uploadOne();
    expect(response.status).toBe(200);
    // crud.js hard-checks message === 'success' and reads files[0].fileId
    expect(response.body.message).toBe('success');
    expect(response.body.storage_session_id).toMatch(/^karl-[0-9a-f]{32}$/);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].fileId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.files[0].filename).toBe('data.csv');
  });

  it('streams spooled uploads to Blob instead of duplicating them in memory', async () => {
    const put = blob.put.bind(blob);
    let receivedStream = false;
    blob.put = async (blobPath, data, contentType, size) => {
      receivedStream = !Buffer.isBuffer(data);
      await put(blobPath, data, contentType, size);
    };

    const response = await uploadOne();

    expect(response.status).toBe(200);
    expect(receivedStream).toBe(true);
  });

  it('rolls back staged metadata and partial Blob data when upload fails', async () => {
    const put = blob.put.bind(blob);
    blob.put = async (blobPath, data, contentType, size) => {
      await put(blobPath, data, contentType, size);
      throw new Error('simulated Blob failure');
    };

    const response = await uploadOne();

    expect(response.status).toBe(500);
    expect(repo.docs.size).toBe(0);
    expect(blob.blobs.size).toBe(0);
  });

  it('POST /upload/batch honors read_only and reports succeeded/failed', async () => {
    const response = await request(app)
      .post('/v1/upload/batch')
      .field('kind', 'skill')
      .field('id', 'karl-data-analysis')
      .field('version', '3')
      .field('read_only', 'true')
      .attach('file', Buffer.from('one'), 'one.txt')
      .attach('file', Buffer.from('two'), 'two.txt');
    expect(response.status).toBe(200);
    expect(response.body.message).toBe('success');
    expect(response.body.succeeded).toBe(2);
    expect(response.body.failed).toBe(0);
    expect(response.body.files.every((f: { status: string }) => f.status === 'success')).toBe(true);

    const sid = response.body.storage_session_id as string;
    const docs = await repo.listBySession(sid);
    expect(docs.every((d) => d.readOnly)).toBe(true);
    expect(docs.every((d) => d.identity.kind === 'skill' && d.identity.version === 3)).toBe(true);
  });

  it('rejects a bad identity with the codeapi 400 wording', async () => {
    const response = await request(app)
      .post('/v1/upload')
      .field('kind', 'bogus')
      .field('id', 'x')
      .attach('file', Buffer.from('x'), 'x.txt');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('kind must be one of: skill, agent, user');
  });

  it('GET /download streams the blob with identity query (crud.js getCodeOutputDownloadStream)', async () => {
    const upload = await uploadOne();
    const sid = upload.body.storage_session_id as string;
    const fileId = upload.body.files[0].fileId as string;

    const response = await request(app)
      .get(`/v1/download/${sid}/${fileId}`)
      .query({ kind: 'user', id: 'user-1' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toBe('a,b\n1,2\n');
  });

  it('GET /download without identity query 400s (sessionAuth mirror)', async () => {
    const upload = await uploadOne();
    const response = await request(app).get(
      `/v1/download/${upload.body.storage_session_id}/${upload.body.files[0].fileId}`,
    );
    expect(response.status).toBe(400);
  });

  it('GET /sessions/:sid/objects/:fid returns lastModified (process.js getSessionInfo)', async () => {
    const upload = await uploadOne();
    const response = await request(app)
      .get(`/v1/sessions/${upload.body.storage_session_id}/objects/${upload.body.files[0].fileId}`)
      .query({ kind: 'user', id: 'user-1' });
    expect(response.status).toBe(200);
    expect(new Date(response.body.lastModified as string).getTime()).not.toBeNaN();
    expect(response.body.size).toBe(8);
  });

  it('objects probe 404s after expiry — the designed TTL-recovery path', async () => {
    const response = await request(app)
      .get(`/v1/sessions/karl-${'0'.repeat(32)}/objects/11111111-1111-4111-8111-111111111111`)
      .query({ kind: 'user', id: 'user-1' });
    expect(response.status).toBe(404);
  });

  it('DELETE primary + fallback alias behave identically (crud.js dual-path)', async () => {
    const first = await uploadOne();
    const sid1 = first.body.storage_session_id as string;
    const fid1 = first.body.files[0].fileId as string;
    const primary = await request(app)
      .delete(`/v1/sessions/${sid1}/objects/${fid1}`)
      .query({ kind: 'user', id: 'user-1' });
    expect(primary.status).toBe(200);
    expect(primary.body.message).toBe('success');

    const second = await uploadOne();
    const sid2 = second.body.storage_session_id as string;
    const fid2 = second.body.files[0].fileId as string;
    const fallback = await request(app)
      .delete(`/v1/files/${sid2}/${fid2}`)
      .query({ kind: 'user', id: 'user-1' });
    expect(fallback.status).toBe(200);

    // second delete → 404, which crud.js treats as success (idempotent)
    const gone = await request(app)
      .delete(`/v1/sessions/${sid1}/objects/${fid1}`)
      .query({ kind: 'user', id: 'user-1' });
    expect(gone.status).toBe(404);

    expect(blob.blobs.size).toBe(0);
  });
});
