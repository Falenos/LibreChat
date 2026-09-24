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
};

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
    return { key, configured: true, disposition: 'deleted', baseline: 'required' };
  });
  sinks.push(
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
    sinks: sinksWith(afterCount),
  };
  const langfuseDelete = {
    runId: 'run-1',
    identityDigest: 'id-digest',
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
    assert.deepEqual(e.obligations.map((o) => o.key).sort(), ['backup:mongo', 'idp:entra']);
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
  const blob = (classes) =>
    okResult(
      'blob:primary',
      Object.values(classes).reduce((a, b) => a + b, 0),
      { classes: { current: 0, versions: 0, snapshots: 0, softDeleted: 0, ...classes } },
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

    input.now = Date.parse('2026-10-02T00:00:00.000Z');
    input.after.generatedAt = new Date(input.now - 1000).toISOString();
    input.before.generatedAt = new Date(input.now - 2000).toISOString();
    // Deadline is measured from the baseline; move the baseline back past it.
    input.before.generatedAt = T0;
    assertNotClean(input);
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
}) {
  return {
    adapter,
    adapter_version: 1,
    backend,
    key,
    exact,
    inexact_reason: exact ? null : 'moved',
    total_chunks: total,
    groups,
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
    const container = fakeContainer(
      {
        [pointer]: {},
        [`images/${SUBJECT}/avatar-1.png`]: {}, // avatar — no File row
        [`uploads/${SUBJECT}/old.pdf`]: { versionId: 'v1', isCurrentVersion: false },
        [`uploads/${SUBJECT}/gone.pdf`]: { deleted: true },
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
    assert.equal(r.detail.withoutMongoPointer, 4);
    assert.ok(!r.detail.objects.some((n) => n.includes('someone-else')));
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
    containerClient: null,
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

  test('Langfuse base url resolution matches feedback.ts precedence', () => {
    assert.equal(v.resolveLangfuseBaseUrl({ LANGFUSE_HOST: 'https://a/' }), 'https://a');
    assert.equal(
      v.resolveLangfuseBaseUrl({ LANGFUSE_BASE_URL: 'https://b', LANGFUSE_HOST: 'https://a' }),
      'https://b',
    );
    assert.equal(v.resolveLangfuseBaseUrl({}), '');
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
