// [knauf] KK20-350 — pins the erasure verifier. Run with:
//   npm run test:erasure
//
// PR #350 review asked for adversarial tests proving that none of the false-CLEAN
// paths can produce CLEAN or exit 0. Every `describe('cannot be CLEAN …')` block below
// starts from ONE fully resolved fixture that does reach CLEAN (so the tests are not
// vacuous), breaks exactly one thing, and asserts the verdict and exit code.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const v = require('./erasure-verify');

const read = (...p) => fs.readFileSync(path.resolve(__dirname, '..', '..', ...p), 'utf8');

/* ------------------------------------------------------------------ fixtures */

const APPROVED = { approvedBy: 'dpo@knauf.test', approvedAt: '2026-09-20' };
const SUBJECT = 'a'.repeat(24);
const T0 = '2026-09-24T10:00:00.000Z';
const T1 = '2026-09-24T11:00:00.000Z';
const NOW = Date.parse(T1);
const SIGNALS = {
  meili: true,
  'vectors:pgvector': true,
  'vectors:azureAiSearch': true,
  langfuse: true,
  'redis:keys': true,
  'logs:files': false,
  'blob:primary': true,
  'translation:scratch': true,
  'files:execute_code': true,
  'code:table': true,
};
/** What the RAG adapter (v2) reports as the storage behind each backend. */
const STORAGE = {
  pgvector: {
    backend: 'pgvector',
    host: 'pg',
    port: '5432',
    database: 'vectors',
    schema: null,
    collection: 'chunks',
  },
  azure_search: {
    backend: 'azure_search',
    endpoint: 'https://s.search.windows.net',
    index: 'documents-index',
  },
};
/** The non-secret storage identities a baseline records (review round 2). */
const backendsFixture = () => ({
  mongo: { hosts: ['mongo:27017'], database: 'LibreChat' },
  meili: { endpoint: 'http://meili:7700' },
  ragApi: { endpoint: 'http://rag:8000' },
  langfuse: { baseUrl: 'https://lf', projectId: 'proj-A' },
  redis: { hosts: ['redis:6379'], db: '0' },
  'container:primary': { url: 'https://acct.blob.core.windows.net/files' },
  'vectors:pgvector': { ...STORAGE.pgvector },
  'vectors:azureAiSearch': { ...STORAGE.azure_search },
});

function resolvedManifest() {
  const sinks = v.probedSinkKeys().map((key) => {
    if (key === 'mongo:auditlogs') {
      return {
        key,
        configured: true,
        disposition: 'retained',
        basis: 'Art. 17(3)(b)',
        expiry: '12 months',
        ...APPROVED,
      };
    }
    if (key === 'logs:files') return { key, configured: false, disposition: 'deleted' };
    if (key === 'translation:scratch') {
      return {
        key,
        configured: true,
        disposition: 'eventually-deleted',
        deadline: 'P8D',
        basis: 'lifecycle rule + soft delete',
        lifecycleWindow: 'P1D',
        baseline: { exempt: 'NOT_SUBJECT_ADDRESSABLE', note: 'no subject key', ...APPROVED },
        ...APPROVED,
      };
    }
    if (key === 'files:execute_code') {
      return {
        key,
        configured: true,
        container: 'code-adapter-test',
        disposition: 'eventually-deleted',
        deadline: 'P1D',
        basis: 'adapter TTL',
        baseline: 'required',
        ...APPROVED,
      };
    }
    return { key, configured: true, disposition: 'deleted', baseline: 'required' };
  });
  sinks.push(
    {
      key: 'code:table',
      configured: true,
      disposition: 'eventually-deleted',
      deadline: 'P1D',
      basis: 'adapter TTL',
      ...APPROVED,
    },
    {
      key: 'backup:mongo',
      configured: true,
      disposition: 'eventually-deleted',
      deadline: 'P35D',
      basis: 'backup rotation',
      ...APPROVED,
    },
    {
      key: 'idp:entra',
      configured: true,
      disposition: 'externally-controlled',
      controller: 'Knauf IAM',
      notification: 'route to IAM',
      ...APPROVED,
    },
  );
  return { manifestVersion: 1, environment: 'test', revision: 't-1', sinks };
}

const okResult = (key, count, detail) =>
  v.probeResult(key, 'ok', { count, exact: true, method: 'test', detail });

function sinksWith(count) {
  const sinks = {};
  for (const key of v.probedSinkKeys()) {
    sinks[key] =
      key === 'logs:files' ? v.probeResult(key, 'not-configured', {}) : okResult(key, count);
  }
  sinks['mongo:auditlogs'] = okResult('mongo:auditlogs', 4);
  return sinks;
}

function run({ beforeCount = 3, afterCount = 0 } = {}) {
  const identity = {
    _id: SUBJECT,
    tenantId: 't1',
    resolvedBy: 'canonical-id',
    tenantAsserted: 't1',
    evidenceGrade: true,
    digest: 'id-digest',
  };
  const before = {
    kind: v.EVIDENCE_KIND,
    schemaVersion: v.SCHEMA_VERSION,
    phase: 'before',
    mode: 'evidence',
    runId: 'run-1',
    generatedAt: T0,
    environment: 'test',
    identity,
    envSignals: { ...SIGNALS },
    backends: backendsFixture(),
    inventory: { nonBlobPointers: {} },
    sinks: sinksWith(beforeCount),
  };
  const after = {
    kind: v.EVIDENCE_KIND,
    schemaVersion: v.SCHEMA_VERSION,
    phase: 'after',
    mode: 'evidence',
    runId: 'run-1',
    generatedAt: T1,
    environment: 'test',
    envSignals: { ...SIGNALS },
    backends: backendsFixture(),
    sinks: sinksWith(afterCount),
  };
  const langfuseDelete = {
    runId: 'run-1',
    identityDigest: 'id-digest',
    projectId: 'proj-A',
    requestedAt: '2026-09-24T10:10:00.000Z',
    traces: 3,
  };
  return { manifest: resolvedManifest(), before, after, langfuseDelete, now: NOW };
}

const verdictOf = (input) => v.evaluate(input);

function assertNotClean(input, expected) {
  const e = verdictOf(input);
  assert.notEqual(e.verdict, 'CLEAN');
  assert.notEqual(v.exitCodeFor(e.verdict), 0);
  if (expected) assert.equal(e.verdict, expected);
  return e;
}

const entry = (manifest, key) => manifest.sinks.find((s) => s.key === key);

/* ------------------------------------------------------------------ baseline */

describe('the resolved fixture reaches CLEAN — so every failure below is meaningful', () => {
  test('all mandatory sinks seeded, all zero after, approvals present ⇒ CLEAN, exit 0', () => {
    const e = verdictOf(run());
    assert.deepEqual(e.blockers, []);
    assert.equal(e.verdict, 'CLEAN');
    assert.equal(v.exitCodeFor(e.verdict), 0);
    const status = (k) => e.rows.find((r) => r.key === k).status;
    assert.equal(status('mongo:Message'), 'DELETED');
    assert.match(status('mongo:auditlogs'), /^RETAINED — Art\. 17\(3\)\(b\); expiry 12 months/);
    assert.equal(status('logs:files'), 'NOT CONFIGURED');
    assert.match(status('backup:mongo'), /^EVENTUALLY DELETED — by 2026-10-29/);
    assert.match(status('idp:entra'), /^EXTERNALLY CONTROLLED — Knauf IAM/);
    assert.match(status('translation:scratch'), /^EVENTUALLY DELETED — not searchable per subject/);
    assert.deepEqual(e.obligations.map((o) => o.key).sort(), [
      'backup:mongo',
      'code:table',
      'idp:entra',
      'translation:scratch',
    ]);
  });
});

/* ------------------------------------------------------------------ review point 2 */

describe('cannot be CLEAN — a sink without a usable result (review: skipped probes vanish)', () => {
  test('a sink ABSENT from the after snapshot blocks, it does not disappear', () => {
    const input = run();
    delete input.after.sinks['vectors:azureAiSearch'];
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.match(
      e.rows.find((r) => r.key === 'vectors:azureAiSearch').status,
      /absent from the snapshot/,
    );
  });

  test('absent from the BEFORE snapshot blocks too', () => {
    const input = run();
    delete input.before.sinks['meili:messages'];
    assertNotClean(input, 'INCOMPLETE');
  });

  for (const status of ['skipped', 'not-probed', 'error', 'inexact', 'not-configured']) {
    test(`a "${status}" result blocks`, () => {
      const input = run();
      input.after.sinks['blob:primary'] = v.probeResult('blob:primary', status, { reason: 'test' });
      assertNotClean(input, 'INCOMPLETE');
    });
  }

  test('a hand-built failure claiming count 0 and exact still blocks on its status', () => {
    const input = run();
    input.after.sinks['vectors:pgvector'] = {
      key: 'vectors:pgvector',
      status: 'error',
      count: 0,
      exact: true,
    };
    assertNotClean(input, 'INCOMPLETE');
  });

  test('an ok result that is not exact blocks', () => {
    const input = run();
    input.after.sinks['redis:keys'] = { ...okResult('redis:keys', 0), exact: false };
    assertNotClean(input, 'INCOMPLETE');
  });

  test('a probed key missing from the manifest is UNKNOWN, not skipped', () => {
    const input = run();
    input.manifest.sinks = input.manifest.sinks.filter((s) => s.key !== 'redis:keys');
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.match(
      e.rows.find((r) => r.key === 'redis:keys').status,
      /UNKNOWN — not in the manifest/,
    );
  });
});

/* ------------------------------------------------------------------ review point 3 */

describe('cannot be CLEAN — no before → after transition (review: all-zero baseline passes)', () => {
  test('an all-zero baseline blocks every mandatory sink with NO BASELINE', () => {
    const e = assertNotClean(run({ beforeCount: 0 }), 'INCOMPLETE');
    const noBaseline = e.rows.filter((r) => r.status === 'NO BASELINE').map((r) => r.key);
    assert.ok(noBaseline.includes('mongo:Message'));
    assert.ok(noBaseline.includes('vectors:pgvector'));
    assert.ok(noBaseline.includes('langfuse:traces'));
  });

  test('one zero baseline is enough to block', () => {
    const input = run();
    input.before.sinks['mongo:MemoryEntry'] = okResult('mongo:MemoryEntry', 0);
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.equal(e.rows.find((r) => r.key === 'mongo:MemoryEntry').status, 'NO BASELINE');
  });

  test('a PROPOSED exemption does not resolve it; an APPROVED, reason-coded one does', () => {
    const input = run();
    input.before.sinks['mongo:Preset'] = okResult('mongo:Preset', 0);
    entry(input.manifest, 'mongo:Preset').baseline = {
      exempt: 'FEATURE_DISABLED_IN_ENVIRONMENT',
      note: 'presets off',
      approvedBy: null,
      approvedAt: null,
    };
    assertNotClean(input, 'INCOMPLETE');
    Object.assign(entry(input.manifest, 'mongo:Preset').baseline, APPROVED);
    const e = verdictOf(input);
    assert.equal(e.verdict, 'CLEAN');
    assert.match(
      e.rows.find((r) => r.key === 'mongo:Preset').status,
      /^N\/A — FEATURE_DISABLED_IN_ENVIRONMENT/,
    );
  });

  test('an exemption with an unknown reason code is a structural problem', () => {
    const m = resolvedManifest();
    entry(m, 'mongo:Preset').baseline = { exempt: 'BECAUSE', note: 'x', ...APPROVED };
    assert.ok(v.structuralProblems(m, 'test').some((p) => p.key === 'mongo:Preset'));
  });
});

/* ------------------------------------------------------------------ residuals */

describe('residuals', () => {
  test('any residual in a deleted sink ⇒ RESIDUALS FOUND, exit 3', () => {
    const input = run();
    input.after.sinks['mongo:ChatProject'] = okResult('mongo:ChatProject', 2);
    const e = assertNotClean(input, 'RESIDUALS FOUND');
    assert.equal(v.exitCodeFor(e.verdict), 3);
    assert.deepEqual(e.residuals, [{ key: 'mongo:ChatProject', count: 2 }]);
  });

  test('an eventually-deleted probed sink is resolved inside its deadline and a residual after it', () => {
    const input = run();
    Object.assign(entry(input.manifest, 'redis:keys'), {
      disposition: 'eventually-deleted',
      deadline: 'PT6H',
      basis: 'TTL',
      ...APPROVED,
    });
    input.after.sinks['redis:keys'] = okResult('redis:keys', 5);
    assert.equal(verdictOf(input).verdict, 'CLEAN');
    input.now = Date.parse(T0) + 7 * 60 * 60 * 1000;
    input.after.generatedAt = new Date(input.now).toISOString();
    assertNotClean(input, 'RESIDUALS FOUND');
  });
});

/* ------------------------------------------------------------------ review point 5 (blob) */

describe('Blob lifecycle classes', () => {
  /** Soft-deleted during the run: the product deletion at 10:10. */
  const DELETED_IN_RUN = '2026-09-24T10:10:00.000Z';
  const startsAt = (at) => ({ softDeleted: { oldest: at, newest: at, undated: 0 } });
  const blob = (classes, lifecycleStarts = startsAt(DELETED_IN_RUN)) =>
    okResult(
      'blob:primary',
      Object.values(classes).reduce((a, b) => a + b, 0),
      {
        classes: { current: 0, versions: 0, snapshots: 0, softDeleted: 0, ...classes },
        lifecycleStarts,
      },
    );

  test('soft-deleted copies resolve only under an APPROVED eventualClasses policy and inside its window', () => {
    const input = run();
    input.after.sinks['blob:primary'] = blob({ softDeleted: 2 });
    assertNotClean(input, 'RESIDUALS FOUND');

    entry(input.manifest, 'blob:primary').eventualClasses = { softDeleted: 'P7D' };
    assertNotClean(input, 'INCOMPLETE'); // proposed, not approved
    Object.assign(entry(input.manifest, 'blob:primary'), APPROVED);
    const e = verdictOf(input);
    assert.equal(e.verdict, 'CLEAN');
    assert.match(
      e.rows.find((r) => r.key === 'blob:primary').status,
      /^EVENTUALLY DELETED — softDeleted expire by 2026-10-01/,
    );

    // Seven days after the copy's own deletion it is overdue.
    input.now = Date.parse('2026-10-02T00:00:00.000Z');
    assertNotClean(input, 'RESIDUALS FOUND');
  });

  test('final review · a copy soft-deleted long before the run is overdue now, however fresh the baseline', () => {
    const input = run();
    Object.assign(entry(input.manifest, 'blob:primary'), {
      eventualClasses: { softDeleted: 'P7D' },
      ...APPROVED,
    });
    input.after.sinks['blob:primary'] = blob({ softDeleted: 1 }, startsAt('2026-09-04T10:00:00Z'));
    const e = assertNotClean(input, 'RESIDUALS FOUND');
    assert.match(
      e.blockers.find((b) => b.key === 'blob:primary').text,
      /outlived their lifecycle window/,
    );
    // A copy whose clock cannot be read is overdue too, alone or next to a dated one.
    input.after.sinks['blob:primary'] = blob(
      { softDeleted: 1 },
      { softDeleted: { oldest: null, newest: null, undated: 1 } },
    );
    assertNotClean(input, 'RESIDUALS FOUND');
    input.after.sinks['blob:primary'] = blob(
      { softDeleted: 2 },
      { softDeleted: { oldest: DELETED_IN_RUN, newest: DELETED_IN_RUN, undated: 1 } },
    );
    assertNotClean(input, 'RESIDUALS FOUND');
    input.after.sinks['blob:primary'] = blob({ softDeleted: 1 }, {});
    assertNotClean(input, 'RESIDUALS FOUND');
  });

  test('final review · an eventually-deleted store with an expiring class keeps its live copies to its own deadline', () => {
    const input = run();
    Object.assign(entry(input.manifest, 'files:execute_code'), {
      deadline: 'PT26H',
      eventualClasses: { softDeleted: 'P7D' },
    });
    input.after.sinks['files:execute_code'] = okResult('files:execute_code', 2, {
      classes: { current: 1, versions: 0, snapshots: 0, softDeleted: 1 },
      lifecycleStarts: startsAt(DELETED_IN_RUN),
    });
    const e = verdictOf(input);
    assert.equal(e.verdict, 'CLEAN');
    assert.match(
      e.rows.find((r) => r.key === 'files:execute_code').status,
      /^EVENTUALLY DELETED — 2 left, due by 2026-09-25/,
    );
    assert.match(
      e.obligations.find((o) => o.key === 'files:execute_code').text,
      /confirm gone after 2026-09-25T13:00:00\.000Z; its soft-deleted\/versioned copies then expire within P7D \(softDeleted\)/,
    );
  });

  test('a live object or a snapshot is always a residual, whatever the policy', () => {
    for (const classes of [{ current: 1 }, { snapshots: 1 }]) {
      const input = run();
      Object.assign(entry(input.manifest, 'blob:primary'), {
        eventualClasses: { softDeleted: 'P7D' },
        ...APPROVED,
      });
      input.after.sinks['blob:primary'] = blob(classes);
      assertNotClean(input, 'RESIDUALS FOUND');
    }
  });
});

/* ------------------------------------------------------------------ review point 6 (manifest) */

describe('cannot be CLEAN — the manifest does not resolve a store (review: "every copy" claim)', () => {
  test('configured "unknown" blocks', () => {
    const input = run();
    entry(input.manifest, 'backup:mongo').configured = 'unknown';
    assertNotClean(input, 'INCOMPLETE');
  });

  test('a declared not-probed store blocks', () => {
    const input = run();
    input.manifest.sinks.push({
      key: 'langfuse:eventStorage',
      configured: true,
      disposition: 'not-probed',
      reason: 'unknown',
    });
    assertNotClean(input, 'INCOMPLETE');
  });

  for (const key of ['mongo:auditlogs', 'backup:mongo', 'idp:entra']) {
    test(`an unapproved ${entry(resolvedManifest(), key).disposition} disposition blocks (${key})`, () => {
      const input = run();
      Object.assign(entry(input.manifest, key), { approvedBy: null, approvedAt: null });
      assertNotClean(input, 'INCOMPLETE');
    });
  }

  test('configured:false contradicted by the environment is drift, not N/A', () => {
    const input = run();
    entry(input.manifest, 'redis:keys').configured = false;
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.match(e.rows.find((r) => r.key === 'redis:keys').status, /drift/);
  });

  test('the inventory proving a store the manifest omits blocks', () => {
    const input = run();
    input.before.inventory.nonBlobPointers = { local: 2 };
    assertNotClean(input, 'INCOMPLETE');
    input.manifest.sinks.push({
      key: 'files:local',
      configured: false,
      disposition: 'not-probed',
      reason: 'azure_blob only',
    });
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.match(e.rows.find((r) => r.key === 'files:local').status, /inventory holds data here/);
  });

  test('"deleted" on a store no probe covers is refused as unsatisfiable', () => {
    const m = resolvedManifest();
    m.sinks.push({ key: 'backup:blob', configured: true, disposition: 'deleted' });
    assert.ok(v.structuralProblems(m, 'test').some((p) => p.key === 'backup:blob'));
  });

  test('required fields per disposition and ISO durations are enforced', () => {
    const m = resolvedManifest();
    delete entry(m, 'mongo:auditlogs').expiry;
    entry(m, 'backup:mongo').deadline = 'P1M'; // months are ambiguous
    delete entry(m, 'idp:entra').notification;
    const keys = v.structuralProblems(m, 'test').map((p) => p.key);
    assert.ok(keys.includes('mongo:auditlogs'));
    assert.ok(keys.includes('backup:mongo'));
    assert.ok(keys.includes('idp:entra'));
  });

  test('preflight lists every blocker an evidence baseline would inherit', () => {
    const m = resolvedManifest();
    Object.assign(entry(m, 'idp:entra'), { approvedBy: null });
    m.sinks.push({
      key: 'backup:blob',
      configured: 'unknown',
      disposition: 'not-probed',
      reason: 'r',
    });
    const problems = v.preflight(m, { envName: 'test', signals: SIGNALS });
    assert.equal(problems.length, 2);
    assert.deepEqual(v.preflight(resolvedManifest(), { envName: 'test', signals: SIGNALS }), []);
  });
});

/* ------------------------------------------------------------------ run bindings */

describe('cannot be CLEAN — stale, rebound or non-evidence runs', () => {
  test('a baseline older than 24 h is stale', () => {
    const input = run();
    input.after.generatedAt = new Date(Date.parse(T0) + v.MAX_BASELINE_AGE_MS + 1000).toISOString();
    input.now = Date.parse(input.after.generatedAt);
    assertNotClean(input, 'INCOMPLETE');
  });

  test('an after snapshot earlier than its baseline blocks', () => {
    const input = run();
    input.after.generatedAt = '2026-09-24T09:00:00.000Z';
    assertNotClean(input, 'INCOMPLETE');
  });

  test('the environment changing between phases blocks', () => {
    const input = run();
    input.after.envSignals['redis:keys'] = false;
    assertNotClean(input, 'INCOMPLETE');
  });

  test('an after snapshot from another run blocks', () => {
    const input = run();
    input.after.runId = 'run-2';
    assertNotClean(input, 'INCOMPLETE');
  });

  test('an identity that is not evidence-grade (email lookup, no tenant) blocks', () => {
    const input = run();
    input.before.identity = {
      ...input.before.identity,
      evidenceGrade: false,
      resolvedBy: 'reference',
    };
    assertNotClean(input, 'INCOMPLETE');
  });

  test('rehearsal mode is never evidence, even when everything is clean', () => {
    const input = run();
    input.before.mode = 'rehearsal';
    const e = assertNotClean(input, 'NOT EVIDENCE');
    assert.equal(v.exitCodeFor(e.verdict), 5);
  });
});

/* ------------------------------------------------------------------ Langfuse */

describe('Langfuse settle window and binding', () => {
  test('traces still present inside the 15-minute window ⇒ PENDING, not CLEAN', () => {
    const input = run();
    input.after.sinks['langfuse:traces'] = okResult('langfuse:traces', 3);
    input.langfuseDelete.requestedAt = new Date(NOW - 5 * 60 * 1000).toISOString();
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.match(e.rows.find((r) => r.key === 'langfuse:traces').status, /^PENDING/);
  });

  test('traces still present after the window ⇒ RESIDUAL', () => {
    const input = run();
    input.after.sinks['langfuse:traces'] = okResult('langfuse:traces', 3);
    assertNotClean(input, 'RESIDUALS FOUND');
  });

  test('traces present and no deletion requested ⇒ RESIDUAL naming the missing phase', () => {
    const input = run();
    input.after.sinks['langfuse:traces'] = okResult('langfuse:traces', 3);
    input.langfuseDelete = null;
    const e = assertNotClean(input, 'RESIDUALS FOUND');
    assert.match(e.rows.find((r) => r.key === 'langfuse:traces').status, /langfuse-delete/);
  });

  test('a deletion record from another run or identity blocks', () => {
    const input = run();
    input.langfuseDelete.identityDigest = 'someone-else';
    assertNotClean(input, 'INCOMPLETE');
  });
});

/* ------------------------------------------------------------------ probes: RAG (review point 1) */

function fakeResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function ragPage({
  backend = 'pgvector',
  key = 'asset_id',
  total,
  groups,
  next = null,
  exact = true,
  adapter = v.RAG_ADAPTER,
  storage = STORAGE[backend],
}) {
  return {
    adapter,
    adapter_version: 2,
    backend,
    key,
    exact,
    inexact_reason: exact ? null : 'moved',
    total_chunks: total,
    groups,
    storage,
    next_cursor: next,
  };
}

const INVENTORY = {
  vectorIds: ['asset-1', 'asset-2'],
  agentIds: ['agent_1'],
  blobPointers: [],
  containerName: 'files',
};
const IDENTITY = { _id: SUBJECT };

describe('vector probes use the exact adapter, never semantic search', () => {
  const env = { RAG_API_URL: 'http://rag' };

  test('scans by asset id and owner, pages to exhaustion, and never touches a query route', async () => {
    const calls = [];
    let minted = 0;
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (body.key === 'asset_id' && !body.cursor) {
        return fakeResponse(
          200,
          ragPage({
            total: 3,
            groups: [{ match: 'asset-1', generation: 1, chunks: 2 }],
            next: 'c1',
          }),
        );
      }
      if (body.key === 'asset_id')
        return fakeResponse(
          200,
          ragPage({ total: 3, groups: [{ match: 'asset-2', generation: null, chunks: 1 }] }),
        );
      return fakeResponse(200, ragPage({ key: 'user_id', total: 0, groups: [] }));
    };
    const r = await v.probeVectors({
      backend: 'pgvector',
      identity: IDENTITY,
      inventory: INVENTORY,
      env,
      fetchImpl,
      mintToken: () => `t${++minted}`,
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.count, 3);
    assert.ok(calls.every((c) => c.url === 'http://rag/verification/vectors'));
    assert.ok(calls.every((c) => !/query/i.test(c.url)));
    assert.deepEqual(
      calls.map((c) => c.body.key),
      ['asset_id', 'asset_id', 'user_id'],
    );
    assert.deepEqual(calls[2].body.values, [SUBJECT, 'agent_1']);
    assert.equal(minted, 3, 'one short-lived token per request');
  });

  test('Azure AI Search additionally scans the authored agents as entity ids', async () => {
    const keys = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      keys.push(body.key);
      return fakeResponse(
        200,
        ragPage({ backend: 'azure_search', key: body.key, total: 0, groups: [] }),
      );
    };
    const r = await v.probeVectors({
      backend: 'azure_search',
      identity: IDENTITY,
      inventory: INVENTORY,
      env,
      fetchImpl,
      mintToken: () => 't',
    });
    assert.equal(r.status, 'ok');
    assert.deepEqual(keys, ['asset_id', 'entity_id', 'user_id']);
  });

  const failing = [
    ['adapter not deployed (404)', async () => fakeResponse(404, {}), 'not-probed'],
    ['backend unavailable (503)', async () => fakeResponse(503, {}), 'not-probed'],
    ['server error', async () => fakeResponse(500, {}), 'error'],
    [
      'network failure',
      async () => {
        throw new Error('ECONNREFUSED');
      },
      'error',
    ],
    [
      'adapter says inexact',
      async () => fakeResponse(200, ragPage({ total: 1, groups: [{ chunks: 1 }], exact: false })),
      'inexact',
    ],
    [
      'groups do not sum to the total',
      async () => fakeResponse(200, ragPage({ total: 5, groups: [{ chunks: 1 }] })),
      'inexact',
    ],
    [
      'some other service answered',
      async () => fakeResponse(200, ragPage({ total: 0, groups: [], adapter: 'other' })),
      'not-probed',
    ],
  ];
  for (const [name, fetchImpl, status] of failing) {
    test(`${name} ⇒ ${status}, never a zero count`, async () => {
      const r = await v.probeVectors({
        backend: 'pgvector',
        identity: IDENTITY,
        inventory: INVENTORY,
        env,
        fetchImpl,
        mintToken: () => 't',
      });
      assert.equal(r.status, status);
      assert.equal(r.count, null);
    });
  }

  test('a total that moves between pages ⇒ inexact', async () => {
    let n = 0;
    const fetchImpl = async () =>
      fakeResponse(
        200,
        ragPage({ total: n++ === 0 ? 4 : 3, groups: [{ chunks: 1 }], next: n === 1 ? 'c' : null }),
      );
    const r = await v.probeVectors({
      backend: 'pgvector',
      identity: IDENTITY,
      inventory: INVENTORY,
      env,
      fetchImpl,
      mintToken: () => 't',
    });
    assert.equal(r.status, 'inexact');
  });

  test('more than 500 ids are split into adapter-sized requests and the totals added', async () => {
    const inventory = { ...INVENTORY, vectorIds: Array.from({ length: 501 }, (_, i) => `a${i}`) };
    const sizes = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.key === 'asset_id') sizes.push(body.values.length);
      return fakeResponse(
        200,
        ragPage({
          key: body.key,
          total: body.key === 'asset_id' ? 1 : 0,
          groups: body.key === 'asset_id' ? [{ chunks: 1 }] : [],
        }),
      );
    };
    const r = await v.probeVectors({
      backend: 'pgvector',
      identity: IDENTITY,
      inventory,
      env,
      fetchImpl,
      mintToken: () => 't',
    });
    assert.deepEqual(sizes, [500, 1]);
    assert.equal(r.count, 2);
  });

  test('RAG_API_URL unset ⇒ not-probed', async () => {
    const r = await v.probeVectors({
      backend: 'pgvector',
      identity: IDENTITY,
      inventory: INVENTORY,
      env: {},
      fetchImpl: async () => {
        throw new Error('unreachable');
      },
      mintToken: () => 't',
    });
    assert.equal(r.status, 'not-probed');
  });
});

/* ------------------------------------------------------------------ probes: Blob (review point 5) */

function fakeContainer(objectsByPrefix, calls = []) {
  return {
    listBlobsFlat(options) {
      calls.push(options);
      const items = Object.entries(objectsByPrefix)
        .filter(([name]) => name.startsWith(options.prefix))
        .map(([name, extra]) => ({ name, ...extra }));
      return {
        byPage() {
          // two pages, to prove pagination is consumed
          const pages = [
            { segment: { blobItems: items.slice(0, 1) } },
            { segment: { blobItems: items.slice(1) } },
          ];
          return (async function* () {
            yield* pages;
          })();
        },
      };
    },
  };
}

describe('Blob is enumerated from storage, not from Mongo pointers', () => {
  const pointer = `uploads/${SUBJECT}/f1__report.pdf`;

  test('finds an orphan no Mongo row points at, and every lifecycle class', async () => {
    const calls = [];
    // Shapes as the service emits them: only the CURRENT version is marked
    // `isCurrentVersion: true`; a previous version carries no such field.
    const container = fakeContainer(
      {
        [pointer]: { versionId: '2026-09-02T00:00:00.0000000Z', isCurrentVersion: true },
        [`images/${SUBJECT}/avatar-1.png`]: {}, // avatar — no File row
        [`uploads/${SUBJECT}/old.pdf`]: { versionId: '2026-09-01T00:00:00.0000000Z' },
        [`uploads/${SUBJECT}/gone.pdf`]: {
          deleted: true,
          properties: { deletedOn: new Date('2026-09-20T08:00:00Z') },
        },
        [`documents/${SUBJECT}/x.docx`]: { snapshot: '2026-09-01' },
        [`uploads/someone-else/f.pdf`]: {},
      },
      calls,
    );
    const r = await v.probeBlob({
      identity: IDENTITY,
      inventory: { ...INVENTORY, blobPointers: [pointer] },
      containerClient: container,
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.count, 5);
    assert.deepEqual(r.detail.classes, { current: 2, versions: 1, snapshots: 1, softDeleted: 1 });
    assert.deepEqual(r.detail.lifecycleStarts, {
      versions: {
        oldest: '2026-09-01T00:00:00.000Z',
        newest: '2026-09-01T00:00:00.000Z',
        undated: 0,
      },
      softDeleted: {
        oldest: '2026-09-20T08:00:00.000Z',
        newest: '2026-09-20T08:00:00.000Z',
        undated: 0,
      },
    });
    assert.equal(r.detail.withoutMongoPointer, 4);
    // Final review: a count and a digest, never the subject's filenames.
    assert.equal(r.detail.objectCount, 5);
    assert.match(r.detail.objectsSha256, /^[a-f0-9]{64}$/);
    const serialised = JSON.stringify(r);
    for (const name of ['report.pdf', 'avatar-1.png', 'old.pdf', 'someone-else']) {
      assert.ok(!serialised.includes(name), name);
    }
    assert.deepEqual(
      calls.map((c) => c.prefix),
      v.BLOB_BASE_PATHS.map((b) => `${b}/${SUBJECT}/`),
    );
    for (const c of calls) {
      assert.equal(c.includeVersions, true);
      assert.equal(c.includeSnapshots, true);
      assert.equal(c.includeDeleted, true);
    }
  });

  test('a pointer outside the canonical layout ⇒ NOT PROBED, even though it was checked by path', async () => {
    const legacy = 'legacy-bucket/f.pdf';
    const container = fakeContainer({ [legacy]: {} });
    const r = await v.probeBlob({
      identity: IDENTITY,
      inventory: { ...INVENTORY, blobPointers: [legacy] },
      containerClient: container,
    });
    assert.equal(r.status, 'not-probed');
    assert.equal(r.detail.classes.current, 1);
  });

  test('final review · a previous version is a version, whatever the SDK leaves unset', () => {
    assert.equal(v.classifyBlobItem({ versionId: 'v1' }), 'versions');
    assert.equal(v.classifyBlobItem({ versionId: 'v1', isCurrentVersion: false }), 'versions');
    assert.equal(v.classifyBlobItem({ versionId: 'v2', isCurrentVersion: true }), 'current');
    assert.equal(v.classifyBlobItem({}), 'current');
    assert.equal(v.classifyBlobItem({ versionId: 'v1', deleted: true }), 'softDeleted');
    assert.equal(v.classifyBlobItem({ snapshot: 's' }), 'snapshots');
  });

  test('no client ⇒ not-probed; a listing failure ⇒ error', async () => {
    assert.equal(
      (await v.probeBlob({ identity: IDENTITY, inventory: INVENTORY, containerClient: null }))
        .status,
      'not-probed',
    );
    const broken = {
      listBlobsFlat() {
        throw new Error('AuthorizationFailure');
      },
    };
    assert.equal(
      (await v.probeBlob({ identity: IDENTITY, inventory: INVENTORY, containerClient: broken }))
        .status,
      'error',
    );
  });
});

describe('blob pointer classification', () => {
  test('mirrors the delete path, and anything outside the container becomes its own store', () => {
    assert.equal(
      v.extractBlobPath('https://acct.blob.core.windows.net/files/u1/f.pdf?sv=1&sig=abc', 'files'),
      'u1/f.pdf',
    );
    assert.equal(
      v.extractBlobPath('http://127.0.0.1:10000/devstoreaccount1/files/u1/f.pdf', 'files'),
      'u1/f.pdf',
    );
    assert.equal(
      v.extractBlobPath('https://acct.blob.core.windows.net/other/u1/f.pdf', 'files'),
      'u1/f.pdf',
    );
    assert.equal(v.extractBlobPath('not a url', 'files'), null);
    assert.deepEqual(
      v.classifyPointer(
        'https://acct.blob.core.windows.net/files/uploads/u/f',
        'azure_blob',
        'files',
      ),
      { kind: 'blob', path: 'uploads/u/f' },
    );
    assert.deepEqual(v.classifyPointer('/images/u/f.png', 'local', 'files'), {
      kind: 'store',
      store: 'local',
    });
    assert.deepEqual(v.classifyPointer('https://graph.microsoft.com/photo', undefined, 'files'), {
      kind: 'store',
      store: 'external',
    });
    assert.deepEqual(v.classifyPointer('x', 'execute_code', 'files'), {
      kind: 'store',
      store: 'execute_code',
    });
    assert.equal(v.classifyPointer('', 'azure_blob', 'files'), null);
  });

  test('final review · a pointer into another container is its own store, not a path in this one', () => {
    // The mirror above strips the first segment exactly as the delete path does, which
    // deletes nothing in `files` and leaves the bytes in `files-old`.
    assert.deepEqual(
      v.classifyPointer(
        `https://acct.blob.core.windows.net/files-old/uploads/${SUBJECT}/f1__x.pdf`,
        'azure_blob',
        'files',
      ),
      { kind: 'store', store: 'other-container' },
    );
    assert.deepEqual(
      v.classifyPointer(
        'https://acct.blob.core.windows.net/other/files/x.pdf',
        'azure_blob',
        'files',
      ),
      { kind: 'store', store: 'other-container' },
    );
    assert.deepEqual(
      v.classifyPointer(
        'http://127.0.0.1:10000/devstoreaccount1/files/uploads/u/f.pdf',
        'azure_blob',
        'files',
      ),
      { kind: 'blob', path: 'uploads/u/f.pdf' },
    );
    const input = run();
    input.before.inventory = v.buildInventory({
      files: [
        {
          file_id: 'f1',
          filepath: `https://acct.blob.core.windows.net/files-old/uploads/${SUBJECT}/f1__x.pdf`,
          source: 'azure_blob',
        },
      ],
      containerName: 'files',
    });
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.ok(e.blockers.some((b) => b.key === 'files:other-container'));
  });

  test('the inventory keeps the ids the after phase needs once the user is gone', () => {
    const inv = v.buildInventory({
      files: [
        {
          file_id: 'f1',
          embedded: true,
          knauf_asset_id: 'asset-1',
          filepath: 'https://a.blob.core.windows.net/files/uploads/u/f1',
          source: 'azure_blob',
        },
        {
          file_id: 'f2',
          embedded: true,
          context: 'agents',
          filepath: '/uploads/u/f2',
          source: 'local',
        },
      ],
      assets: [
        {
          asset_id: 'asset-1',
          vector_backend: 'azure_search',
          blob: { path: 'https://a.blob.core.windows.net/files/uploads/u/f1' },
        },
      ],
      agents: [{ id: 'agent_1' }],
      avatar: 'https://a.blob.core.windows.net/files/images/u/avatar.png?sig=x',
      containerName: 'files',
    });
    assert.deepEqual(inv.vectorIds.sort(), ['asset-1', 'f2']);
    assert.deepEqual(inv.agentIds, ['agent_1']);
    assert.deepEqual(inv.blobPointers.sort(), ['images/u/avatar.png', 'uploads/u/f1']);
    assert.deepEqual(inv.nonBlobPointers, { local: 1 });
  });
});

/* ------------------------------------------------------------------ probes: Langfuse, Meili, Redis */

describe('Langfuse listing reconciles against meta.totalItems', () => {
  const auth = { base: 'https://lf', headers: {} };
  const page = (data, totalItems, totalPages) =>
    fakeResponse(200, { data, meta: { totalItems, totalPages } });

  test('pages to exhaustion', async () => {
    const pages = [
      page([{ id: 't1', userId: SUBJECT }], 2, 2),
      page([{ id: 't2', userId: SUBJECT }], 2, 2),
    ];
    const r = await v.listLangfuse({
      auth,
      route: 'traces',
      userId: SUBJECT,
      fetchImpl: async () => pages.shift(),
    });
    assert.deepEqual(r, { ok: true, ids: ['t1', 't2'], total: 2 });
  });

  for (const [name, responses, status] of [
    ['fewer rows than totalItems', [page([{ id: 't1' }], 2, 1)], 'inexact'],
    ['no meta', [fakeResponse(200, { data: [] })], 'inexact'],
    [
      'totalItems moves between pages',
      [page([{ id: 't1' }], 2, 2), page([{ id: 't2' }], 3, 2)],
      'inexact',
    ],
    ['HTTP error', [fakeResponse(401, {})], 'error'],
    ['a row for another user', [page([{ id: 't1', userId: 'other' }], 1, 1)], 'error'],
  ]) {
    test(`${name} ⇒ ${status}`, async () => {
      const r = await v.listLangfuse({
        auth,
        route: 'traces',
        userId: SUBJECT,
        fetchImpl: async () => responses.shift(),
      });
      assert.equal(r.ok, false);
      assert.equal(r.status, status);
    });
  }
});

describe('Meilisearch uses the exhaustive totalHits', () => {
  const env = { MEILI_HOST: 'http://meili', MEILI_MASTER_KEY: 'k' };

  test('page/hitsPerPage with a quoted user filter', async () => {
    const bodies = [];
    const r = await v.probeMeili({
      identity: IDENTITY,
      env,
      fetchImpl: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return fakeResponse(200, { totalHits: 7, estimatedTotalHits: 1000 });
      },
    });
    assert.equal(r['meili:messages'].count, 7);
    assert.deepEqual(bodies[0], { q: '', filter: `user = "${SUBJECT}"`, hitsPerPage: 1, page: 1 });
  });

  test('an estimate-only response is inexact; an HTTP error is an error; no credentials is not-probed', async () => {
    let r = await v.probeMeili({
      identity: IDENTITY,
      env,
      fetchImpl: async () => fakeResponse(200, { estimatedTotalHits: 0 }),
    });
    assert.equal(r['meili:convos'].status, 'inexact');
    r = await v.probeMeili({
      identity: IDENTITY,
      env,
      fetchImpl: async () => fakeResponse(503, {}),
    });
    assert.equal(r['meili:convos'].status, 'error');
    r = await v.probeMeili({
      identity: IDENTITY,
      env: {},
      fetchImpl: async () => fakeResponse(200, { totalHits: 0 }),
    });
    assert.equal(r['meili:messages'].status, 'not-probed');
  });
});

describe('Redis scan', () => {
  test('dedupes keys SCAN returns twice and reports namespaces', async () => {
    const rounds = [
      ['5', [`PENDING_REQ:${SUBJECT}`, `tools:mcp:${SUBJECT}:x`]],
      ['0', [`PENDING_REQ:${SUBJECT}`]],
    ];
    const client = {
      scan: async (cursor, match, pattern) => {
        assert.equal(pattern, `*${SUBJECT}*`);
        return rounds.shift();
      },
    };
    const r = await v.probeRedis({ identity: IDENTITY, client });
    assert.equal(r.count, 2);
    assert.deepEqual(r.detail.namespaces, { PENDING_REQ: 1, tools: 1 });
  });

  test('no client ⇒ not-probed; a failing SCAN ⇒ error', async () => {
    assert.equal((await v.probeRedis({ identity: IDENTITY, client: null })).status, 'not-probed');
    const r = await v.probeRedis({
      identity: IDENTITY,
      client: {
        scan: async () => {
          throw new Error('NOAUTH');
        },
      },
    });
    assert.equal(r.status, 'error');
  });
});

/* ------------------------------------------------------------------ snapshot materialisation */

describe('every probed sink is materialised in every snapshot', () => {
  const fakeModels = () => new Proxy({}, { get: () => ({ countDocuments: async () => 1 }) });
  const deps = (overrides = {}) => ({
    models: fakeModels(),
    mongoose: { connection: { db: { collection: () => ({ countDocuments: async () => 1 }) } } },
    fetch: async () => {
      throw new Error('offline');
    },
    redis: null,
    containers: {
      names: {
        primary: 'files',
        codeStaging: 'code-adapter-staging',
        translation: ['translation-source', 'translation-target'],
      },
      clients: { primary: null, codeStaging: null, translation: [null, null] },
    },
    mintToken: () => 't',
    toObjectId: (id) => id,
    ...overrides,
  });
  const identity = { _id: SUBJECT, email: 's@knauf.test' };
  const inventory = {
    assetIds: [],
    agentIds: [],
    vectorIds: [],
    blobPointers: [],
    containerName: 'files',
  };

  test('with everything offline, every key still has a result', async () => {
    const sinks = await v.takeSnapshot({
      manifest: resolvedManifest(),
      identity,
      inventory,
      deps: deps(),
      env: { RAG_API_URL: 'http://rag', MEILI_HOST: 'http://m', MEILI_MASTER_KEY: 'k' },
    });
    assert.deepEqual(Object.keys(sinks).sort(), v.probedSinkKeys().sort());
    assert.equal(sinks['mongo:Message'].status, 'ok');
    assert.equal(sinks['meili:messages'].status, 'error');
    assert.equal(sinks['vectors:pgvector'].status, 'error');
    assert.equal(sinks['blob:primary'].status, 'not-probed');
    assert.equal(sinks['logs:files'].status, 'not-configured');
    assert.equal(sinks['translation:scratch'].status, 'not-probed');
    assert.equal(sinks['files:execute_code'].status, 'not-probed');
  });

  test('--skip (rehearsal) marks a whole group skipped instead of leaving it out', async () => {
    const sinks = await v.takeSnapshot({
      manifest: resolvedManifest(),
      identity,
      inventory,
      skip: ['mongo', 'langfuse'],
      deps: deps(),
      env: {},
    });
    assert.deepEqual(Object.keys(sinks).sort(), v.probedSinkKeys().sort());
    assert.equal(sinks['mongo:users'].status, 'skipped');
    assert.equal(sinks['raw:knauf_agent_schedules'].status, 'skipped');
    assert.equal(sinks['langfuse:scores'].status, 'skipped');
  });

  test('a probe that throws marks every key of its group as an error', async () => {
    const sinks = await v.takeSnapshot({
      manifest: resolvedManifest(),
      identity,
      inventory,
      deps: deps({
        models: {
          User: {
            countDocuments: async () => {
              throw new Error('mongo down');
            },
          },
        },
      }),
      env: {},
    });
    assert.equal(sinks['mongo:users'].status, 'error');
    assert.equal(sinks['mongo:Message'].status, 'error');
  });
});

/* ------------------------------------------------------------------ identity (review point 4) */

describe('evidence identity: canonical id + tenant, verified and bound', () => {
  const base = {
    phase: 'before',
    env: 'stage',
    out: './o',
    mode: 'evidence',
    skip: [],
    unknown: [],
  };

  test('evidence baselines refuse an email, a missing tenant, or --skip', () => {
    assert.match(
      v.validateArgs({ ...base, user: 'someone@knauf.com', tenant: 't' }),
      /canonical Mongo _id/,
    );
    assert.match(v.validateArgs({ ...base, user: SUBJECT }), /--tenant/);
    assert.match(
      v.validateArgs({ ...base, user: SUBJECT, tenant: 't', skip: ['redis'] }),
      /rehearsal/,
    );
    assert.equal(v.validateArgs({ ...base, user: SUBJECT, tenant: 'none' }), null);
  });

  test('rehearsal may resolve by reference; the destructive phase never may', () => {
    assert.equal(v.validateArgs({ ...base, mode: 'rehearsal', user: 'someone@knauf.com' }), null);
    const del = { ...base, phase: 'langfuse-delete', confirm: true };
    assert.match(
      v.validateArgs({ ...del, user: 'someone@knauf.com', tenant: 't' }),
      /canonical Mongo _id/,
    );
    assert.match(v.validateArgs({ ...del, user: SUBJECT }), /--tenant/);
    assert.match(
      v.validateArgs({ ...del, confirm: false, user: SUBJECT, tenant: 't' }),
      /--confirm/,
    );
  });

  test('unknown flags — including the removed --rag-query — are errors, not ignored', () => {
    const args = v.parseArgs([
      '--phase',
      'after',
      '--env',
      'stage',
      '--out',
      'o',
      '--rag-query',
      'the',
    ]);
    assert.match(v.validateArgs(args), /unknown argument/);
  });

  test('only canonical-id resolution with an asserted tenant is evidence-grade', () => {
    const user = { _id: SUBJECT, tenantId: 't1', email: 'S@Knauf.com ' };
    const graded = v.buildIdentity(user, { resolvedBy: 'canonical-id', tenantAsserted: 't1' });
    assert.equal(graded.evidenceGrade, true);
    assert.equal(graded.emailNormalized, 's@knauf.com');
    assert.equal(
      v.buildIdentity(user, { resolvedBy: 'reference', tenantAsserted: 't1' }).evidenceGrade,
      false,
    );
    assert.equal(v.buildIdentity(user, { resolvedBy: 'canonical-id' }).evidenceGrade, false);
    const otherTenant = v.buildIdentity(
      { ...user, tenantId: 't2' },
      { resolvedBy: 'canonical-id', tenantAsserted: 't2' },
    );
    assert.notEqual(graded.digest, otherTenant.digest);
  });

  test('the tenant assertion is verified against the stored subject', () => {
    assert.equal(v.tenantMismatch({ tenantId: 't1' }, 't1'), null);
    assert.match(v.tenantMismatch({ tenantId: 't1' }, 't2'), /t1/);
    assert.match(v.tenantMismatch({ tenantId: 't1' }, 'none'), /none/);
    assert.equal(v.tenantMismatch({}, 'none'), null);
    assert.match(v.tenantMismatch({}, 't1'), /\(none\)/);
  });

  test('later phases are bound to the baseline identity, environment and mode', () => {
    const before = {
      environment: 'stage',
      mode: 'evidence',
      identity: { _id: SUBJECT, tenantId: null },
    };
    assert.equal(
      v.bindingError(
        { phase: 'langfuse-delete', env: 'stage', user: SUBJECT, tenant: 'none' },
        before,
      ),
      null,
    );
    assert.match(
      v.bindingError(
        { phase: 'langfuse-delete', env: 'stage', user: SUBJECT, tenant: 't1' },
        before,
      ),
      /identity/,
    );
    assert.match(
      v.bindingError({ phase: 'after', env: 'prod', mode: 'evidence' }, before),
      /environment/,
    );
    assert.match(
      v.bindingError({ phase: 'after', env: 'stage', mode: 'rehearsal' }, before),
      /--mode evidence/,
    );
  });
});

/* ------------------------------------------------------------------ review round 2 */

describe('round 2 · the Langfuse leg is bound to the project, not the host', () => {
  const baselineFor = (projectId) => {
    const before = run().before;
    before.backends.langfuse = { baseUrl: 'https://lf', projectId };
    before.sinks['langfuse:traces'] = okResult('langfuse:traces', 3, {
      baseUrl: 'https://lf',
      projectId,
      traceIds: ['t1', 't2', 't3'],
    });
    before.readiness = { ready: true, preflightProblems: 0, gaps: [] };
    return before;
  };
  const auth = { base: 'https://lf', headers: { Authorization: 'Basic rotated-keys' } };
  const listing = { ok: true, ids: ['t1', 't2'], total: 2 };

  test('same host, different project ⇒ refused', () => {
    const r = v.langfuseDeleteRefusal({
      before: baselineFor('proj-A'),
      auth,
      project: { ok: true, id: 'proj-B' },
      current: listing,
    });
    assert.match(r, /project proj-B.*baseline was taken in proj-A/);
  });

  test('same project with rotated keys ⇒ allowed', () => {
    const r = v.langfuseDeleteRefusal({
      before: baselineFor('proj-A'),
      auth,
      project: { ok: true, id: 'proj-A' },
      current: listing,
    });
    assert.equal(r, null);
  });

  test('another host, an unresolved project, an inexact listing or a disjoint listing ⇒ refused', () => {
    const before = baselineFor('proj-A');
    const ok = { ok: true, id: 'proj-A' };
    assert.match(
      v.langfuseDeleteRefusal({
        before,
        auth: { base: 'https://other' },
        project: ok,
        current: listing,
      }),
      /not the instance/,
    );
    assert.match(
      v.langfuseDeleteRefusal({
        before,
        auth,
        project: { ok: false, reason: 'HTTP 401' },
        current: listing,
      }),
      /HTTP 401/,
    );
    assert.match(
      v.langfuseDeleteRefusal({
        before,
        auth,
        project: ok,
        current: { ok: false, reason: 'moved' },
      }),
      /could not list/,
    );
    assert.match(
      v.langfuseDeleteRefusal({
        before,
        auth,
        project: ok,
        current: { ok: true, ids: ['x1'], total: 1 },
      }),
      /share no id/,
    );
  });

  test('a baseline that recorded no project can never authorise a deletion', () => {
    const before = baselineFor('proj-A');
    delete before.backends.langfuse.projectId;
    const r = v.langfuseDeleteRefusal({
      before,
      auth,
      project: { ok: true, id: 'proj-A' },
      current: listing,
    });
    assert.match(r, /none recorded/);
  });

  test('final review · a baseline that cannot anchor the deletion refuses it', () => {
    const project = { ok: true, id: 'proj-A' };
    const refusal = (before, current = listing) =>
      v.langfuseDeleteRefusal({ before, auth, project, current });
    // The baseline's own listing was inexact: the project id was recorded, the ids not.
    let before = baselineFor('proj-A');
    before.sinks['langfuse:traces'] = v.probeResult('langfuse:traces', 'inexact', {
      reason: 'traces: totalItems moved between pages',
      detail: { baseUrl: 'https://lf', projectId: 'proj-A' },
    });
    assert.match(refusal(before, { ok: true, ids: ['t7', 't8'], total: 2 }), /not usable/);
    // Skipped or not configured at baseline: a named refusal, not a crash.
    for (const status of ['skipped', 'not-configured']) {
      before = baselineFor('proj-A');
      before.sinks['langfuse:traces'] = v.probeResult('langfuse:traces', status, {});
      assert.match(refusal(before), /not usable/);
    }
    // An exact but EMPTY baseline anchors nothing that is listed now…
    before = baselineFor('proj-A');
    before.sinks['langfuse:traces'] = okResult('langfuse:traces', 0, {
      projectId: 'proj-A',
      traceIds: [],
    });
    assert.match(refusal(before, { ok: true, ids: ['t7'], total: 1 }), /baseline captured none/);
    // …and an empty listing needs no anchor: there is nothing to delete.
    assert.equal(refusal(before, { ok: true, ids: [], total: 0 }), null);
  });

  test('final review · an evidence baseline the before phase called NOT READY cannot be deleted from', () => {
    const before = baselineFor('proj-A');
    before.readiness = {
      ready: false,
      gaps: [{ key: 'blob:primary', reason: 'NO BASELINE' }],
    };
    const project = { ok: true, id: 'proj-A' };
    assert.match(
      v.langfuseDeleteRefusal({ before, auth, project, current: listing }),
      /NOT READY \(1 gap\(s\)\)/,
    );
    delete before.readiness;
    assert.match(
      v.langfuseDeleteRefusal({ before, auth, project, current: listing }),
      /no readiness recorded/,
    );
    // A rehearsal is never evidence, so readiness does not gate it — the anchor still does.
    before.mode = 'rehearsal';
    assert.equal(v.langfuseDeleteRefusal({ before, auth, project, current: listing }), null);
    assert.match(
      v.langfuseDeleteRefusal({ before, auth, project, current: { ok: true, ids: ['x'] } }),
      /share no id/,
    );
  });

  test('final review · writers that disagree on the Langfuse instance refuse the deletion', () => {
    const { problem } = v.resolveLangfuseBaseUrl({
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
      LANGFUSE_BASEURL: 'https://lf',
      LANGFUSE_HOST: 'https://old',
    });
    const r = v.langfuseDeleteRefusal({
      before: baselineFor('proj-A'),
      auth,
      project: { ok: true, id: 'proj-A' },
      current: listing,
      targetProblem: problem,
    });
    assert.match(r, /writers disagree: traces go to https:\/\/lf, scores to https:\/\/old/);
  });

  test('resolveLangfuseProject accepts exactly one project', async () => {
    const one = await v.resolveLangfuseProject({
      auth,
      fetchImpl: async () => fakeResponse(200, { data: [{ id: 'proj-A', name: 'karl' }] }),
    });
    assert.deepEqual(one, { ok: true, id: 'proj-A', name: 'karl' });
    const two = await v.resolveLangfuseProject({
      auth,
      fetchImpl: async () => fakeResponse(200, { data: [{ id: 'a' }, { id: 'b' }] }),
    });
    assert.equal(two.ok, false);
    const denied = await v.resolveLangfuseProject({
      auth,
      fetchImpl: async () => fakeResponse(401, {}),
    });
    assert.match(denied.reason, /401/);
  });

  test('the verdict blocks a deletion record from another project', () => {
    const input = run();
    input.langfuseDelete.projectId = 'proj-B';
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.ok(e.blockers.some((b) => /project proj-B/.test(b.text)));
  });

  test('the baseline probe records the project, and refuses when the credentials resolve to none', async () => {
    const env = {
      LANGFUSE_BASE_URL: 'https://lf',
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk',
    };
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/public/projects'))
        return fakeResponse(200, { data: [{ id: 'proj-A', name: 'karl' }] });
      return fakeResponse(200, {
        data: [{ id: 'x1', userId: SUBJECT }],
        meta: { totalItems: 1, totalPages: 1 },
      });
    };
    const r = await v.probeLangfuse({ identity: IDENTITY, env, fetchImpl });
    assert.equal(r['langfuse:traces'].detail.projectId, 'proj-A');
    assert.deepEqual(r['langfuse:scores'].detail.scoreIds, ['x1']);
    assert.equal(r['langfuse:scores'].detail.verifiedById, 1);
    const none = await v.probeLangfuse({
      identity: IDENTITY,
      env,
      fetchImpl: async () => fakeResponse(200, { data: [] }),
    });
    assert.equal(none['langfuse:traces'].status, 'not-probed');
    assert.match(none['langfuse:traces'].reason, /project/);
  });
});

describe('round 2 · physical backend identity is compared, not only configured/not', () => {
  test('reviewer repro: MEILI_HOST switched to an empty instance between phases cannot be CLEAN', () => {
    const input = run();
    input.after.backends = {
      ...input.after.backends,
      meili: { endpoint: 'http://meili-empty:7700' },
    };
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.ok(e.blockers.some((b) => b.key === '(storage:meili)'));
    assert.equal(e.backends.mismatches.length, 1);
  });

  test('swapped RAG storage behind the same RAG_API_URL blocks too', () => {
    const input = run();
    input.after.backends['vectors:pgvector'] = { ...STORAGE.pgvector, database: 'vectors-clone' };
    assertNotClean(input, 'INCOMPLETE');
  });

  test('a baseline with no backend identities blocks', () => {
    const input = run();
    input.before.backends = {};
    assertNotClean(input, 'INCOMPLETE');
  });

  test('backendMismatch compares field by field and ignores what one side does not know', () => {
    const before = {
      langfuse: { baseUrl: 'https://lf', projectId: 'proj-A' },
      meili: { endpoint: 'http://m' },
    };
    assert.deepEqual(v.backendMismatch(before, { langfuse: { baseUrl: 'https://lf' } }), []);
    assert.deepEqual(v.backendMismatch(before, { redis: { hosts: ['r:6379'] } }), []);
    const drift = v.backendMismatch(before, {
      meili: { endpoint: 'http://other' },
      langfuse: { baseUrl: 'https://lf', projectId: 'proj-B' },
    });
    assert.deepEqual(drift.map((d) => `${d.key}.${d.field}`).sort(), [
      'langfuse.projectId',
      'meili.endpoint',
    ]);
  });

  test('local identities carry hosts, databases and containers, never credentials', () => {
    const containers = {
      clients: {
        primary: { url: 'https://acct.blob.core.windows.net/files?sv=1&sig=SECRETSIG' },
        codeStaging: { url: 'https://acct.blob.core.windows.net/code-adapter-staging' },
        translation: [{ url: 'https://acct.blob.core.windows.net/translation-source' }, null],
      },
    };
    const b = v.localBackends({
      env: {
        MONGO_URI:
          'mongodb+srv://user:p%40ss@c2.mongo.cosmos.azure.com,c1.mongo.cosmos.azure.com/LibreChat?ssl=true',
        MEILI_HOST: 'http://meili:7700',
        RAG_API_URL: 'http://rag:8000/',
        LANGFUSE_BASE_URL: 'https://lf/',
        REDIS_URI: 'redis://:secretpw@redis:6379/2',
      },
      containers,
    });
    assert.deepEqual(b.mongo, {
      hosts: ['c1.mongo.cosmos.azure.com', 'c2.mongo.cosmos.azure.com'],
      database: 'LibreChat',
    });
    assert.deepEqual(b.meili, { endpoint: 'http://meili:7700' });
    assert.deepEqual(b.ragApi, { endpoint: 'http://rag:8000' });
    assert.deepEqual(b.langfuse, { baseUrl: 'https://lf' });
    assert.deepEqual(b.redis, { hosts: ['redis:6379'], db: '2' });
    assert.deepEqual(b['container:primary'], { url: 'https://acct.blob.core.windows.net/files' });
    assert.deepEqual(b['container:codeStaging'], {
      url: 'https://acct.blob.core.windows.net/code-adapter-staging',
    });
    assert.equal(b['container:translation1'], undefined);
    const serialised = JSON.stringify(b);
    for (const secret of ['p%40ss', 'secretpw', 'sig=', 'user:', 'SECRETSIG']) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  test('collectBackends folds in the Langfuse project and the RAG storage the probes reported', () => {
    const sinks = {
      'langfuse:traces': okResult('langfuse:traces', 0, { projectId: 'proj-A' }),
      'vectors:pgvector': okResult('vectors:pgvector', 0, { storage: STORAGE.pgvector }),
    };
    const b = v.collectBackends({ local: { langfuse: { baseUrl: 'https://lf' } }, sinks });
    assert.deepEqual(b.langfuse, { baseUrl: 'https://lf', projectId: 'proj-A' });
    assert.deepEqual(b['vectors:pgvector'], STORAGE.pgvector);
  });

  test('an adapter that does not report its storage, or reports two, is not an answer', async () => {
    const env = { RAG_API_URL: 'http://rag' };
    const noStorage = await v.probeVectors({
      backend: 'pgvector',
      identity: IDENTITY,
      inventory: INVENTORY,
      env,
      fetchImpl: async (url, init) =>
        fakeResponse(
          200,
          ragPage({ key: JSON.parse(init.body).key, total: 0, groups: [], storage: null }),
        ),
      mintToken: () => 't',
    });
    assert.equal(noStorage.status, 'not-probed');
    assert.equal(noStorage.count, null);
    let n = 0;
    const twoStorages = await v.probeVectors({
      backend: 'pgvector',
      identity: IDENTITY,
      inventory: INVENTORY,
      env,
      fetchImpl: async (url, init) =>
        fakeResponse(
          200,
          ragPage({
            key: JSON.parse(init.body).key,
            total: 0,
            groups: [],
            storage: { ...STORAGE.pgvector, host: `pg${n++}` },
          }),
        ),
      mintToken: () => 't',
    });
    assert.equal(twoStorages.status, 'error');
    const good = await v.probeVectors({
      backend: 'pgvector',
      identity: IDENTITY,
      inventory: INVENTORY,
      env,
      fetchImpl: async (url, init) =>
        fakeResponse(200, ragPage({ key: JSON.parse(init.body).key, total: 0, groups: [] })),
      mintToken: () => 't',
    });
    assert.deepEqual(good.detail.storage, STORAGE.pgvector);
  });

  test('final review · an empty, partial or foreign storage identity binds nothing', async () => {
    const env = { RAG_API_URL: 'http://rag' };
    for (const [storage, reason] of [
      [{}, /storage of \(none\)/],
      [{ backend: 'pgvector', host: 'pg' }, /lacks port, database, collection/],
      [{ ...STORAGE.pgvector, database: '  ' }, /lacks database/],
      [STORAGE.azure_search, /storage of azure_search, not pgvector/],
      [['pg'], /did not report/],
    ]) {
      const r = await v.probeVectors({
        backend: 'pgvector',
        identity: IDENTITY,
        inventory: INVENTORY,
        env,
        fetchImpl: async (url, init) =>
          fakeResponse(
            200,
            ragPage({ key: JSON.parse(init.body).key, total: 0, groups: [], storage }),
          ),
        mintToken: () => 't',
      });
      assert.equal(r.status, 'not-probed', JSON.stringify(storage));
      assert.match(r.reason, reason);
    }
  });

  test('final review · the Redis db in a query string and the log directory are identities too', () => {
    assert.deepEqual(v.localBackends({ env: { REDIS_URI: 'redis://redis:6379?db=3' } }).redis, {
      hosts: ['redis:6379'],
      db: '3',
    });
    assert.deepEqual(v.localBackends({ env: { REDIS_URI: 'redis://redis:6379/2?db=3' } }).redis, {
      hosts: ['redis:6379'],
      db: '2',
    });
    const b = v.collectBackends({
      local: {},
      sinks: { 'logs:files': okResult('logs:files', 0, { dir: '/var/log/karl' }) },
    });
    assert.deepEqual(b.logs, { dir: '/var/log/karl' });
    const input = run();
    input.before.backends.logs = { dir: '/var/log/karl' };
    input.after.backends.logs = { dir: '/tmp/empty' };
    assertNotClean(input, 'INCOMPLETE');
  });

  test('openContainers asks for the primary, the manifest-named code container and both scratch containers', async () => {
    const asked = [];
    const c = await v.openContainers({
      manifest: resolvedManifest(),
      env: { AZURE_CONTAINER_NAME: 'files', AZURE_TRANSLATION_TARGET_CONTAINER: 'tt' },
      getAzureContainerClient: async (name) => {
        asked.push(name);
        return name === 'tt' ? null : { url: `https://a/${name}` };
      },
    });
    assert.deepEqual(asked, ['files', 'code-adapter-test', 'translation-source', 'tt']);
    assert.deepEqual(c.names.translation, ['translation-source', 'tt']);
    assert.equal(c.clients.translation[1], null);
    assert.equal(c.clients.codeStaging.url, 'https://a/code-adapter-test');
  });
});

describe('round 2 · translation and code execution are detected, not silently excluded', () => {
  test('the two feature flags are environment signals', () => {
    const s = v.environmentSignals({
      KNAUF_FILE_TRANSLATION_ENABLED: 'true',
      KNAUF_CODE_EXECUTION_ENABLED: 'true',
    });
    assert.equal(s['translation:scratch'], true);
    assert.equal(s['files:execute_code'], true);
    assert.equal(s['code:table'], true);
    assert.equal(v.environmentSignals({})['files:execute_code'], false);
  });

  test('reviewer repro: both stores declared configured:false while the flags are on cannot be CLEAN', () => {
    const input = run();
    for (const key of ['translation:scratch', 'files:execute_code']) {
      entry(input.manifest, key).configured = false;
      input.before.sinks[key] = v.probeResult(key, 'not-configured', {});
      input.after.sinks[key] = v.probeResult(key, 'not-configured', {});
    }
    const problems = v.preflight(input.manifest, { envName: 'test', signals: SIGNALS });
    assert.ok(problems.filter((p) => /drift/.test(p)).length >= 2);
    const e = assertNotClean(input, 'INCOMPLETE');
    for (const key of ['translation:scratch', 'files:execute_code']) {
      assert.match(e.rows.find((r) => r.key === key).status, /drift/);
    }
  });

  test('a code-execution file counts as a staged copy as well as a Blob object', () => {
    const inv = v.buildInventory({
      files: [
        {
          file_id: 'f1',
          filepath: 'https://a.blob.core.windows.net/files/images/u/f1.png',
          source: 'azure_blob',
          context: 'execute_code',
          metadata: {
            codeEnvRef: { kind: 'user', id: SUBJECT, storage_session_id: 'sess-1', file_id: 'cf1' },
          },
        },
        {
          file_id: 'f2',
          filepath: 'https://a.blob.core.windows.net/files/uploads/u/f2.pdf',
          source: 'azure_blob',
          metadata: { codeEnvRef: { storage_session_id: 'sess-1' } },
        },
        {
          file_id: 'f3',
          filepath: 'http://api/files/code/download/sess-2/cf3',
          source: 'execute_code',
        },
        {
          file_id: 'f4',
          filepath: 'https://a.blob.core.windows.net/files/uploads/u/f4.pdf',
          source: 'azure_blob',
        },
      ],
      containerName: 'files',
    });
    assert.equal(inv.nonBlobPointers.execute_code, 3);
    // Final review: the fallback row keeps its session only in the download URL.
    assert.deepEqual(inv.codeSessions, ['sess-1', 'sess-2']);
    assert.deepEqual(inv.blobPointers.sort(), [
      'images/u/f1.png',
      'uploads/u/f2.pdf',
      'uploads/u/f4.pdf',
    ]);
  });

  test('code staging is probed by the sessions the baseline inventory named', async () => {
    const calls = [];
    const container = fakeContainer(
      { 'sess-1/cf1': {}, 'sess-1/out-uuid': { deleted: true }, 'sess-9/other': {} },
      calls,
    );
    const r = await v.probeCodeStaging({
      inventory: { codeSessions: ['sess-1'] },
      containerClient: container,
      containerName: 'code-adapter-staging',
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.count, 2);
    assert.deepEqual(
      calls.map((c) => c.prefix),
      ['sess-1/'],
    );
    assert.equal(r.detail.objectCount, 2);
    assert.equal(r.detail.objects, undefined);
    assert.deepEqual(r.detail.classes, { current: 1, versions: 0, snapshots: 0, softDeleted: 1 });
    const none = await v.probeCodeStaging({
      inventory: { codeSessions: ['s'] },
      containerClient: null,
      containerName: 'x',
    });
    assert.equal(none.status, 'not-probed');
  });

  test('translation scratch is measured against its lifecycle window', async () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const fresh = { properties: { lastModified: new Date(now - day / 2) } };
    const stale = { properties: { lastModified: new Date(now - 3 * day) } };
    const source = fakeContainer({
      'u1/a.pdf': fresh,
      'u2/b.pdf': stale,
      'u3/c.pdf': { ...stale, deleted: true },
    });
    const target = fakeContainer({ 'u2/b.pdf': stale });
    const r = await v.probeTranslationScratch({
      clients: [source, target],
      names: ['translation-source', 'translation-target'],
      windowMs: day,
      now,
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.count, 2);
    assert.deepEqual(r.detail.overdueByContainer, {
      'translation-source': 1,
      'translation-target': 1,
    });
    assert.equal(r.detail.oldestOverdue, new Date(now - 3 * day).toISOString());
    assert.equal(r.detail.listedByClass.softDeleted, 1);
    // Final review: scratch names are other users' filenames — never in the evidence.
    assert.ok(!JSON.stringify(r).includes('b.pdf'));
    assert.equal(r.detail.classes, undefined, 'the lifecycle-class rule must not read this sink');
    const noStamp = await v.probeTranslationScratch({
      clients: [fakeContainer({ 'u9/secret-name.pdf': {} }), target],
      names: ['s', 't'],
      windowMs: day,
      now,
    });
    assert.equal(noStamp.status, 'inexact');
    assert.doesNotMatch(noStamp.reason, /secret-name/);
    const missing = await v.probeTranslationScratch({
      clients: [source, null],
      names: ['s', 't'],
      windowMs: day,
      now,
    });
    assert.equal(missing.status, 'not-probed');
  });

  test('the snapshot probes code staging in the named container and scratch against the manifest window', async () => {
    const codeCalls = [];
    const scratchCalls = [];
    const containers = {
      names: { primary: 'files', codeStaging: 'code-adapter-test', translation: ['ts', 'tt'] },
      clients: {
        primary: null,
        codeStaging: fakeContainer({ 'sess-1/f': {} }, codeCalls),
        translation: [fakeContainer({}, scratchCalls), fakeContainer({}, scratchCalls)],
      },
    };
    const manifest = resolvedManifest();
    entry(manifest, 'translation:scratch').lifecycleWindow = 'PT1H';
    const models = new Proxy({}, { get: () => ({ countDocuments: async () => 1 }) });
    const sinks = await v.takeSnapshot({
      manifest,
      identity: { _id: SUBJECT },
      inventory: {
        assetIds: [],
        agentIds: [],
        vectorIds: [],
        blobPointers: [],
        codeSessions: ['sess-1'],
      },
      deps: {
        models,
        mongoose: { connection: { db: { collection: () => ({ countDocuments: async () => 1 }) } } },
        fetch: async () => {
          throw new Error('offline');
        },
        redis: null,
        containers,
        mintToken: () => 't',
        toObjectId: (id) => id,
      },
      env: {},
    });
    assert.equal(sinks['files:execute_code'].count, 1);
    assert.equal(sinks['files:execute_code'].detail.container, 'code-adapter-test');
    assert.deepEqual(
      codeCalls.map((c) => c.prefix),
      ['sess-1/'],
    );
    assert.equal(sinks['translation:scratch'].status, 'ok');
    assert.equal(sinks['translation:scratch'].count, 0);
    assert.equal(scratchCalls.length, 2);

    // Final review: the window is a manifest fact, with no code default behind it.
    delete entry(manifest, 'translation:scratch').lifecycleWindow;
    const noWindow = await v.takeSnapshot({
      manifest,
      identity: { _id: SUBJECT },
      inventory: { assetIds: [], agentIds: [], vectorIds: [], blobPointers: [], codeSessions: [] },
      deps: {
        models,
        mongoose: { connection: { db: { collection: () => ({ countDocuments: async () => 1 }) } } },
        fetch: async () => {
          throw new Error('offline');
        },
        redis: null,
        containers,
        mintToken: () => 't',
        toObjectId: (id) => id,
      },
      env: {},
    });
    assert.equal(noWindow['translation:scratch'].status, 'not-probed');
    assert.match(noWindow['translation:scratch'].reason, /lifecycleWindow/);
  });

  test('final review · scratch cannot be N/A: nothing overdue is an obligation, anything overdue a residual', () => {
    const input = run();
    let e = verdictOf(input);
    assert.match(
      e.rows.find((r) => r.key === 'translation:scratch').status,
      /^EVENTUALLY DELETED — not searchable per subject; nothing outlived the P1D rule/,
    );
    assert.match(
      e.obligations.find((o) => o.key === 'translation:scratch').text,
      /gone by 2026-10-02T11:00:00\.000Z/,
    );
    input.after.sinks['translation:scratch'] = okResult('translation:scratch', 2);
    e = assertNotClean(input, 'RESIDUALS FOUND');
    assert.deepEqual(e.residuals, [{ key: 'translation:scratch', count: 2 }]);
    // …and the exemption cannot be attached to a `deleted` claim at all.
    const m = resolvedManifest();
    entry(m, 'translation:scratch').disposition = 'deleted';
    assert.ok(
      v
        .structuralProblems(m, 'test')
        .some((p) => p.key === 'translation:scratch' && /NOT_SUBJECT_ADDRESSABLE/.test(p.problem)),
    );
  });
});

describe('round 2 · score ids are verified without their parent trace', () => {
  const env = {
    LANGFUSE_BASE_URL: 'https://lf',
    LANGFUSE_PUBLIC_KEY: 'pk',
    LANGFUSE_SECRET_KEY: 'sk',
  };
  const project = () => fakeResponse(200, { data: [{ id: 'proj-A', name: 'karl' }] });
  const emptyList = () => fakeResponse(200, { data: [], meta: { totalItems: 0, totalPages: 1 } });

  test('reviewer repro: trace gone, score row remains ⇒ the score is counted, and the run is not CLEAN', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/public/projects')) return project();
      if (url.includes('/api/public/scores/s1'))
        return fakeResponse(200, { id: 's1', comment: 'prose' });
      if (url.includes('/api/public/traces/t1')) return fakeResponse(404, {});
      return emptyList(); // both userId lists are empty: the score list joins the (deleted) trace
    };
    const r = await v.probeLangfuse({
      identity: IDENTITY,
      env,
      fetchImpl,
      baseline: { traceIds: ['t1'], scoreIds: ['s1'], verifiedById: { traces: 1, scores: 1 } },
    });
    assert.equal(r['langfuse:traces'].count, 0);
    assert.equal(r['langfuse:scores'].count, 1);
    assert.deepEqual(r['langfuse:scores'].detail.survivingBaselineIds, ['s1']);
    assert.equal(r['langfuse:scores'].detail.listed, 0);
    const input = run();
    input.after.sinks['langfuse:scores'] = r['langfuse:scores'];
    const e = assertNotClean(input, 'RESIDUALS FOUND');
    assert.deepEqual(e.residuals, [{ key: 'langfuse:scores', count: 1 }]);
  });

  test('a lookup that cannot answer is never zero', async () => {
    const auth = { base: 'https://lf', headers: {} };
    const denied = await v.lookupLangfuseIds({
      auth,
      route: 'scores',
      ids: ['s1'],
      fetchImpl: async () => fakeResponse(500, {}),
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 'error');
    const tooMany = await v.lookupLangfuseIds({
      auth,
      route: 'scores',
      ids: Array.from({ length: v.LANGFUSE_MAX_LOOKUPS + 1 }, (_, i) => `s${i}`),
      fetchImpl: async () => fakeResponse(404, {}),
    });
    assert.equal(tooMany.status, 'inexact');
    const fine = await v.lookupLangfuseIds({
      auth,
      route: 'traces',
      ids: ['t1', 't1', 't2'],
      fetchImpl: async (url) => fakeResponse(url.endsWith('/t2') ? 200 : 404, {}),
    });
    assert.deepEqual(fine, { ok: true, present: ['t2'], absent: 1 });
    const r = await v.probeLangfuse({
      identity: IDENTITY,
      env,
      fetchImpl: async (url) => {
        if (url.endsWith('/projects')) return project();
        if (url.includes('/scores/')) return fakeResponse(500, {});
        return emptyList();
      },
      baseline: { traceIds: [], scoreIds: ['s1'], verifiedById: { traces: 0, scores: 1 } },
    });
    assert.equal(r['langfuse:scores'].status, 'error');
    assert.equal(r['langfuse:scores'].count, null);
  });

  test('final review · the baseline proves the by-id route answers, or a 404 later proves nothing', async () => {
    const listed = (ids) =>
      fakeResponse(200, {
        data: ids.map((id) => ({ id, userId: SUBJECT })),
        meta: { totalItems: ids.length, totalPages: 1 },
      });
    // An ingress that routes the lists but not /{id}: every lookup 404s.
    const routeNotServed = async (url) => {
      if (url.endsWith('/api/public/projects')) return project();
      if (/\/api\/public\/(traces|scores)\/[^/?]+$/.test(url)) return fakeResponse(404, {});
      return listed(url.includes('/traces?') ? ['t1'] : ['s1']);
    };
    const atBaseline = await v.probeLangfuse({
      identity: IDENTITY,
      env,
      fetchImpl: routeNotServed,
    });
    for (const k of ['langfuse:traces', 'langfuse:scores']) {
      assert.equal(atBaseline[k].status, 'error');
      assert.match(atBaseline[k].reason, /could not mean "deleted"/);
    }
    // A baseline without that proof makes the after lookups not an answer.
    const atAfter = await v.probeLangfuse({
      identity: IDENTITY,
      env,
      fetchImpl: routeNotServed,
      baseline: { traceIds: ['t1'], scoreIds: ['s1'] },
    });
    assert.equal(atAfter['langfuse:scores'].status, 'not-probed');
    assert.match(atAfter['langfuse:scores'].reason, /did not confirm/);
    // The snapshot carries the proof from the baseline sinks to the after probe.
    const seen = [];
    const sinks = await v.takeSnapshot({
      manifest: resolvedManifest(),
      identity: IDENTITY,
      inventory: { assetIds: [], agentIds: [], vectorIds: [], blobPointers: [] },
      skip: ['mongo', 'meili', 'vectors', 'blob', 'redis', 'logs', 'translation', 'code'],
      deps: {
        fetch: async (url) => {
          seen.push(url);
          if (url.endsWith('/api/public/projects')) return project();
          if (/\/scores\/s1$/.test(url)) return fakeResponse(200, { id: 's1' });
          if (/\/traces\/t1$/.test(url)) return fakeResponse(404, {});
          return emptyList();
        },
        toObjectId: (id) => id,
      },
      env,
      baselineSinks: {
        'langfuse:traces': okResult('langfuse:traces', 1, { traceIds: ['t1'], verifiedById: 1 }),
        'langfuse:scores': okResult('langfuse:scores', 1, { scoreIds: ['s1'], verifiedById: 1 }),
      },
    });
    assert.equal(sinks['langfuse:scores'].count, 1);
    assert.equal(sinks['langfuse:traces'].count, 0);
    assert.ok(seen.some((u) => u.endsWith('/api/public/scores/s1')));
  });

  test('final review · lookups run a few at a time, never all at once and never one by one', async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await v.lookupLangfuseIds({
      auth: { base: 'https://lf', headers: {} },
      route: 'traces',
      ids: Array.from({ length: 40 }, (_, i) => `t${i}`),
      fetchImpl: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return fakeResponse(404, {});
      },
    });
    assert.deepEqual(r, { ok: true, present: [], absent: 40 });
    assert.equal(peak, v.LANGFUSE_LOOKUP_CONCURRENCY);
  });
});

/* ------------------------------------------------------------------ final review */

describe('final review · configured:false cannot hide a store the verifier can see', () => {
  test('a Mongo collection cannot be declared absent', () => {
    for (const key of ['mongo:Message', 'raw:knauf_translation_jobs', 'mongo:users']) {
      const m = resolvedManifest();
      entry(m, key).configured = false;
      assert.ok(
        v.structuralProblems(m, 'test').some((p) => p.key === key && /Mongo/.test(p.problem)),
        key,
      );
      const input = run();
      entry(input.manifest, key).configured = false;
      assertNotClean(input, 'INCOMPLETE');
    }
  });

  test('every Redis namespace follows USE_REDIS', () => {
    const input = run();
    input.manifest.sinks.push({
      key: 'redis:opaque',
      configured: false,
      disposition: 'not-probed',
      reason: 'x',
    });
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.match(e.rows.find((r) => r.key === 'redis:opaque').status, /drift/);
  });

  test('a store no signal can confirm needs an approval to be declared absent', () => {
    const input = run();
    Object.assign(entry(input.manifest, 'backup:mongo'), {
      configured: false,
      approvedBy: null,
      approvedAt: null,
    });
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.match(e.rows.find((r) => r.key === 'backup:mongo').status, /needs approvedBy/);
    Object.assign(entry(input.manifest, 'backup:mongo'), APPROVED);
    assert.equal(verdictOf(input).verdict, 'CLEAN');
    assert.equal(
      verdictOf(input).rows.find((r) => r.key === 'backup:mongo').status,
      'NOT CONFIGURED',
    );
  });

  test('"feature disabled" is drift while the environment shows the feature on', () => {
    const input = run();
    input.before.sinks['files:execute_code'] = okResult('files:execute_code', 0);
    entry(input.manifest, 'files:execute_code').baseline = {
      exempt: 'FEATURE_DISABLED_IN_ENVIRONMENT',
      note: 'written when code execution was off',
      ...APPROVED,
    };
    const e = assertNotClean(input, 'INCOMPLETE');
    assert.match(e.rows.find((r) => r.key === 'files:execute_code').status, /drift/);
    input.before.envSignals['files:execute_code'] = false;
    input.after.envSignals['files:execute_code'] = false;
    assert.equal(verdictOf(input).verdict, 'CLEAN');
  });

  test('the app trims boolean flags, so the signals do', () => {
    const s = v.environmentSignals({ USE_REDIS: ' true ', KNAUF_CODE_EXECUTION_ENABLED: 'TRUE\n' });
    assert.equal(s['redis:keys'], true);
    assert.equal(s['files:execute_code'], true);
  });

  test('the inventory contradicts configured:false for vector backends, translation and code sessions', () => {
    const cases = [
      ['vectors:azureAiSearch', { vectorEntries: [{ vectorId: 'a1', backend: 'azure_search' }] }],
      ['vectors:pgvector', { vectorEntries: [{ vectorId: 'f1', backend: 'pgvector' }] }],
      ['code:table', { codeSessions: ['sess-1'] }],
    ];
    for (const [key, inventory] of cases) {
      const input = run();
      input.before.inventory = { nonBlobPointers: {}, ...inventory };
      entry(input.manifest, key).configured = false;
      // The operator's shell lacks the flag, so no signal contradicts the manifest…
      input.before.envSignals[key] = false;
      input.after.envSignals[key] = false;
      input.before.sinks[key] = v.probeResult(key, 'not-configured', {});
      input.after.sinks[key] = v.probeResult(key, 'not-configured', {});
      // …but the subject's own rows do.
      assert.deepEqual(
        v.inventoryProblems(input.manifest, input.before).map((p) => p.key),
        [key],
      );
      const e = assertNotClean(input, 'INCOMPLETE');
      assert.match(e.rows.find((r) => r.key === key).status, /inventory holds data here/, key);
    }
    const input = run();
    entry(input.manifest, 'translation:scratch').configured = false;
    input.before.envSignals['translation:scratch'] = false;
    input.after.envSignals['translation:scratch'] = false;
    const e = assertNotClean(input, 'INCOMPLETE'); // raw:knauf_translation_jobs counted 3
    assert.match(e.blockers.find((b) => b.key === 'translation:scratch').text, /translation job/);
  });

  test('before knows what the verdict will block: baseline gaps and inventory problems', () => {
    const input = run();
    assert.deepEqual(v.baselineGaps(input.manifest, input.before), []);
    assert.deepEqual(v.inventoryProblems(input.manifest, input.before), []);
    input.before.sinks['mongo:Message'] = okResult('mongo:Message', 0);
    input.before.sinks['meili:convos'] = v.probeResult('meili:convos', 'error', { reason: 'x' });
    input.before.inventory.nonBlobPointers = { external: 1 };
    assert.deepEqual(
      v
        .baselineGaps(input.manifest, input.before)
        .map((g) => g.key)
        .sort(),
      ['meili:convos', 'mongo:Message'],
    );
    assert.deepEqual(v.inventoryProblems(input.manifest, input.before), [
      {
        key: 'files:external',
        text: 'before-inventory holds 1 file(s) stored as "external", and the manifest has no entry for that store',
      },
    ]);
    const readiness = v.baselineReadiness(input.manifest, input.before);
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.gaps.map((g) => g.key).sort(), [
      'files:external',
      'meili:convos',
      'mongo:Message',
    ]);
  });

  test('a baseline is READY only with no gap and no preflight problem', () => {
    const { manifest, before } = run();
    assert.deepEqual(v.baselineReadiness(manifest, before), {
      ready: true,
      preflightProblems: 0,
      gaps: [],
    });
    const rehearsal = v.baselineReadiness(manifest, before, ['idp:entra: PROPOSED']);
    assert.equal(rehearsal.ready, false);
    assert.equal(rehearsal.preflightProblems, 1);
  });
});

/* ------------------------------------------------------------------ shipped manifests */

describe('shipped environment manifests', () => {
  const envs = fs
    .readdirSync(v.MANIFEST_DIR)
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.replace(/\.json$/, ''));

  test('stage and prod exist', () => {
    assert.ok(envs.includes('stage'));
    assert.ok(envs.includes('prod'));
  });

  for (const env of envs) {
    test(`${env}: valid, covers every probed sink, and declares the review's store classes`, () => {
      const { manifest } = v.loadManifest(env);
      assert.deepEqual(v.structuralProblems(manifest, env), []);
      const keys = manifest.sinks.map((s) => s.key);
      for (const prefix of [
        'redis:',
        'langfuse:eventStorage',
        'langfuse:mediaStorage',
        'langfuse:batchExports',
        'backup:',
        'idp:',
        'logs:platform',
      ]) {
        assert.ok(
          keys.some((k) => k.startsWith(prefix)),
          `${env} declares ${prefix}`,
        );
      }
    });

    test(`${env}: translation and code execution are configured, with a probe or a disposition`, () => {
      const { manifest } = v.loadManifest(env);
      const scratch = manifest.sinks.find((s) => s.key === 'translation:scratch');
      const code = manifest.sinks.find((s) => s.key === 'files:execute_code');
      assert.equal(scratch.configured, true);
      assert.equal(scratch.baseline?.exempt, 'NOT_SUBJECT_ADDRESSABLE');
      assert.equal(scratch.disposition, 'eventually-deleted');
      assert.equal(scratch.lifecycleWindow, 'P1D');
      assert.equal(code.configured, true);
      assert.equal(code.disposition, 'eventually-deleted');
      assert.match(code.container, /^code-adapter-/);
      // The reaper deletes only after its 24 h TTL plus a grace hour, on an hourly sweep.
      assert.ok(v.parseDuration(code.deadline) > 25 * 60 * 60 * 1000, code.deadline);
      assert.equal(manifest.sinks.find((s) => s.key === 'code:table').configured, true);
      // Translation spans carry no userId, so they are declared rather than assumed covered.
      assert.equal(
        manifest.sinks.find((s) => s.key === 'langfuse:translationTraces')?.disposition,
        'not-probed',
      );
      assert.equal(
        manifest.sinks.find((s) => s.key === 'raw:knauf_translation_jobs').baseline,
        'required',
      );
      // With both flags on and stdout logging, as deployed, nothing reads as drift.
      const signals = v.environmentSignals({
        KNAUF_FILE_TRANSLATION_ENABLED: 'true',
        KNAUF_CODE_EXECUTION_ENABLED: 'true',
        LOG_TO_FILE: 'false',
      });
      assert.ok(!v.preflight(manifest, { envName: env, signals }).some((p) => /drift/.test(p)));
    });

    test(`${env}: every unapproved or unknown entry is reported by preflight — nothing resolves by default`, () => {
      const { manifest } = v.loadManifest(env);
      const problems = v.preflight(manifest, { envName: env, signals: {} });
      for (const s of manifest.sinks) {
        const needsApproval =
          ['eventually-deleted', 'retained', 'externally-controlled'].includes(s.disposition) ||
          (s.baseline && s.baseline !== 'required') ||
          (s.eventualClasses && Object.keys(s.eventualClasses).length);
        const unresolved =
          s.configured === 'unknown' ||
          (s.configured === true && s.disposition === 'not-probed') ||
          (s.configured === true &&
            needsApproval &&
            !(
              v.isApproved(s) &&
              (!s.baseline || s.baseline === 'required' || v.isApproved(s.baseline))
            ));
        if (unresolved)
          assert.ok(
            problems.some((p) => p.startsWith(`${s.key}:`)),
            `${env}/${s.key} must be a preflight blocker`,
          );
      }
    });
  }
});

/* ------------------------------------------------------------------ report */

describe('report', () => {
  test('states the verdict, the bindings and the blockers — and never the email', () => {
    const input = run();
    input.before.identity.email = 'jane.doe@knauf.com';
    input.before.manifest = {
      file: 'knauf/docs/privacy/erasure-sinks/test.json',
      revision: 't-1',
      sha256: 'm',
    };
    input.after.tool = { sha256: 'tool' };
    input.after.sinks['mongo:Message'] = okResult('mongo:Message', 1);
    const evaluation = v.evaluate(input);
    const md = v.renderReport({
      before: input.before,
      after: input.after,
      evaluation,
      langfuseDelete: input.langfuseDelete,
      currentManifestSha: 'changed',
    });
    assert.match(md, /Verdict \| \*\*RESIDUALS FOUND\*\*/);
    assert.match(md, /\| `mongo:Message` \| deleted \| 3 \| 1 \| RESIDUAL \|/);
    assert.match(md, /## Blockers/);
    assert.match(md, /rev `t-1`, sha256 `m`/);
    assert.match(md, /repository manifest has changed/);
    assert.doesNotMatch(md, /jane\.doe/);
  });
});

/* ------------------------------------------------------------------ helpers */

describe('helpers', () => {
  test('durations are W/D/H/M only', () => {
    assert.equal(v.parseDuration('P1D'), 86400000);
    assert.equal(v.parseDuration('PT15M'), 900000);
    assert.equal(v.parseDuration('P1W'), 7 * 86400000);
    assert.equal(v.parseDuration('P1M'), null);
    assert.equal(v.parseDuration('P'), null);
    assert.equal(v.parseDuration(''), null);
  });

  test('approval needs a name and a date', () => {
    assert.equal(v.isApproved(APPROVED), true);
    assert.equal(v.isApproved({ approvedBy: 'x', approvedAt: null }), false);
    assert.equal(v.isApproved({ approvedBy: ' ', approvedAt: '2026-09-20' }), false);
    assert.equal(v.isApproved({ approvedBy: 'x', approvedAt: 'soon' }), false);
  });

  test('only CLEAN exits 0', () => {
    assert.equal(v.exitCodeFor('CLEAN'), 0);
    for (const verdict of ['RESIDUALS FOUND', 'INCOMPLETE', 'NOT EVIDENCE', 'anything else']) {
      assert.notEqual(v.exitCodeFor(verdict), 0);
    }
  });

  test('Langfuse batch body is { traceIds }, deduplicated and chunked', () => {
    const ids = Array.from({ length: 205 }, (_, i) => `t${i}`).concat(['t0', 't1']);
    const batches = v.buildLangfuseDeleteBatches(ids, 100);
    assert.equal(batches.length, 3);
    assert.deepEqual(Object.keys(batches[0]), ['traceIds']);
    assert.equal(batches[2].traceIds.length, 5);
    assert.equal(new Set(batches.flatMap((b) => b.traceIds)).size, 205);
  });

  test('final review · the Langfuse base url follows the writers, and a split between them is refused', () => {
    const keys = { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' };
    const resolve = (env) => v.resolveLangfuseBaseUrl({ ...keys, ...env });
    assert.deepEqual(resolve({ LANGFUSE_BASE_URL: 'https://b/', LANGFUSE_HOST: 'https://a' }), {
      url: 'https://b',
    });
    assert.deepEqual(resolve({ LANGFUSE_BASEURL: 'https://c' }), { url: 'https://c' });
    // Traces never read LANGFUSE_HOST; scores prefer it over LANGFUSE_BASEURL.
    const split = resolve({ LANGFUSE_BASEURL: 'https://c', LANGFUSE_HOST: 'https://a' });
    assert.equal(split.url, '');
    assert.match(split.problem, /traces go to https:\/\/c, scores to https:\/\/a/);
    assert.match(
      resolve({ LANGFUSE_HOST: 'https://a' }).problem,
      /traces go to https:\/\/cloud\.langfuse\.com, scores to https:\/\/a/,
    );
    // Keys without a URL: the app would fall back to Langfuse Cloud, but the verifier
    // never sends credentials to a host nobody named.
    const unnamed = resolve({});
    assert.equal(unnamed.url, '');
    assert.match(unnamed.problem, /no Langfuse base URL is set.*cloud\.langfuse\.com/);
    assert.deepEqual(v.resolveLangfuseBaseUrl({}), { url: '' });
  });

  test('final review · a split or unnamed Langfuse target is NOT PROBED, and nothing is called', async () => {
    const keys = { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' };
    for (const [env, reason] of [
      [{ ...keys, LANGFUSE_BASEURL: 'https://c', LANGFUSE_HOST: 'https://a' }, /writers disagree/],
      [keys, /no Langfuse base URL is set/],
    ]) {
      const r = await v.probeLangfuse({
        identity: IDENTITY,
        env,
        fetchImpl: async () => {
          throw new Error('must not be called');
        },
      });
      assert.equal(r['langfuse:traces'].status, 'not-probed');
      assert.match(r['langfuse:traces'].reason, reason);
    }
  });

  test('environment signals read the same variables the app does', () => {
    const s = v.environmentSignals({
      MEILI_HOST: 'h',
      SEARCH: 'true',
      USE_REDIS: 'true',
      LOG_TO_FILE: 'false',
      AZURE_SEARCH_ENABLED: 'true',
      RAG_API_URL: 'r',
      LANGFUSE_PUBLIC_KEY: 'pk',
      KNAUF_FILE_TRANSLATION_ENABLED: 'true',
      KNAUF_CODE_EXECUTION_ENABLED: 'true',
    });
    assert.deepEqual(s, { ...SIGNALS, 'blob:primary': false });
    assert.equal(v.environmentSignals({ MEILI_HOST: 'h', SEARCH: 'false' }).meili, false);
  });
});

/* ------------------------------------------------------------------ the paths under test */

describe('the deletion paths under test are the real ones', () => {
  test('account deletion is the JWT-guarded DELETE /api/user/delete', () => {
    const routes = read('api', 'server', 'routes', 'user.js');
    assert.match(
      routes,
      /router\.delete\('\/delete', requireJwtAuth, canDeleteAccount, .*deleteUserController\)/,
    );
  });

  test('deleteUserController reaches Blob + vectors via processDeleteRequest; config/delete-user.js does not', () => {
    // If someone teaches the ops script to call the cascade, this fails and runbook §1
    // must be updated.
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
// End [knauf]
