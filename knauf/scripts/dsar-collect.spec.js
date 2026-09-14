// [knauf] KK20-331 — pins the DSAR collector's pure logic. Run with:
//   npm run test:dsar
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  collect,
  MONGO_SINKS,
  NOT_SUBJECT_SCOPED,
  NOT_SUBJECT_SCOPED_RAW,
  EXTERNAL_SINKS,
  AUDIT_ACTOR_CONTEXT_FIELDS,
  initialExternalSinkState,
  reconcileExternalResult,
  derivedExpectedTotals,
  finalizeManifest,
  assertSecureExistingDir,
  replaceManifestAtomically,
  verifyBundleArtifact,
  runFinalize,
  prepareOutputDir,
  writeBundleFile,
  buildResultsReadme,
  RAW_COLLECTIONS,
  GROUP_SUBJECT_FIELDS,
  AmbiguousSubjectError,
  redactUserDocument,
  toExistenceOnly,
  groupMembershipKeys,
  toSubjectGroupView,
  redactAuditRows,
  redactFields,
  buildLangfuseCommands,
  buildMeilisearchQueries,
  classifyVectorStores,
  buildVectorInventoryRequest,
  sinkFilter,
  shapeRows,
  resolveSubject,
  parseArgs,
} = require('./dsar-collect');

const REPO = path.resolve(__dirname, '..', '..');

describe('inventory completeness', () => {
  // PR #349 review: pinning the inventory against deleteUserController cannot prove
  // completeness — the cascade is not an independent schema inventory, so anything
  // the cascade itself forgets stays invisible. This test reads the live model
  // registry instead and forces every registered model into exactly one of two
  // buckets: collected, or explicitly excluded with a reason.
  test('every registered model is either collected or explicitly excluded', () => {
    const src = fs.readFileSync(
      path.join(REPO, 'packages', 'data-schemas', 'src', 'models', 'index.ts'),
      'utf8',
    );
    const body = src.slice(src.indexOf('return {'));
    const registered = new Set(
      [...body.matchAll(/^\s{4}(\w+):\s*create\w+Model\(mongoose\)/gm)].map((m) => m[1]),
    );
    assert.ok(registered.size > 30, `expected the full registry, parsed ${registered.size}`);

    const collected = new Set(MONGO_SINKS.map((s) => s.model));
    const excluded = new Set(Object.keys(NOT_SUBJECT_SCOPED));

    const unaccounted = [...registered].filter((m) => !collected.has(m) && !excluded.has(m));
    assert.deepEqual(
      unaccounted,
      [],
      `model(s) ${unaccounted.join(', ')} are registered but neither collected nor listed in ` +
        'NOT_SUBJECT_SCOPED. A DSAR must decide about every store — add the sink or the reason.',
    );

    for (const m of collected) {
      assert.ok(registered.has(m), `MONGO_SINKS references ${m}, which is not a registered model`);
    }
    for (const m of excluded) {
      assert.ok(
        registered.has(m),
        `NOT_SUBJECT_SCOPED lists ${m}, which is not a registered model`,
      );
    }
  });

  test('the stores the review named are collected, not merely cascade-implied', () => {
    const collected = new Set(MONGO_SINKS.map((s) => s.model));
    for (const m of ['ChatProject', 'ChatProjectSource', 'KnaufFileAsset']) {
      assert.ok(collected.has(m), `${m} holds subject data and must be collected`);
    }
  });

  test('every store the cascade deletes is also a store the collector reads', () => {
    // Kept as a second, weaker check: erasure must never reach a store disclosure
    // does not. It no longer stands alone as the completeness argument.
    const src = fs.readFileSync(
      path.join(REPO, 'api', 'server', 'controllers', 'UserController.js'),
      'utf8',
    );
    const cascade = src.slice(
      src.indexOf('deleteUserController = async'),
      src.indexOf('module.exports'),
    );
    const expected = {
      deleteMessages: 'Message',
      deleteConvos: 'Conversation',
      deleteAllUserMemories: 'MemoryEntry',
      deleteFiles: 'File',
      deleteAllSharedLinksWithCleanup: 'SharedLink',
      deleteTransactions: 'Transaction',
      deleteBalances: 'Balance',
      deletePresets: 'Preset',
      deleteConversationTags: 'ConversationTag',
      deleteToolCalls: 'ToolCall',
      deleteAssistants: 'Assistant',
      deleteActions: 'Action',
      deleteUserAgents: 'Agent',
      deleteUserPrompts: 'Prompt',
      deleteUserSkills: 'Skill',
      deleteUserMcpServers: 'MCPServer',
      deleteAllAgentApiKeys: 'AgentApiKey',
      deleteUserPluginAuth: 'PluginAuth',
      deleteUserKey: 'Key',
      deleteTokens: 'Token',
      deleteAllUserSessions: 'Session',
      removeUserFromAllGroups: 'Group',
      deleteAclEntries: 'AclEntry',
    };
    const models = new Set(MONGO_SINKS.map((s) => s.model));
    for (const [call, model] of Object.entries(expected)) {
      assert.ok(cascade.includes(call), `cascade no longer calls ${call} — update this map`);
      assert.ok(models.has(model), `collector is missing ${model} (cascade calls ${call})`);
    }
    assert.ok(cascade.includes('purgeSchedulerDataForUser'));
    const rawNames = RAW_COLLECTIONS.map((r) => r.collection);
    for (const c of ['knauf_agent_schedules', 'knauf_scheduled_agent_runs']) {
      assert.ok(rawNames.includes(c), `${c} must stay collected`);
    }
  });
});

describe('redactions', () => {
  test('user document loses every security artefact and keeps identity', () => {
    const out = redactUserDocument({
      _id: 'u1',
      email: 'a@b.c',
      name: 'A',
      openidId: 'oid',
      password: 'h',
      totpSecret: 's',
      backupCodes: [{ codeHash: 'x' }],
      refreshToken: [{ refreshToken: 't' }],
      __v: 3,
    });
    for (const k of ['password', 'totpSecret', 'backupCodes', 'refreshToken', '__v'])
      assert.equal(out[k], undefined, k);
    assert.equal(out.email, 'a@b.c');
    assert.equal(out.openidId, 'oid');
  });

  test('existence-only rows never carry a secret value', () => {
    const row = toExistenceOnly({
      _id: 'k',
      userId: 'u',
      name: 'openai',
      value: 'sk-secret',
      createdAt: 1,
    });
    assert.equal(row.value, undefined);
    assert.equal(row.name, 'openai');
    assert.equal(row.createdAt, 1);
  });

  test('Art. 15(4): actor redacted when the subject is the target, kept when the subject is the actor', () => {
    const rows = redactAuditRows(
      [
        {
          seq: 1,
          actor: { type: 'user', id: 'admin1', name: 'Alice Admin' },
          target: { type: 'user', id: 'subj' },
        },
        {
          seq: 2,
          actor: { type: 'user', id: 'subj', name: 'The Subject' },
          target: { type: 'role', id: 'ADMIN' },
        },
      ],
      'subj',
    );
    assert.equal(rows[0]._dsarRole, 'target');
    assert.equal(rows[0].actor.id, undefined);
    assert.match(rows[0].actor.name, /redacted/);
    assert.equal(rows[1]._dsarRole, 'actor');
    assert.equal(rows[1].actor.name, 'The Subject');
  });
});

describe('group membership (PR #349 review)', () => {
  // userGroup.js writes `user.idOnTheSource || userId.toString()` into memberIds, so
  // an Entra-sourced subject is never a member under their Mongo _id.
  test('membership key prefers idOnTheSource and keeps _id as fallback', () => {
    assert.deepEqual(groupMembershipKeys({ _id: 'm1', idOnTheSource: 'entra-1' }), [
      'entra-1',
      'm1',
    ]);
    assert.deepEqual(groupMembershipKeys({ _id: 'm1' }), ['m1']);
  });

  test('the Group filter queries both keys, so Entra memberships are not missed', () => {
    const sink = MONGO_SINKS.find((s) => s.model === 'Group');
    const filter = sinkFilter(sink, { _id: 'm1', idOnTheSource: 'entra-1' });
    assert.deepEqual(filter, { memberIds: { $in: ['entra-1', 'm1'] } });
  });

  test('the exported group view never discloses another member', () => {
    const view = toSubjectGroupView(
      {
        _id: 'g1',
        name: 'Engineering',
        description: 'eng',
        source: 'entra',
        idOnTheSource: 'grp-1',
        memberIds: ['entra-1', 'someone-else', 'a-third-person'],
      },
      ['entra-1', 'm1'],
    );
    assert.equal(view.memberIds, undefined);
    assert.ok(!JSON.stringify(view).includes('someone-else'));
    assert.ok(!JSON.stringify(view).includes('a-third-person'));
    assert.equal(view._dsarMembershipKey, 'entra-1');
    assert.equal(view._dsarMemberCount, 3);
    assert.equal(view.name, 'Engineering');
    assert.ok(!GROUP_SUBJECT_FIELDS.includes('memberIds'));
  });

  test('shapeRows applies the group projection through the normal write path', () => {
    const sink = MONGO_SINKS.find((s) => s.model === 'Group');
    const shaped = shapeRows(sink, [{ _id: 'g1', name: 'G', memberIds: ['x', 'other'] }], {
      _id: 'x',
    });
    assert.equal(shaped[0].memberIds, undefined);
    assert.equal(shaped[0]._dsarMembershipKey, 'x');
  });
});

describe('subject resolution is tenant-safe (PR #349 review)', () => {
  // email is unique only within (email, tenantId); this script runs under
  // runAsSystem, which disables tenant injection, so findOne() could export the
  // wrong person entirely.
  const fakeModels = (rows) => ({
    User: {
      // `resolveSubject` calls findOne({ _id, ...scope }) then find({ ...scope, $or }).
      findOne: (filter) => ({
        lean: async () =>
          rows.find(
            (r) =>
              String(r._id) === String(filter._id) &&
              (!filter.tenantId || r.tenantId === filter.tenantId),
          ) ?? null,
      }),
      find: (filter) => ({
        lean: async () =>
          rows.filter(
            (r) =>
              (!filter.tenantId || r.tenantId === filter.tenantId) &&
              filter.$or.some((clause) => {
                const [[key, value]] = Object.entries(clause);
                return r[key] === value;
              }),
          ),
      }),
    },
  });

  const users = [
    { _id: 'a1', email: 'dup@knauf.com', tenantId: 't1' },
    { _id: 'b2', email: 'dup@knauf.com', tenantId: 't2' },
    { _id: 'c3', email: 'solo@knauf.com', tenantId: 't1' },
  ];

  test('refuses an email that matches in more than one tenant', async () => {
    await assert.rejects(
      () => resolveSubject(fakeModels(users), 'dup@knauf.com'),
      (err) => {
        assert.ok(err instanceof AmbiguousSubjectError);
        assert.deepEqual(err.tenantIds.sort(), ['t1', 't2']);
        assert.match(err.message, /--tenant/);
        return true;
      },
    );
  });

  test('--tenant disambiguates the same email', async () => {
    const found = await resolveSubject(fakeModels(users), 'dup@knauf.com', 't2');
    assert.equal(found._id, 'b2');
  });

  test('a unique email still resolves', async () => {
    const found = await resolveSubject(fakeModels(users), 'solo@knauf.com');
    assert.equal(found._id, 'c3');
  });

  test('no match returns null rather than throwing', async () => {
    assert.equal(await resolveSubject(fakeModels(users), 'nobody@knauf.com'), null);
  });
});

describe('external-sink commands page to exhaustion (PR #349 review)', () => {
  // Fixed `for p in 1..10` loops silently truncated accounts above 1,000 traces /
  // 500 scores and still exited 0. A successful run must now prove completeness.
  test('Langfuse script pages on totalPages and fails when counts disagree', () => {
    const sh = buildLangfuseCommands('507f1f77bcf86cd799439011');
    assert.match(sh, /traces list --fields core,io,observations/);
    assert.match(sh, /scores list --fields score,trace/);
    assert.match(sh, /--user-id "\$SUBJECT"/);
    assert.match(sh, /set -euo pipefail/);
    assert.match(sh, /totalPages/);
    assert.match(sh, /totalItems/);
    assert.match(sh, /collected \$seen rows but API reports \$total_items/);
    assert.match(sh, /MAX_PAGES/);
    assert.match(sh, /RETRIES/);
    assert.match(sh, /timeout "\$TIMEOUT"/);
    // the truncating loop is gone
    assert.ok(!/for p in 1 2 3/.test(sh), 'fixed page loop must not come back');
  });

  test('Langfuse script is valid bash', () => {
    const sh = buildLangfuseCommands('507f1f77bcf86cd799439011');
    const tmp = path.join(
      fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dsar-')),
      'langfuse.sh',
    );
    fs.writeFileSync(tmp, sh);
    const res = require('node:child_process').spawnSync('bash', ['-n', tmp], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  });

  test('Meilisearch recipe uses page/hitsPerPage for an exact total, not a single limit page', () => {
    const md = buildMeilisearchQueries('abc');
    assert.match(md, /"user = abc"/);
    assert.match(md, /hitsPerPage/);
    assert.match(md, /totalHits/);
    assert.match(md, /totalPages/);
    assert.ok(!/"limit":\s*1000/.test(md), 'offset/limit only reports estimatedTotalHits');
  });
});

describe('vector identity follows the FileAsset ledger (PR #349 review)', () => {
  // The physical vector id is `knauf_asset_id ?? file_id` (VectorDB/crud.js) and the
  // backend is recorded on the asset, not inferred from `context`.
  const files = [
    { file_id: 'logical-a', knauf_asset_id: 'asset-a', embedded: true, context: 'agents' },
    { file_id: 'logical-b', knauf_asset_id: 'asset-b', embedded: true, context: 'agents' },
    { file_id: 'legacy-c', embedded: true, context: 'message_attachment' },
  ];
  const assets = [
    {
      asset_id: 'asset-a',
      vector_backend: 'azure_search',
      status: 'ready',
      active_generation: 3,
      stale_generations: [1, 2],
    },
    // context says 'agents' but the ledger says pgvector — the ledger wins.
    { asset_id: 'asset-b', vector_backend: 'pgvector', status: 'ready', active_generation: 1 },
  ];

  test('reports the physical id, not the logical file_id', () => {
    const v = classifyVectorStores(files, assets);
    assert.deepEqual(v.azureAiSearch, ['asset-a']);
    assert.ok(!JSON.stringify(v.azureAiSearch).includes('logical-a'));
  });

  test('the ledger overrides the context heuristic', () => {
    const v = classifyVectorStores(files, assets);
    assert.ok(v.pgvector.includes('asset-b'), 'asset-b is pgvector per vector_backend');
    assert.ok(!v.azureAiSearch.includes('asset-b'));
  });

  test('stale generations are surfaced as outstanding cleanup debt', () => {
    const v = classifyVectorStores(files, assets);
    assert.deepEqual(v.staleGenerationDebt, [{ vectorId: 'asset-a', staleGenerations: [1, 2] }]);
  });

  test('a file with no asset row is marked unverified rather than asserted', () => {
    const v = classifyVectorStores(files, assets);
    assert.deepEqual(v.unverified, ['legacy-c']);
    const legacy = v.entries.find((e) => e.vectorId === 'legacy-c');
    assert.equal(legacy.unverified, true);
    assert.match(legacy.note, /confirm with the RAG service/);
  });

  test('the RAG service gets an exact tenant-scoped id list to confirm', () => {
    const v = classifyVectorStores(files, assets);
    const req = buildVectorInventoryRequest('u1', 'tenant-9', v);
    assert.equal(req.subject, 'u1');
    assert.equal(req.tenantId, 'tenant-9');
    assert.deepEqual(req.azureAiSearch, ['asset-a']);
    assert.deepEqual(req.unverifiedBackend, ['legacy-c']);
    assert.match(req.askTheRagService, /physical vector ids/);
  });
});

describe('physical assets resolve by OWNERSHIP, not agent scope', () => {
  // process.js writes createFile({ user: req.user.id, knauf_asset_id }), so the File
  // row's owner is the uploader regardless of who authored the agent. Selecting a whole
  // agent scope both over-discloses (a collaborator's uploads to the subject's agent)
  // and under-collects (the subject's uploads to someone else's agent).
  const sink = () => MONGO_SINKS.find((k) => k.model === 'KnaufFileAsset');

  test('never selects an entire agent scope', () => {
    const filter = sinkFilter(sink(), { _id: 'u1', _dsarAssetIds: ['asset-a'] });
    const json = JSON.stringify(filter);
    assert.ok(!json.includes("'agent'"), 'must not select by agent scope');
    assert.ok(!json.includes('"agent"'), 'must not select by agent scope');
  });

  test('includes assets the subject uploaded to ANOTHER user\u2019s agent', () => {
    // The subject's File row carries knauf_asset_id even though the agent is not theirs.
    const filter = sinkFilter(sink(), { _id: 'u1', _dsarAssetIds: ['asset-on-foreign-agent'] });
    const byAsset = filter.$or.find((c) => c.asset_id);
    assert.ok(byAsset, 'must query by owned asset ids');
    assert.ok(byAsset.asset_id.$in.includes('asset-on-foreign-agent'));
  });

  test('excludes a collaborator\u2019s uploads to an agent the subject authored', () => {
    // Only ids drawn from the SUBJECT's File rows are queried; a collaborator's asset
    // never enters the list, so authoring the agent does not disclose their upload.
    const filter = sinkFilter(sink(), { _id: 'u1', _dsarAssetIds: ['mine-1'] });
    const byAsset = filter.$or.find((c) => c.asset_id);
    assert.deepEqual(byAsset.asset_id.$in, ['mine-1']);
    assert.ok(!JSON.stringify(filter).includes('collaborator'));
  });

  test('user-scope assets are still included', () => {
    const filter = sinkFilter(sink(), { _id: 'u1', _dsarAssetIds: ['a'] });
    const byScope = filter.$or.find((c) => c.scope_type === 'user');
    assert.ok(byScope.scope_id.$in.includes('u1'));
  });

  test('no owned assets collapses to the user-scope query alone', () => {
    const filter = sinkFilter(sink(), { _id: 'u1' });
    assert.equal(filter.$or, undefined);
    assert.equal(filter.scope_type, 'user');
  });
});

describe('third-party field redaction', () => {
  // Restored in round 3: this suite was lost while reworking the external-sink tests.
  // It guards the round-1 finding that the manifest CLAIMED grantedBy was redacted
  // while nothing redacted it.
  test('SystemGrant.grantedBy is replaced, not merely documented', () => {
    const sink = MONGO_SINKS.find((k) => k.model === 'SystemGrant');
    assert.deepEqual(sink.redactFields, ['grantedBy']);
    const [row] = shapeRows(
      sink,
      [{ _id: 'g', principalId: 'u1', capability: 'SKILLS.USE', grantedBy: 'admin-7' }],
      { _id: 'u1' },
    );
    assert.match(row.grantedBy, /redacted/);
    assert.ok(!JSON.stringify(row).includes('admin-7'));
    assert.equal(row.capability, 'SKILLS.USE', 'the subject still sees their own capability');
  });

  test('redactFields leaves absent fields absent rather than inventing them', () => {
    const out = redactFields({ a: 1 }, ['grantedBy']);
    assert.equal('grantedBy' in out, false);
    assert.equal(out.a, 1);
  });

  test('translation-job operational fields are redacted, subject content is not', () => {
    const raw = RAW_COLLECTIONS.find((r) => r.collection === 'knauf_translation_jobs');
    const out = redactFields(
      {
        user: 'u1',
        input_files: [{ filename: 'contract.docx' }],
        preserve_terms: ['Knauf'],
        lease_owner: 'worker-3',
        execution_token: 'tok-secret',
      },
      raw.redactFields,
    );
    assert.match(out.lease_owner, /redacted/);
    assert.match(out.execution_token, /redacted/);
    assert.ok(!JSON.stringify(out).includes('tok-secret'));
    assert.equal(out.input_files[0].filename, 'contract.docx', 'the subject keeps their filenames');
    assert.deepEqual(out.preserve_terms, ['Knauf']);
  });
});

describe('manifest replacement is crash-safe', () => {
  const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsar-mf-'));

  test('replaceManifestAtomically leaves 0600 and no temp file behind', () => {
    const dir = prepareOutputDir(path.join(tmpdir(), 'b'));
    writeBundleFile(dir, 'manifest.json', '{"v":1}');
    replaceManifestAtomically(dir, { v: 2 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).v, 2);
    assert.equal(fs.statSync(path.join(dir, 'manifest.json')).mode & 0o777, 0o600);
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.startsWith('.manifest')),
      [],
    );
  });

  test('a stale temp file from a crashed run does not block the next one', () => {
    const dir = prepareOutputDir(path.join(tmpdir(), 'b'));
    writeBundleFile(dir, 'manifest.json', '{"v":1}');
    fs.writeFileSync(path.join(dir, `.manifest.${process.pid}.tmp`), 'garbage', { mode: 0o600 });
    replaceManifestAtomically(dir, { v: 3 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).v, 3);
  });

  test('finalizeManifest clears stale externalSinks warnings instead of duplicating them', () => {
    const manifest = {
      sinks: {},
      externalSinks: initialExternalSinkState(),
      completeness: {
        ok: false,
        warnings: ['externalSinks: langfuse is pending — x', 'other: keep me'],
      },
    };
    finalizeManifest(manifest, '/tmp/nowhere', () => null);
    const langfuseWarnings = manifest.completeness.warnings.filter((w) => w.includes('langfuse'));
    assert.equal(langfuseWarnings.length, 1, 'must not accumulate duplicates across runs');
    assert.ok(
      manifest.completeness.warnings.includes('other: keep me'),
      'unrelated warnings survive',
    );
  });
});

describe('cli', () => {
  test('parses flags and defaults logs to off', () => {
    const a = parseArgs(['--user', 'x@y.z', '--out', './o', '--tenant', 't1', '--include-logs']);
    assert.deepEqual(a, { user: 'x@y.z', out: './o', tenant: 't1', includeLogs: true });
    assert.equal(parseArgs(['--user', 'u']).includeLogs, false);
  });
});

/* ---------------------------------------------------- PR #349 review, round 2 */

describe('dynamically registered raw collections are inventoried', () => {
  // The registry sweep can only see models created through `createModels()`.
  // `knauf_translation_jobs` is registered lazily inside the translation service, so
  // a registry-only check reported full coverage while a store holding the subject's
  // filenames, locales, protected terms and job reports went uncollected.
  test('knauf_translation_jobs is collected with tenant filtering and redactions', () => {
    const raw = RAW_COLLECTIONS.find((r) => r.collection === 'knauf_translation_jobs');
    assert.ok(raw, 'knauf_translation_jobs must be collected');
    assert.equal(raw.field, 'user');
    assert.equal(raw.tenantField, 'tenantId');
    for (const f of ['lease_owner', 'execution_token', 'idempotency_key', 'request_key']) {
      assert.ok(raw.redactFields.includes(f), `${f} must be redacted`);
    }
  });

  test('every `collection:` declared in the tree is collected or explicitly excluded', () => {
    // Independent of BOTH registration mechanisms: grep the source for collection
    // names rather than trusting any one registry.
    const roots = [path.join(REPO, 'api'), path.join(REPO, 'packages')];
    const found = new Set();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(js|ts)$/.test(e.name) || /\.(spec|test)\./.test(e.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        // Self-review: matching only `collection: '<name>'` schema options made this
        // control weaker than advertised — nearly every raw collection here is reached
        // via `db.collection('<name>')`, which that pattern cannot see. Match both.
        for (const m of src.matchAll(/collection:\s*'([a-z0-9_]+)'/g)) found.add(m[1]);
        for (const m of src.matchAll(/\.collection\(\s*'([a-z0-9_]+)'\s*\)/g)) found.add(m[1]);
      }
    };
    roots.forEach(walk);
    assert.ok(found.size > 0, 'expected to discover at least one collection declaration');

    const collected = new Set(RAW_COLLECTIONS.map((r) => r.collection));
    const excluded = new Set(Object.keys(NOT_SUBJECT_SCOPED_RAW));
    const unaccounted = [...found].filter((c) => !collected.has(c) && !excluded.has(c));
    assert.deepEqual(
      unaccounted,
      [],
      `raw collection(s) ${unaccounted.join(', ')} are declared in the app but neither ` +
        'collected nor listed in NOT_SUBJECT_SCOPED_RAW.',
    );
  });
});

describe('audit rows leak no third-party request context', () => {
  // `buildAuditContext(req)` records the ACTING ADMIN's ip/userAgent/requestId, so
  // blanking actor.name while shipping context.ip still identifies them.
  const rows = [
    {
      seq: 1,
      actor: { type: 'user', id: 'admin-7', name: 'Alice Admin' },
      target: { type: 'user', id: 'subj' },
      context: {
        ip: '10.1.2.3',
        userAgent: 'Mozilla/5.0 AdminBrowser',
        sessionId: 'sess-admin-7',
        requestId: 'req-abc',
      },
    },
    {
      seq: 2,
      actor: { type: 'user', id: 'subj', name: 'The Subject' },
      target: { type: 'role', id: 'ADMIN' },
      context: { ip: '192.168.0.9', userAgent: 'SubjectBrowser' },
    },
  ];

  test('target-only rows carry no actor ip/userAgent/sessionId/requestId', () => {
    const out = redactAuditRows(rows, 'subj');
    const serialized = JSON.stringify(out[0]);
    for (const v of ['10.1.2.3', 'AdminBrowser', 'sess-admin-7', 'req-abc', 'admin-7']) {
      assert.ok(!serialized.includes(v), `target row must not disclose ${v}`);
    }
    assert.match(out[0].context, /redacted/);
  });

  test('the subject’s own rows keep their context — it is their data', () => {
    const out = redactAuditRows(rows, 'subj');
    assert.equal(out[1].context.ip, '192.168.0.9');
    assert.equal(out[1]._dsarRole, 'actor');
  });

  test('every documented actor-context field is covered by the assertion above', () => {
    assert.deepEqual(AUDIT_ACTOR_CONTEXT_FIELDS, ['ip', 'userAgent', 'sessionId', 'requestId']);
  });

  test('a row without context is left alone rather than given a redaction marker', () => {
    const [out] = redactAuditRows(
      [{ seq: 9, actor: { id: 'admin-1' }, target: { id: 'subj' } }],
      'subj',
    );
    assert.equal('context' in out, false);
  });
});

describe('external sinks are pending until verified', () => {
  const ok = {
    status: 'complete',
    collected: 5,
    expected: 5,
    artifact: 'results/a.jsonl',
    checksum: 'abc',
  };
  const pass = () => 'abc';

  test('every external sink starts pending', () => {
    const state = initialExternalSinkState();
    assert.equal(Object.keys(state).length, EXTERNAL_SINKS.length);
    for (const [, v] of Object.entries(state)) assert.equal(v.status, 'pending');
    for (const k of ['langfuse', 'meilisearch', 'blob', 'ragVectors', 'logPlatform']) {
      assert.ok(state[k], `${k} must be tracked`);
    }
  });

  test('a missing result stays pending', () => {
    assert.equal(reconcileExternalResult('langfuse', null).status, 'pending');
  });

  test('complete REQUIRES an artifact and a checksum', () => {
    const r = reconcileExternalResult('langfuse', {
      status: 'complete',
      collected: 5,
      expected: 5,
    });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /artifact.*checksum/);
  });

  test('a checksum that does not match the artifact fails', () => {
    const r = reconcileExternalResult('langfuse', ok, { verifyArtifact: () => 'DIFFERENT' });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /checksum mismatch/);
  });

  test('an unreadable artifact fails rather than being skipped', () => {
    const r = reconcileExternalResult('langfuse', ok, {
      verifyArtifact: () => {
        throw new Error('ENOENT');
      },
    });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /artifact unreadable/);
  });

  test('a DERIVED sink is measured against our number, and ignores the operator\u2019s', () => {
    // expected: 999 is a lie; the collector derived 5 from phase one.
    const good = reconcileExternalResult(
      'meilisearch',
      { ...ok, collected: 5, expected: 999 },
      { derivedExpected: 5, verifyArtifact: pass },
    );
    assert.equal(good.status, 'complete');
    assert.equal(good.expected, 5);
    assert.equal(good.expectationSource, 'derived-from-phase-one');

    const short = reconcileExternalResult(
      'meilisearch',
      { ...ok, collected: 5, expected: 5 },
      { derivedExpected: 2500, verifyArtifact: pass },
    );
    assert.equal(short.status, 'failed', 'self-consistent numbers must not pass a derived sink');
    assert.match(short.reason, /phase one derived 2500/);
  });

  test('a sink with no derivable expectation is marked self-reported, not verified', () => {
    const r = reconcileExternalResult('langfuse', ok, { verifyArtifact: pass });
    assert.equal(r.status, 'complete');
    assert.match(r.expectationSource, /self-reported/);
  });

  test('non-numeric collected is a failure', () => {
    const r = reconcileExternalResult(
      'blob',
      { ...ok, collected: 'all' },
      { verifyArtifact: pass },
    );
    assert.equal(r.status, 'failed');
  });

  test('not-applicable demands a written reason', () => {
    assert.equal(
      reconcileExternalResult('logPlatform', { status: 'not-applicable' }).status,
      'failed',
    );
    assert.equal(
      reconcileExternalResult('logPlatform', { status: 'not-applicable', note: 'no userId' })
        .status,
      'not-applicable',
    );
  });

  test('derived expectations come from phase one\u2019s own counts', () => {
    const d = derivedExpectedTotals({
      sinks: {
        Message: 1200,
        Conversation: 40,
        MessageIndexable: 1170,
        ConversationIndexable: 38,
        blob: { objects: 7 },
        vectorStores: { pgvector: 3, azureAiSearch: 2 },
      },
    });
    assert.equal(d.blob, 7);
    assert.equal(d.ragVectors, 5);
    assert.equal(d.langfuse, undefined, 'Langfuse is not derived from Mongo');
    assert.equal(d.logPlatform, undefined, 'the log platform is not derived from Mongo');
  });

  test('Meilisearch is measured against the INDEXABLE subset, not every Mongo row', () => {
    // mongoMeili keeps temporary/expiring chats out of the index, so the replica is
    // legitimately smaller than Mongo. Deriving from raw counts REJECTED correct exports.
    const d = derivedExpectedTotals({
      sinks: {
        Message: 1200,
        Conversation: 40,
        MessageIndexable: 1170,
        ConversationIndexable: 38,
      },
    });
    assert.equal(d.meilisearch, 1208, '1170 + 38 indexable, not 1200 + 40');
    assert.notEqual(d.meilisearch, 1240, 'the raw total would fail a correct export');
  });

  test('a correct export of a subject with temporary chats is ACCEPTED', () => {
    const manifest = {
      sinks: { Message: 1200, Conversation: 40, MessageIndexable: 1170, ConversationIndexable: 38 },
      externalSinks: initialExternalSinkState(),
      completeness: { ok: false, warnings: [] },
    };
    const r = reconcileExternalResult(
      'meilisearch',
      { status: 'complete', collected: 1208, artifact: 'results/m.jsonl', checksum: 'abc' },
      { derivedExpected: derivedExpectedTotals(manifest).meilisearch, verifyArtifact: () => 'abc' },
    );
    assert.equal(r.status, 'complete', r.reason);
  });

  test('a bundle with no indexable counts falls back to self-reported, not rejection', () => {
    // Older bundles predate the *Indexable counts; they must not be failed on a
    // number we can no longer derive.
    const d = derivedExpectedTotals({ sinks: { Message: 10, Conversation: 2 } });
    assert.equal(d.meilisearch, undefined);
    const r = reconcileExternalResult(
      'meilisearch',
      { status: 'complete', collected: 12, expected: 12, artifact: 'a', checksum: 'x' },
      { derivedExpected: d.meilisearch, verifyArtifact: () => 'x' },
    );
    assert.equal(r.status, 'complete');
    assert.match(r.expectationSource, /self-reported/);
  });
});

describe('the bundle directory refuses unsafe destinations', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsar-out-'));

  test('creates a fresh directory at 0700', () => {
    const base = tmp();
    const out = prepareOutputDir(path.join(base, 'bundle'));
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  });

  test('refuses a symlink', () => {
    const base = tmp();
    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    assert.throws(() => prepareOutputDir(link), /symlink/i);
  });

  test('refuses a non-empty directory', () => {
    const base = tmp();
    const out = path.join(base, 'used');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'stale.json'), '{}');
    assert.throws(() => prepareOutputDir(out), /non-empty/i);
  });

  test('refuses a path that exists as a file', () => {
    const base = tmp();
    const f = path.join(base, 'afile');
    fs.writeFileSync(f, 'x');
    assert.throws(() => prepareOutputDir(f), /not a directory/i);
  });

  test('an empty existing directory is accepted and tightened to 0700', () => {
    const base = tmp();
    const out = path.join(base, 'empty');
    fs.mkdirSync(out, { mode: 0o755 });
    fs.chmodSync(out, 0o755);
    prepareOutputDir(out);
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  });

  test('bundle files are 0600 and never silently overwritten', () => {
    const out = prepareOutputDir(path.join(tmp(), 'bundle'));
    const f = writeBundleFile(out, 'users.json', '{}');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.throws(() => writeBundleFile(out, 'users.json', '{}'), /EEXIST/);
  });

  test('nested bundle paths inherit 0700 / 0600', () => {
    const out = prepareOutputDir(path.join(tmp(), 'bundle'));
    const f = writeBundleFile(out, 'results/README.md', '# x');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
  });

  test('the emitted langfuse script is not world-readable or executable', () => {
    const out = prepareOutputDir(path.join(tmp(), 'bundle'));
    const f = writeBundleFile(out, 'langfuse.sh', buildLangfuseCommands('u1'));
    const mode = fs.statSync(f).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(mode & 0o111, 0, 'must not be executable — run it with `bash langfuse.sh`');
  });
});

/* ------------------------------------------- two-phase CLI integration (round 3) */

describe('collect -> results -> finalize round-trip', () => {
  // The round-2 helper tests passed while the DOCUMENTED flow was broken: --finalize
  // re-ran collect(), which threw EEXIST on users.json before reading any result. These
  // exercise the real artifacts on a real filesystem, which is what catches that class.
  const crypto = require('node:crypto');
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsar-e2e-'));
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  /** Build a phase-one-shaped bundle without a database. */
  function seedBundle(overrides = {}) {
    const dir = prepareOutputDir(path.join(tmp(), 'bundle'));
    const manifest = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      subject: { _id: 'u1' },
      tenant: { resolved: 't1' },
      sinks: {
        Message: 10,
        Conversation: 2,
        MessageIndexable: 10,
        ConversationIndexable: 2,
        blob: { objects: 3 },
        vectorStores: { pgvector: 1, azureAiSearch: 1 },
        ...(overrides.sinks ?? {}),
      },
      externalSinks: initialExternalSinkState(),
      completeness: {
        ok: false,
        warnings: EXTERNAL_SINKS.map((e) => `externalSinks: ${e.key} is pending — ${e.runbook}`),
      },
    };
    writeBundleFile(dir, 'manifest.json', JSON.stringify(manifest, null, 2));
    writeBundleFile(dir, 'users.json', JSON.stringify({ _id: 'u1' }));
    writeBundleFile(dir, 'results/README.md', buildResultsReadme());
    return dir;
  }

  /** Drop a verified result, hashing a real artifact on disk. */
  function putResult(dir, file, artifactName, collected, extra = {}) {
    const body = Buffer.from(`artifact for ${artifactName}\n`);
    writeBundleFile(dir, `results/${artifactName}`, body);
    writeBundleFile(
      dir,
      `results/${file}`,
      JSON.stringify({
        status: 'complete',
        collected,
        expected: collected,
        artifact: `results/${artifactName}`,
        checksum: sha(body),
        ...extra,
      }),
    );
  }

  function seedAllResults(dir) {
    putResult(dir, 'langfuse.json', 'langfuse.jsonl', 42);
    putResult(dir, 'meilisearch.json', 'meili.jsonl', 12); // derived: 10 + 2
    putResult(dir, 'blob.json', 'blob.jsonl', 3);
    putResult(dir, 'rag-vectors.json', 'rag.jsonl', 2);
    writeBundleFile(
      dir,
      'results/log-platform.json',
      JSON.stringify({ status: 'not-applicable', note: 'platform cannot query by userId' }),
    );
    writeBundleFile(
      dir,
      'results/redis.json',
      JSON.stringify({ status: 'not-applicable', note: 'USE_REDIS is off in this environment' }),
    );
  }

  test('finalize does NOT collide with the phase-one bundle (the round-2 bug)', () => {
    const dir = seedBundle();
    seedAllResults(dir);
    // The whole point: this must not throw EEXIST on users.json.
    const m = runFinalize(dir, () => {});
    assert.equal(m.completeness.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'))._id, 'u1');
  });

  test('a pending sink keeps the bundle incomplete and names what is missing', () => {
    const dir = seedBundle();
    putResult(dir, 'langfuse.json', 'langfuse.jsonl', 42);
    const m = runFinalize(dir, () => {});
    assert.equal(m.completeness.ok, false);
    assert.ok(m.completeness.warnings.some((w) => w.includes('meilisearch')));
    assert.ok(m.completeness.warnings.some((w) => w.includes('logPlatform')));
  });

  test('a DERIVED sink whose count disagrees with phase one fails', () => {
    const dir = seedBundle();
    putResult(dir, 'langfuse.json', 'langfuse.jsonl', 42);
    putResult(dir, 'blob.json', 'blob.jsonl', 3);
    putResult(dir, 'rag-vectors.json', 'rag.jsonl', 2);
    writeBundleFile(
      dir,
      'results/log-platform.json',
      JSON.stringify({ status: 'not-applicable', note: 'platform cannot query by userId' }),
    );
    writeBundleFile(
      dir,
      'results/redis.json',
      JSON.stringify({ status: 'not-applicable', note: 'USE_REDIS is off' }),
    );
    // Meilisearch self-reports a consistent 11/11, but phase one counted
    // 10 messages + 2 convos = 12. Our number wins.
    putResult(dir, 'meilisearch.json', 'meili.jsonl', 11);
    const m = runFinalize(dir, () => {});
    assert.equal(m.completeness.ok, false);
    assert.equal(m.externalSinks.meilisearch.status, 'failed');
    assert.match(m.externalSinks.meilisearch.reason, /phase one derived 12/);
  });

  test('a tampered artifact fails the checksum', () => {
    const dir = seedBundle();
    seedAllResults(dir);
    fs.writeFileSync(path.join(dir, 'results/blob.jsonl'), 'TAMPERED', { mode: 0o600 });
    const m = runFinalize(dir, () => {});
    assert.equal(m.externalSinks.blob.status, 'failed');
    assert.match(m.externalSinks.blob.reason, /checksum mismatch/);
    assert.equal(m.completeness.ok, false);
  });

  test('a partial artifact (truncated export) fails', () => {
    const dir = seedBundle();
    seedAllResults(dir);
    const f = path.join(dir, 'results/rag.jsonl');
    fs.writeFileSync(f, fs.readFileSync(f).subarray(0, 4), { mode: 0o600 });
    const m = runFinalize(dir, () => {});
    assert.equal(m.externalSinks.ragVectors.status, 'failed');
  });

  test('an artifact pointing outside the bundle is refused', () => {
    const dir = seedBundle();
    seedAllResults(dir);
    fs.rmSync(path.join(dir, 'results/blob.json'));
    writeBundleFile(
      dir,
      'results/blob.json',
      JSON.stringify({
        status: 'complete',
        collected: 3,
        artifact: '../../../etc/hostname',
        checksum: 'whatever',
      }),
    );
    const m = runFinalize(dir, () => {});
    assert.equal(m.externalSinks.blob.status, 'failed');
    assert.match(m.externalSinks.blob.reason, /escapes the bundle/);
  });

  test('the manifest is replaced atomically, stays 0600, and leaves no temp file', () => {
    const dir = seedBundle();
    seedAllResults(dir);
    runFinalize(dir, () => {});
    const mp = path.join(dir, 'manifest.json');
    assert.equal(fs.statSync(mp).mode & 0o777, 0o600);
    assert.deepEqual(
      fs.readdirSync(dir).filter((f) => f.startsWith('.manifest')),
      [],
      'no temp file may survive',
    );
    assert.ok(JSON.parse(fs.readFileSync(mp, 'utf8')).finalizedAt);
  });

  test('finalize is idempotent — running twice does not corrupt the manifest', () => {
    const dir = seedBundle();
    seedAllResults(dir);
    const first = runFinalize(dir, () => {});
    const second = runFinalize(dir, () => {});
    assert.equal(second.completeness.ok, true);
    assert.deepEqual(second.completeness.warnings, []);
    assert.equal(second.subject._id, first.subject._id);
  });

  test('finalize refuses a symlinked bundle directory', () => {
    const dir = seedBundle();
    seedAllResults(dir);
    const link = path.join(path.dirname(dir), 'linked');
    fs.symlinkSync(dir, link);
    assert.throws(() => runFinalize(link, () => {}), /symlink/i);
  });

  test('finalize refuses a bundle reached through a symlinked ANCESTOR', () => {
    const base = tmp();
    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    const dir = seedBundle();
    fs.cpSync(dir, path.join(real, 'bundle'), { recursive: true });
    const linkedParent = path.join(base, 'parent-link');
    fs.symlinkSync(real, linkedParent);
    assert.throws(() => runFinalize(path.join(linkedParent, 'bundle'), () => {}), /symlink/i);
  });

  test('finalize refuses a directory with no phase-one manifest', () => {
    const dir = prepareOutputDir(path.join(tmp(), 'empty-bundle'));
    assert.throws(() => runFinalize(dir, () => {}), /No manifest\.json/);
  });

  test('finalize refuses a path that does not exist', () => {
    assert.throws(() => runFinalize(path.join(tmp(), 'nope'), () => {}), /does not exist/);
  });

  test('assertSecureExistingDir tightens the bundle to 0700', () => {
    const dir = seedBundle();
    fs.chmodSync(dir, 0o755);
    assertSecureExistingDir(dir);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  test('verifyBundleArtifact hashes the real file and rejects symlinked artifacts', () => {
    const dir = seedBundle();
    const body = Buffer.from('hello\n');
    writeBundleFile(dir, 'results/real.bin', body);
    assert.equal(verifyBundleArtifact('results/real.bin', dir), sha(body));
    fs.symlinkSync(path.join(dir, 'results/real.bin'), path.join(dir, 'results/link.bin'));
    assert.throws(() => verifyBundleArtifact('results/link.bin', dir), /symlink/);
  });
});

/* ------------------------------ collect() itself (self-review: it was untested) */

describe('collect() derives asset ownership from the subject\u2019s own File rows', () => {
  // Self-review blocker: the ownership fix lived entirely in collect(), which was
  // unexported and unreachable from the suite. sinkFilter() tests passed a hand-written
  // _dsarAssetIds, so the code that DERIVES it — the part the reviewer rejected twice —
  // had no coverage and could be regressed to the exact behaviour they rejected.
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsar-collect-'));

  /** Minimal model doubles that record the filters collect() actually issues. */
  function makeModels({ files = [], assets = [], seen = {} } = {}) {
    const model = (name, rows) => ({
      find: (filter) => {
        (seen[name] ??= []).push(filter);
        return { lean: async () => rows };
      },
      countDocuments: async (filter) => {
        (seen[`${name}:count`] ??= []).push(filter);
        return rows.length;
      },
    });
    const models = { File: model('File', files), KnaufFileAsset: model('KnaufFileAsset', assets) };
    for (const sink of MONGO_SINKS) {
      models[sink.model] ??= model(sink.model, []);
    }
    return models;
  }

  const mongooseDouble = {
    connection: {
      db: {
        collection: () => ({
          find: () => ({ toArray: async () => [], sort: () => ({ toArray: async () => [] }) }),
          countDocuments: async () => 0,
        }),
      },
    },
  };

  async function run({ files = [], assets = [], subject = {} } = {}) {
    const seen = {};
    const out = prepareOutputDir(path.join(tmp(), 'b'));
    const manifest = await collect({
      models: makeModels({ files, assets, seen }),
      mongoose: mongooseDouble,
      subject: { _id: 'u1', email: 'a@b.c', ...subject },
      tenantId: 't1',
      out,
      includeLogs: false,
      log: () => {},
    });
    return { manifest, seen, out };
  }

  test('asset ids come from the subject\u2019s File rows, not from agent authorship', async () => {
    const { seen, manifest } = await run({
      files: [
        { file_id: 'f1', knauf_asset_id: 'asset-1' },
        { file_id: 'f2', knauf_asset_id: 'asset-2' },
        { file_id: 'f3' }, // no physical asset
      ],
    });
    assert.equal(manifest.sinks.ownedAssetIds, 2);
    const assetFilter = seen.KnaufFileAsset.at(-1);
    const byAsset = assetFilter.$or.find((c) => c.asset_id);
    assert.deepEqual(byAsset.asset_id.$in, ['asset-1', 'asset-2']);
  });

  test('the asset query never selects an agent scope', async () => {
    const { seen } = await run({ files: [{ file_id: 'f1', knauf_asset_id: 'a1' }] });
    const json = JSON.stringify(seen.KnaufFileAsset.at(-1));
    assert.ok(!json.includes('"agent"'), 'regression: agent-scope selection is back');
  });

  test('duplicate knauf_asset_id values are de-duplicated', async () => {
    const { manifest } = await run({
      files: [
        { file_id: 'f1', knauf_asset_id: 'shared' },
        { file_id: 'f2', knauf_asset_id: 'shared' },
      ],
    });
    assert.equal(manifest.sinks.ownedAssetIds, 1);
  });

  test('a subject with no files produces a user-scope-only asset query', async () => {
    const { seen, manifest } = await run({ files: [] });
    assert.equal(manifest.sinks.ownedAssetIds, 0);
    assert.equal(seen.KnaufFileAsset.at(-1).$or, undefined);
    assert.equal(seen.KnaufFileAsset.at(-1).scope_type, 'user');
  });

  test('the File sink is read once and reused, not queried twice', async () => {
    const { seen } = await run({ files: [{ file_id: 'f1' }] });
    assert.equal(seen.File.length, 1, 'File must not be queried again inside the sink loop');
  });

  test('the avatar is enumerated even though it has no File row', async () => {
    const { manifest, out } = await run({
      subject: { avatar: 'https://blob/images/u1/avatar-123.png?sig=redacted' },
    });
    assert.equal(manifest.sinks.blob.avatars, 1);
    const objects = JSON.parse(fs.readFileSync(path.join(out, 'blob-objects.json'), 'utf8'));
    const avatar = objects.find((o) => o.source === 'users.avatar');
    assert.ok(avatar, 'the avatar must appear in blob-objects.json');
    assert.ok(!avatar.key.includes('sig='), 'the SAS signature must be stripped');
  });

  test('blob.objects counts every object the operator is told to pull', async () => {
    const { manifest } = await run({
      files: [{ file_id: 'f1', filepath: 'files/u1/a.pdf' }],
      assets: [{ asset_id: 'a1', blob: { path: 'files/u1/b.pdf' } }],
      subject: { avatar: 'https://blob/images/u1/avatar-1.png' },
    });
    // The derived blob expectation is measured against this, so it must include avatars.
    assert.equal(manifest.sinks.blob.objects, 3);
    assert.equal(manifest.sinks.blob.avatars, 1);
  });

  test('every external sink — Redis included — starts pending and blocks completeness', async () => {
    const { manifest } = await run({});
    assert.equal(manifest.completeness.ok, false);
    for (const sink of EXTERNAL_SINKS) {
      assert.equal(manifest.externalSinks[sink.key].status, 'pending', sink.key);
    }
    assert.ok(manifest.externalSinks.redis, 'Redis must be tracked');
  });

  test('the traversal helper never leaks into users.json', async () => {
    const { out } = await run({ files: [{ file_id: 'f1', knauf_asset_id: 'a1' }] });
    const user = JSON.parse(fs.readFileSync(path.join(out, 'users.json'), 'utf8'));
    assert.equal(user._dsarAssetIds, undefined);
    assert.equal(user._dsarAgentIds, undefined);
  });

  test('the email-keyed sink is filtered by the subject\u2019s normalised email', async () => {
    const { seen } = await run({ subject: { email: '  Ali@Knauf.COM ' } });
    assert.deepEqual(seen.MigrationAllowlist.at(-1), { emailNormalized: 'ali@knauf.com' });
  });

  test('a subject with no email cannot match every allowlist row', async () => {
    const { seen } = await run({ subject: { email: undefined } });
    assert.deepEqual(seen.MigrationAllowlist.at(-1), { emailNormalized: { $in: [] } });
  });

  test('Meilisearch indexable counts are recorded for the derived expectation', async () => {
    const { manifest, seen } = await run({});
    assert.equal(typeof manifest.sinks.MessageIndexable, 'number');
    assert.equal(typeof manifest.sinks.ConversationIndexable, 'number');
    const countFilter = seen['Message:count'].at(-1);
    assert.ok(countFilter.$or, 'must use the mongoMeili visibility predicate');
    assert.ok(countFilter.$or.some((c) => c.isTemporary === false));
  });
});
// End [knauf]
