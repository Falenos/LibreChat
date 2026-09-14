// [knauf] KK20-331 — pins the DSAR collector's pure logic. Run with:
//   npm run test:dsar
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MONGO_SINKS,
  NOT_SUBJECT_SCOPED,
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
    assert.deepEqual(RAW_COLLECTIONS.map((r) => r.collection).sort(), [
      'knauf_agent_schedules',
      'knauf_scheduled_agent_runs',
    ]);
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

describe('KnaufFileAsset is queried by its own scope shape', () => {
  test('asset lookup uses scope_type/scope_id, not a user field', () => {
    const sink = MONGO_SINKS.find((s) => s.model === 'KnaufFileAsset');
    const filter = sinkFilter(sink, { _id: 'u1' });
    assert.equal(filter.scope_type, 'user');
    assert.deepEqual(filter.scope_id, { $in: ['u1', 'u1'] });
  });
});

describe('third-party field redaction', () => {
  test('SystemGrant.grantedBy is replaced, not merely documented', () => {
    const sink = MONGO_SINKS.find((s) => s.model === 'SystemGrant');
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
});

describe('principal-scoped sinks pin the principal type', () => {
  // principalId is Mixed and shared by user/group/role principals; without the
  // type pin a group's id could resolve as the subject's.
  test('Config and SystemGrant filter on principalType user', () => {
    for (const model of ['Config', 'SystemGrant']) {
      const filter = sinkFilter(
        MONGO_SINKS.find((s) => s.model === model),
        { _id: 'u1' },
      );
      assert.equal(filter.principalType, 'user', model);
      assert.deepEqual(filter.principalId, { $in: ['u1', 'u1'] }, model);
    }
  });

  test('sinks without a principalType are left unconstrained', () => {
    const filter = sinkFilter(
      MONGO_SINKS.find((s) => s.model === 'Message'),
      { _id: 'u1' },
    );
    assert.equal(filter.principalType, undefined);
  });
});

describe('cli', () => {
  test('parses flags and defaults logs to off', () => {
    const a = parseArgs(['--user', 'x@y.z', '--out', './o', '--tenant', 't1', '--include-logs']);
    assert.deepEqual(a, { user: 'x@y.z', out: './o', tenant: 't1', includeLogs: true });
    assert.equal(parseArgs(['--user', 'u']).includeLogs, false);
  });
});
// End [knauf]
