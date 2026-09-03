// [knauf] KK20-331 — pins the DSAR collector's pure logic. Run with:
//   npm run test:dsar
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MONGO_SINKS,
  RAW_COLLECTIONS,
  redactUserDocument,
  toExistenceOnly,
  redactAuditRows,
  buildLangfuseCommands,
  buildMeilisearchQueries,
  classifyVectorStores,
  parseArgs,
} = require('./dsar-collect');

describe('inventory mirrors the account-deletion cascade', () => {
  test('every store the cascade deletes is a store the collector reads', () => {
    // Access mirrors erasure. This pins the collector's inventory against the
    // db.* calls in UserController.deleteUserController; if the cascade grows a
    // store, this test fails until the DSAR collector learns about it too.
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'api', 'server', 'controllers', 'UserController.js'),
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

describe('external-sink commands', () => {
  test('Langfuse commands filter by the Mongo id and page', () => {
    const sh = buildLangfuseCommands('507f1f77bcf86cd799439011');
    assert.match(sh, /traces list --user-id 507f1f77bcf86cd799439011/);
    assert.match(sh, /scores list --user-id 507f1f77bcf86cd799439011/);
    assert.match(sh, /--fields core,io,observations/);
    assert.match(sh, /--page \$p/);
  });

  test('Meilisearch queries use the only filterable attribute', () => {
    const md = buildMeilisearchQueries('abc');
    assert.match(md, /indexes\/messages\/search.*"user = abc"/);
    assert.match(md, /indexes\/convos\/search.*"user = abc"/);
  });

  test('embedded files split by vector sink the way crud.js routes them', () => {
    const v = classifyVectorStores([
      { file_id: 'a', embedded: true, context: 'agents' },
      { file_id: 'b', embedded: true, context: 'message_attachment' },
      { file_id: 'c', embedded: false, context: 'agents' },
    ]);
    assert.deepEqual(v, { azureAiSearch: ['a'], pgvector: ['b'] });
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
