#!/usr/bin/env node
// [knauf] KK20-331 — DSAR collector: everything Agentic Karl holds about one user.
//
// READ-ONLY. It uses `.find().lean()` and `countDocuments` only, never a write. It
// exists because Art. 15 is a live obligation and the self-service export endpoint
// (P2-6) does not exist yet; without a scripted collector, an access request means
// hand-querying 25 Mongo stores plus Meilisearch, Langfuse, Blob and the logs, and
// forgetting one is the failure mode.
//
// Usage:
//   node knauf/scripts/dsar-collect.js --user <mongo-id|email>            # summary: per-sink counts
//   node knauf/scripts/dsar-collect.js --user <id> --out ./dsar-KK20-xxx/  # full JSON bundle
//   options: --tenant <id>  --include-logs  --log-dir <path>
//
// Runbook: knauf/docs/privacy/runbooks/dsar-access.md
const path = require('node:path');
const fs = require('node:fs');

/* ------------------------------------------------------------------ inventory */

/**
 * Every store the account-deletion cascade (UserController.deleteUserController)
 * reaches, keyed the same way. Access mirrors erasure: if deletion has to reach it,
 * disclosure has to reach it. The spec pins this list against the cascade so a new
 * store cannot be added to one without the other.
 */
const MONGO_SINKS = [
  { model: 'Message', field: 'user', note: 'incl. content[] think parts and feedback.text' },
  { model: 'Conversation', field: 'user' },
  { model: 'MemoryEntry', field: 'userId', note: 'profiling-grade' },
  { model: 'File', field: 'user', note: 'metadata; bytes are in Blob' },
  { model: 'SharedLink', field: 'user' },
  { model: 'Transaction', field: 'user', note: 'per-user cost records' },
  { model: 'Balance', field: 'user' },
  { model: 'Preset', field: 'user' },
  { model: 'ConversationTag', field: 'user' },
  { model: 'ToolCall', field: 'user', note: 'may carry content' },
  { model: 'Assistant', field: 'user' },
  { model: 'Action', field: 'user' },
  { model: 'Agent', field: 'author' },
  { model: 'Prompt', field: 'author' },
  { model: 'PromptGroup', field: 'author' },
  { model: 'Skill', field: 'author' },
  { model: 'MCPServer', field: 'author' },
  { model: 'AgentApiKey', field: 'userId', existenceOnly: true },
  { model: 'PluginAuth', field: 'userId', existenceOnly: true },
  { model: 'Key', field: 'userId', existenceOnly: true },
  { model: 'Token', field: 'userId', existenceOnly: true },
  { model: 'Session', field: 'user', existenceOnly: true },
  { model: 'Group', field: 'memberIds', operator: 'in' },
  { model: 'AclEntry', field: 'principalId' },
];

/** Knauf scheduler collections, purged per user by api/knauf/scheduler/userLifecycle.js. */
const RAW_COLLECTIONS = [
  { collection: 'knauf_agent_schedules', field: 'user' },
  { collection: 'knauf_scheduled_agent_runs', field: 'ownerId' },
];

/** Never disclose these from the user document — security artefacts, not information
 *  about the person. */
const USER_SECRET_FIELDS = ['password', 'totpSecret', 'backupCodes', 'refreshToken', '__v'];

/** Fields kept when a store is existence-only (credentials, sessions, tokens). */
const EXISTENCE_FIELDS = [
  '_id',
  'createdAt',
  'updatedAt',
  'expiresAt',
  'name',
  'provider',
  'pluginKey',
  'type',
];

/* ------------------------------------------------------------------ pure helpers */

function redactUserDocument(user) {
  if (!user) return user;
  const out = { ...user };
  for (const k of USER_SECRET_FIELDS) delete out[k];
  return out;
}

/** Keep only existence-level fields on credential/session rows. */
function toExistenceOnly(row) {
  const out = {};
  for (const k of EXISTENCE_FIELDS) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

/**
 * Art. 15(4): a subject's right to a copy must not adversely affect others. Where the
 * subject is the TARGET of an audit entry, the ACTOR is a third party (the admin who
 * acted) — redact them. Where the subject is the ACTOR, they are disclosing their own
 * conduct; keep the row whole.
 */
function redactAuditRows(rows, subjectId) {
  const id = String(subjectId);
  return rows.map((row) => {
    const isActor = String(row.actor?.id ?? '') === id;
    if (isActor) return { ...row, _dsarRole: 'actor' };
    return {
      ...row,
      _dsarRole: 'target',
      actor: { type: row.actor?.type, name: '[redacted — third party, Art. 15(4)]' },
    };
  });
}

/** Langfuse userId IS the Mongo user id (pinned by KK20-327's identity assertion). */
function buildLangfuseCommands(subjectId) {
  const id = String(subjectId);
  return [
    '#!/usr/bin/env bash',
    '# Run where the Langfuse CLI has credentials (see package.json langfuse:* scripts).',
    '# Page until a call returns an empty data array.',
    `for p in 1 2 3 4 5 6 7 8 9 10; do npx langfuse api traces list --user-id ${id} --fields core,io,observations --limit 100 --page $p --json > langfuse-traces-p$p.json; done`,
    `for p in 1 2 3 4 5; do npx langfuse api scores list --user-id ${id} --fields score,trace --limit 100 --page $p --json > langfuse-scores-p$p.json; done`,
    '# Scores created before KK20-327 may carry free-text comments — review before release.',
  ].join('\n');
}

function buildMeilisearchQueries(subjectId) {
  const id = String(subjectId);
  return [
    '# Meilisearch — the only filterable attribute is `user`, which is exactly what a DSAR needs.',
    '# These are DERIVED copies of Mongo messages/conversations: attest counts, do not double-disclose.',
    '',
    `POST /indexes/messages/search   {"filter": "user = ${id}", "limit": 1000}`,
    `POST /indexes/convos/search     {"filter": "user = ${id}", "limit": 1000}`,
  ].join('\n');
}

/** Split embedded files by vector sink the way VectorDB/crud.js routes them. */
function classifyVectorStores(files) {
  const embedded = files.filter((f) => f.embedded === true);
  return {
    azureAiSearch: embedded.filter((f) => f.context === 'agents').map((f) => f.file_id),
    pgvector: embedded.filter((f) => f.context !== 'agents').map((f) => f.file_id),
  };
}

function parseArgs(argv) {
  const args = { includeLogs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user') args.user = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a === '--log-dir') args.logDir = argv[++i];
    else if (a === '--include-logs') args.includeLogs = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/* ------------------------------------------------------------------ collection */

async function resolveSubject(models, userRef) {
  const { User } = models;
  const byId = /^[a-f0-9]{24}$/i.test(userRef) ? await User.findById(userRef).lean() : null;
  if (byId) return byId;
  return User.findOne({
    $or: [
      { email: userRef },
      { username: userRef },
      { openidId: userRef },
      { idOnTheSource: userRef },
    ],
  }).lean();
}

async function collect({ models, mongoose, subject, out, includeLogs, logDir, log }) {
  const id = subject._id;
  const manifest = {
    generatedAt: new Date().toISOString(),
    subject: { _id: String(id), email: subject.email },
    readOnly: true,
    sinks: {},
    redactions: [
      `users: ${USER_SECRET_FIELDS.filter((f) => f !== '__v').join(', ')} stripped`,
      'auditlogs: actor redacted on rows where the subject is the target (Art. 15(4))',
      'credential/session stores: existence-level fields only',
    ],
    exclusions: [
      'Datadog: random per-session id, no user identity attached — not attributable to a subject (runbook §1.9)',
      'pgvector / Azure AI Search: no read-back endpoint — attested by file_id; content is the source file in Blob (runbook §1.3/1.4)',
    ],
  };
  const write = (name, data) => {
    if (!out) return;
    fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));
  };

  // users
  write('users.json', redactUserDocument(subject));
  manifest.sinks.users = 1;

  // the 25 stores
  let files = [];
  for (const sink of MONGO_SINKS) {
    const Model = models[sink.model];
    if (!Model) {
      manifest.sinks[sink.model] = 'model not registered';
      continue;
    }
    const filter =
      sink.operator === 'in'
        ? { [sink.field]: { $in: [id, String(id)] } }
        : { [sink.field]: { $in: [id, String(id)] } };
    const rows = await Model.find(filter).lean();
    manifest.sinks[sink.model] = rows.length;
    if (sink.model === 'File') files = rows;
    write(`${sink.model}.json`, sink.existenceOnly ? rows.map(toExistenceOnly) : rows);
  }

  // knauf scheduler collections (raw)
  const db = mongoose.connection.db;
  for (const raw of RAW_COLLECTIONS) {
    const rows = await db
      .collection(raw.collection)
      .find({ [raw.field]: { $in: [id, String(id)] } })
      .toArray();
    manifest.sinks[raw.collection] = rows.length;
    write(`${raw.collection}.json`, rows);
  }

  // audit log — read the collection: the admin API filters by name substring only
  const auditRows = await db
    .collection('auditlogs')
    .find({ $or: [{ 'actor.id': String(id) }, { 'target.id': String(id) }] })
    .sort({ seq: 1 })
    .toArray();
  const redactedAudit = redactAuditRows(auditRows, id);
  manifest.sinks.auditlogs = {
    total: auditRows.length,
    asActor: redactedAudit.filter((r) => r._dsarRole === 'actor').length,
    asTarget: redactedAudit.filter((r) => r._dsarRole === 'target').length,
  };
  write('auditlogs.json', redactedAudit);

  // derived / external sinks — commands + attestations
  const vectors = classifyVectorStores(files);
  manifest.sinks.vectorStores = {
    pgvectorFileIds: vectors.pgvector.length,
    azureAiSearchFileIds: vectors.azureAiSearch.length,
  };
  write('vector-stores.json', vectors);
  manifest.sinks.blob = {
    container: process.env.AZURE_CONTAINER_NAME || 'files',
    objects: files.map((f) => f.filepath || f.storageKey).filter(Boolean).length,
  };
  write(
    'blob-objects.json',
    files.map((f) => ({
      file_id: f.file_id,
      filename: f.filename,
      key: f.filepath || f.storageKey,
    })),
  );
  if (out) {
    fs.writeFileSync(path.join(out, 'langfuse.sh'), buildLangfuseCommands(id));
    fs.writeFileSync(path.join(out, 'meilisearch.md'), buildMeilisearchQueries(id));
  }
  manifest.sinks.langfuse = 'see langfuse.sh (userId = Mongo id)';
  manifest.sinks.meilisearch = 'see meilisearch.md (filter user = id)';

  // logs — 14-day window, error-*.log carry userId via requestContextFormat
  if (includeLogs) {
    const dir =
      logDir || process.env.LIBRECHAT_LOG_DIR || path.resolve(__dirname, '..', '..', 'api', 'logs');
    const hits = [];
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.log'))) {
        const lines = fs
          .readFileSync(path.join(dir, f), 'utf8')
          .split('\n')
          .filter((l) => l.includes(String(id)));
        hits.push(...lines.map((l) => ({ file: f, line: l })));
      }
    }
    manifest.sinks.winstonLogs = { dir, matchingLines: hits.length, window: '14-day rotation' };
    write('logs.json', hits);
  } else {
    manifest.sinks.winstonLogs = 'skipped — pass --include-logs (platform team on prod)';
  }

  write('manifest.json', manifest);
  log(JSON.stringify(manifest, null, 2));
  return manifest;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.user) {
    console.log(
      'usage: node knauf/scripts/dsar-collect.js --user <mongo-id|email> [--out DIR] [--tenant ID] [--include-logs] [--log-dir DIR]',
    );
    process.exit(args.help ? 0 : 1);
  }
  // Same bootstrap as config/migrate-orphaned-agent-files.js.
  require('module-alias')({ base: path.resolve(__dirname, '..', '..', 'api') });
  const connect = require('../../config/connect');
  const { runAsSystem, tenantStorage } = require('@librechat/data-schemas');
  const mongoose = require('mongoose');
  await connect();
  const models = require('~/db/models');

  if (args.out) fs.mkdirSync(args.out, { recursive: true });

  const run = async () => {
    const subject = await resolveSubject(models, args.user);
    if (!subject) {
      console.error(
        `No user matches "${args.user}" (tried _id, email, username, openidId, idOnTheSource).`,
      );
      process.exit(2);
    }
    await collect({
      models,
      mongoose,
      subject,
      out: args.out,
      includeLogs: args.includeLogs,
      logDir: args.logDir,
      log: console.log,
    });
  };

  if (args.tenant && tenantStorage?.run) {
    await tenantStorage.run({ tenantId: args.tenant }, run);
  } else {
    await runAsSystem(run);
  }
  await mongoose.disconnect();
}

module.exports = {
  MONGO_SINKS,
  RAW_COLLECTIONS,
  USER_SECRET_FIELDS,
  redactUserDocument,
  toExistenceOnly,
  redactAuditRows,
  buildLangfuseCommands,
  buildMeilisearchQueries,
  classifyVectorStores,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
// End [knauf]
