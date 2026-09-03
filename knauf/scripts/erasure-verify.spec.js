// [knauf] KK20-TBD — pins the erasure verifier's pure logic and the two facts the runbook
// relies on. Run with:
//   npm run test:erasure
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  RETAINED_BY_DESIGN,
  parseArgs,
  extractBlobPath,
  buildLangfuseDeleteBatches,
  resolveLangfuseBaseUrl,
  evaluate,
  renderReport,
} = require('./erasure-verify');

const read = (...p) => fs.readFileSync(path.resolve(__dirname, '..', '..', ...p), 'utf8');

describe('the paths under test are the real ones', () => {
  test('account deletion is the JWT-guarded DELETE /api/user/delete', () => {
    const routes = read('api', 'server', 'routes', 'user.js');
    assert.match(
      routes,
      /router\.delete\('\/delete', requireJwtAuth, canDeleteAccount, .*deleteUserController\)/,
    );
  });

  test('deleteUserController reaches Blob + vectors via processDeleteRequest; config/delete-user.js does not', () => {
    // The recipe verifies the product path because it is the only one that is
    // erasure-complete. If someone teaches the ops script to call the cascade, this
    // test fails and runbook §4 must be updated.
    const controller = read('api', 'server', 'controllers', 'UserController.js');
    assert.match(controller, /processDeleteRequest\(/);
    assert.match(controller, /deleteUserFiles\(req\)/);
    const opsScript = read('config', 'delete-user.js');
    assert.doesNotMatch(opsScript, /processDeleteRequest|deleteVectors|getAzureContainerClient/);
    assert.match(
      opsScript,
      /File\.deleteMany\(/,
      'ops script drops File rows without deleting bytes',
    );
  });

  test('the per-chat path cascades files, tool calls and shared links', () => {
    const convos = read('api', 'server', 'routes', 'convos.js');
    assert.match(convos, /deleteConvosWithCleanup\(\{ req, filter \}\)/);
    assert.match(
      convos,
      /deleteConvoSharedLinksWithCleanup\(req\.user\.id, filter\.conversationId\)/,
    );
  });
});

describe('blob path mirrors the delete path', () => {
  test('strips the SAS query string and anchors on the container segment', () => {
    assert.equal(
      extractBlobPath('https://acct.blob.core.windows.net/files/u1/f.pdf?sv=1&sig=abc', 'files'),
      'u1/f.pdf',
    );
  });
  test('resolves path-style (Azurite) URLs', () => {
    assert.equal(
      extractBlobPath('http://127.0.0.1:10000/devstoreaccount1/files/u1/f.pdf', 'files'),
      'u1/f.pdf',
    );
  });
  test('falls back to strip-first-segment on container mismatch, like crud.js', () => {
    assert.equal(
      extractBlobPath('https://acct.blob.core.windows.net/other/u1/f.pdf', 'files'),
      'u1/f.pdf',
    );
  });
  test('returns null on garbage', () => {
    assert.equal(extractBlobPath('not a url', 'files'), null);
    assert.equal(extractBlobPath('https://acct.blob.core.windows.net/files', 'files'), null);
  });
});

describe('langfuse leg', () => {
  test('batch body is { traceIds } and ids are deduplicated and chunked', () => {
    const ids = Array.from({ length: 205 }, (_, i) => `t${i}`).concat(['t0', 't1']);
    const batches = buildLangfuseDeleteBatches(ids, 100);
    assert.equal(batches.length, 3);
    assert.deepEqual(Object.keys(batches[0]), ['traceIds']);
    assert.equal(batches[0].traceIds.length, 100);
    assert.equal(batches[2].traceIds.length, 5);
    assert.equal(new Set(batches.flatMap((b) => b.traceIds)).size, 205);
  });
  test('base url resolution matches feedback.ts precedence and trims the slash', () => {
    assert.equal(resolveLangfuseBaseUrl({ LANGFUSE_HOST: 'https://a/' }), 'https://a');
    assert.equal(
      resolveLangfuseBaseUrl({ LANGFUSE_BASE_URL: 'https://b', LANGFUSE_HOST: 'https://a' }),
      'https://b',
    );
    assert.equal(resolveLangfuseBaseUrl({}), '');
  });
});

describe('verdict', () => {
  const clean = {
    generatedAt: 'now',
    users: 0,
    mongo: { Message: 0, Conversation: 0, File: 0 },
    raw: { knauf_agent_schedules: 0 },
    auditlogs: 0,
    meili: { messages: 0, convos: 0 },
    blob: { existing: 0, paths: [] },
    rag: { pgvector: 0, azureAiSearch: 0 },
    langfuse: { traces: 0, scores: 0 },
  };

  test('all zero ⇒ ok', () => {
    const e = evaluate(clean);
    assert.equal(e.ok, true);
    assert.deepEqual(e.residuals, []);
  });

  test('auditlogs residual is allowed with its Art. 17(3) reason; a Message residual is not', () => {
    const e = evaluate({ ...clean, auditlogs: 4, mongo: { ...clean.mongo, Message: 2 } });
    assert.equal(e.ok, false);
    const audit = e.residuals.find((r) => r.sink === 'auditlogs');
    assert.equal(audit.allowed, true);
    assert.equal(audit.reason, RETAINED_BY_DESIGN.auditlogs);
    assert.deepEqual(
      e.failing.map((r) => r.sink),
      ['Message'],
    );
  });

  test('surviving user doc, blob, vector hit or Langfuse trace each fail the run', () => {
    for (const patch of [
      { users: 1 },
      { blob: { existing: 1, paths: ['u/f'] } },
      { rag: { pgvector: 1, azureAiSearch: 0 } },
      { langfuse: { traces: 1, scores: 0 } },
      { meili: { messages: 3, convos: 0 } },
    ]) {
      const e = evaluate({ ...clean, ...patch });
      assert.equal(e.ok, false, JSON.stringify(patch));
      assert.equal(e.failing.length, 1, JSON.stringify(patch));
    }
  });

  test('"not probed" is never counted as clean', () => {
    const e = evaluate({ ...clean, rag: { pgvector: 'RAG_API_URL unset', azureAiSearch: 0 } });
    assert.equal(e.ok, false);
    assert.deepEqual(e.failing, []);
    assert.deepEqual(e.unprobed, [{ sink: 'pgvector', detail: 'RAG_API_URL unset' }]);
  });

  test('report names the verdict and the retained-by-design basis', () => {
    const before = {
      ...clean,
      subject: { _id: 'u1', email: 'a@b.c' },
      mongo: { ...clean.mongo, Message: 9 },
      auditlogs: 4,
    };
    const after = { ...clean, auditlogs: 4 };
    const md = renderReport({ before, after, evaluation: evaluate(after) });
    assert.match(md, /Verdict: \*\*CLEAN\*\*/);
    assert.match(md, /\| Message \| 9 \| 0 \| clean \|/);
    assert.match(md, /\| auditlogs \| 4 \| 4 \| retained by design — Art\. 17\(3\)/);
    assert.match(md, /winstonLogs/);
  });
});

describe('cli', () => {
  test('parses phases, skips and confirm', () => {
    const a = parseArgs([
      '--phase',
      'after',
      '--out',
      './o',
      '--skip',
      'meili,rag',
      '--confirm',
      '--tenant',
      't',
    ]);
    assert.deepEqual(a, {
      phase: 'after',
      out: './o',
      skip: ['meili', 'rag'],
      confirm: true,
      tenant: 't',
    });
    assert.deepEqual(parseArgs(['--phase', 'before']).skip, []);
    assert.equal(parseArgs([]).confirm, false);
  });
});
// End [knauf]
