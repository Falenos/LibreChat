#!/usr/bin/env node
// [knauf] KK20-TBD — erasure verification: prove an Art. 17 deletion reached every sink.
//
// This script NEVER deletes application data. Deletion runs through the real product
// paths — `DELETE /api/user/delete` (account) and `DELETE /api/convos` (one chat) — so
// the evidence describes what a user actually gets, not what an ops script does.
// `config/delete-user.js` is deliberately NOT the path under test: it raw-`deleteMany`s
// the collections and never calls `processDeleteRequest`, so Blob bytes and vector
// embeddings survive it (see runbook §4).
//
// The one exception is Langfuse. No application path deletes traces, so
// `--phase langfuse-delete` issues the public-API batch delete against the trace ids
// captured by `--phase before`. Deletion there is asynchronous (≤ ~15 min) — re-run
// `--phase after` once it has settled.
//
// Usage:
//   node knauf/scripts/erasure-verify.js --phase before --user <id|email> --out ./erasure-KK20-xxx/
//   ...operator deletes through the product (runbook §2)...
//   node knauf/scripts/erasure-verify.js --phase langfuse-delete --out ./erasure-KK20-xxx/ --confirm
//   node knauf/scripts/erasure-verify.js --phase after  --out ./erasure-KK20-xxx/
//   options: --tenant <id>   --rag-query "<text>"   --skip meili,rag,blob,langfuse
//
// Runbook: knauf/docs/privacy/runbooks/erasure-verify.md
const path = require('node:path');
const fs = require('node:fs');
const { MONGO_SINKS, RAW_COLLECTIONS } = require('./dsar-collect');

/* ------------------------------------------------------------------ constants */

const PHASES = ['before', 'langfuse-delete', 'after'];
const PROBES = ['meili', 'rag', 'blob', 'langfuse'];

/**
 * Sinks that legitimately still hold something after a complete erasure. Every other
 * residual fails the run. Each entry carries the legal/engineering basis so the
 * report can say WHY it is allowed rather than silently ignoring it.
 */
const RETAINED_BY_DESIGN = {
  auditlogs:
    'Art. 17(3)(b)/(e) — tamper-evident admin audit trail retained under the P2-7 position; ' +
    'purged by the KK20-328 sweep at the configured retention (12 months)',
  winstonLogs:
    '14-day rotation; deleteUserController logs "User deleted account. Email: …" at info — ' +
    'suppressed in prod by the warn root level, present in dev/stage (runbook §4)',
};

const LANGFUSE_DELETE_BATCH = 100;

/* ------------------------------------------------------------------ pure helpers */

function parseArgs(argv) {
  const args = { confirm: false, skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--phase') args.phase = argv[++i];
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--tenant') args.tenant = argv[++i];
    else if (a === '--rag-query') args.ragQuery = argv[++i];
    else if (a === '--skip')
      args.skip = String(argv[++i] || '')
        .split(',')
        .filter(Boolean);
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/**
 * Pure mirror of `extractBlobPathFromAzureUrl` (api/server/services/Files/Azure/crud.js):
 * `new URL()` drops any SAS query string; the container is located as a path segment so
 * path-style (Azurite) URLs resolve too. Mismatch falls back to the legacy strip-first-
 * segment behaviour, exactly like the delete path does — the probe must look where the
 * delete looked.
 */
function extractBlobPath(fileUrl, containerName = 'files') {
  try {
    const parts = new URL(fileUrl).pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const idx = parts.indexOf(containerName);
    if (idx === -1 || idx === parts.length - 1) return parts.slice(1).join('/') || null;
    return parts.slice(idx + 1).join('/');
  } catch {
    return null;
  }
}

/** Langfuse `DELETE /api/public/traces` takes `{ traceIds: string[] }`; batch to stay small. */
function buildLangfuseDeleteBatches(traceIds, size = LANGFUSE_DELETE_BATCH) {
  const ids = [...new Set((traceIds || []).filter(Boolean))];
  const batches = [];
  for (let i = 0; i < ids.length; i += size) batches.push({ traceIds: ids.slice(i, i + size) });
  return batches;
}

/** Mirror of feedback.ts's base-URL resolution so the probe hits the same instance. */
function resolveLangfuseBaseUrl(env = process.env) {
  const raw = env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || env.LANGFUSE_BASEURL || '';
  return raw.replace(/\/+$/, '');
}

/**
 * Turn an `after` snapshot into a verdict. A residual is any sink with a non-zero
 * count, an existing subject document, an existing blob, a vector hit or a remaining
 * trace. Residuals in RETAINED_BY_DESIGN are reported but do not fail the run;
 * anything else does. Sinks that could not be probed are reported separately —
 * "not probed" is never counted as clean.
 */
function evaluate(after) {
  const residuals = [];
  const unprobed = [];
  const push = (sink, count, detail) => {
    if (typeof count !== 'number') {
      unprobed.push({ sink, detail: count });
      return;
    }
    if (count > 0) {
      const reason = RETAINED_BY_DESIGN[sink];
      residuals.push({ sink, count, allowed: Boolean(reason), reason, detail });
    }
  };

  push('users', after.users);
  for (const [model, count] of Object.entries(after.mongo || {})) push(model, count);
  for (const [coll, count] of Object.entries(after.raw || {})) push(coll, count);
  push('auditlogs', after.auditlogs);
  if (after.meili)
    for (const [index, count] of Object.entries(after.meili)) push(`meili:${index}`, count);
  if (after.blob) push('blob', after.blob.existing, after.blob.paths);
  if (after.rag) {
    push('pgvector', after.rag.pgvector);
    push('azureAiSearch', after.rag.azureAiSearch);
  }
  if (after.langfuse) {
    push('langfuse:traces', after.langfuse.traces);
    push('langfuse:scores', after.langfuse.scores);
  }

  const failing = residuals.filter((r) => !r.allowed);
  return { ok: failing.length === 0 && unprobed.length === 0, residuals, failing, unprobed };
}

function renderReport({ before, after, evaluation }) {
  const lines = [
    '# Erasure verification report',
    '',
    `- Subject: \`${before.subject._id}\` (${before.subject.email || 'no email captured'})`,
    `- Before snapshot: ${before.generatedAt}`,
    `- After snapshot: ${after.generatedAt}`,
    `- Verdict: **${evaluation.ok ? 'CLEAN' : 'RESIDUALS FOUND'}**`,
    '',
    '| Sink | Before | After | Status |',
    '|---|---|---|---|',
  ];
  const row = (sink, b, a) => {
    const res = evaluation.residuals.find((r) => r.sink === sink);
    const un = evaluation.unprobed.find((u) => u.sink === sink);
    let status = 'clean';
    if (un) status = `NOT PROBED — ${un.detail}`;
    else if (res && res.allowed) status = `retained by design — ${res.reason}`;
    else if (res) status = 'RESIDUAL';
    lines.push(`| ${sink} | ${fmt(b)} | ${fmt(a)} | ${status} |`);
  };
  row('users', before.users, after.users);
  for (const model of Object.keys(before.mongo || {}))
    row(model, before.mongo[model], after.mongo?.[model]);
  for (const coll of Object.keys(before.raw || {})) row(coll, before.raw[coll], after.raw?.[coll]);
  row('auditlogs', before.auditlogs, after.auditlogs);
  for (const index of Object.keys(before.meili || {}))
    row(`meili:${index}`, before.meili[index], after.meili?.[index]);
  row('blob', before.blob?.existing, after.blob?.existing);
  row('pgvector', before.rag?.pgvector, after.rag?.pgvector);
  row('azureAiSearch', before.rag?.azureAiSearch, after.rag?.azureAiSearch);
  row('langfuse:traces', before.langfuse?.traces, after.langfuse?.traces);
  row('langfuse:scores', before.langfuse?.scores, after.langfuse?.scores);
  lines.push('', '`winstonLogs` is not probed by this script — see runbook §4 for the grep.');
  return lines.join('\n') + '\n';
}

function fmt(v) {
  if (v === undefined || v === null) return '—';
  return typeof v === 'number' ? String(v) : `n/a (${v})`;
}

/* ------------------------------------------------------------------ probes */

async function probeMongo({ models, mongoose, id }) {
  const key = { $in: [id, String(id)] };
  const mongo = {};
  for (const sink of MONGO_SINKS) {
    const Model = models[sink.model];
    mongo[sink.model] = Model
      ? await Model.countDocuments({ [sink.field]: key })
      : 'model not registered';
  }
  const raw = {};
  const db = mongoose.connection.db;
  for (const r of RAW_COLLECTIONS) {
    raw[r.collection] = await db.collection(r.collection).countDocuments({ [r.field]: key });
  }
  const users = await models.User.countDocuments({ _id: id });
  const auditlogs = await db
    .collection('auditlogs')
    .countDocuments({ $or: [{ 'actor.id': String(id) }, { 'target.id': String(id) }] });
  return { mongo, raw, users, auditlogs };
}

async function inventoryFiles({ models, id }) {
  const files = await models.File.find({ user: { $in: [id, String(id)] } })
    .select('file_id filepath context embedded source')
    .lean();
  const agents = await models.Agent.find({ author: { $in: [id, String(id)] } })
    .select('id')
    .lean();
  return {
    files: files.map((f) => ({
      file_id: f.file_id,
      filepath: f.filepath,
      context: f.context,
      embedded: f.embedded === true,
      source: f.source,
    })),
    agentIds: agents.map((a) => a.id).filter(Boolean),
  };
}

async function probeMeili({ id, env = process.env }) {
  if (!env.MEILI_HOST || !env.MEILI_MASTER_KEY)
    return {
      messages: 'MEILI_HOST/MEILI_MASTER_KEY unset',
      convos: 'MEILI_HOST/MEILI_MASTER_KEY unset',
    };
  const out = {};
  for (const index of ['messages', 'convos']) {
    try {
      const res = await fetch(`${env.MEILI_HOST.replace(/\/+$/, '')}/indexes/${index}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.MEILI_MASTER_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: '', filter: `user = ${String(id)}`, limit: 1 }),
      });
      if (!res.ok) {
        out[index] = `HTTP ${res.status}`;
        continue;
      }
      const body = await res.json();
      out[index] = Number(body.estimatedTotalHits ?? body.totalHits ?? (body.hits || []).length);
    } catch (err) {
      out[index] = err.message;
    }
  }
  return out;
}

/**
 * Both vector sinks are behind rag_api and neither has a read-back-by-user endpoint. We
 * ask the same two routes `fileSearchRetrieval.js` uses, scoped to the file ids captured
 * BEFORE deletion, with the same short-lived JWT the app mints. A hit after deletion means
 * an embedding survived.
 */
async function probeRag({ id, inventory, ragQuery, env = process.env, generateShortLivedToken }) {
  if (!env.RAG_API_URL)
    return { pgvector: 'RAG_API_URL unset', azureAiSearch: 'RAG_API_URL unset' };
  const base = env.RAG_API_URL.replace(/\/+$/, '');
  const embedded = inventory.files.filter((f) => f.embedded);
  const pg = embedded.filter((f) => f.context !== 'agents').map((f) => f.file_id);
  const az = embedded.filter((f) => f.context === 'agents').map((f) => f.file_id);
  const headers = {
    Authorization: `Bearer ${generateShortLivedToken(String(id))}`,
    'Content-Type': 'application/json',
  };
  const query = ragQuery || 'the';
  const hits = async (url, body) => {
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (res.status === 404) return 0;
      if (!res.ok) return `HTTP ${res.status}`;
      const data = await res.json();
      return Array.isArray(data) ? data.length : Number(data?.length ?? 0);
    } catch (err) {
      return err.message;
    }
  };
  const out = {};
  out.pgvector = pg.length
    ? await hits(`${base}/query_multiple`, { query, file_ids: pg, k: 5 })
    : 0;
  if (!az.length) out.azureAiSearch = 0;
  else if (!inventory.agentIds.length)
    out.azureAiSearch = 'agent files present but no agent id captured for entity_id';
  else {
    let total = 0;
    for (const entity_id of inventory.agentIds) {
      const n = await hits(`${base}/agent/query-multiple`, {
        query,
        file_ids: az,
        k: 5,
        entity_id,
      });
      if (typeof n !== 'number') {
        total = n;
        break;
      }
      total += n;
    }
    out.azureAiSearch = total;
  }
  return out;
}

async function probeBlob({ inventory, env = process.env, getAzureContainerClient }) {
  const container = env.AZURE_CONTAINER_NAME || 'files';
  const paths = inventory.files
    .filter(
      (f) =>
        f.source === 'azure_blob' || /blob\.core\.windows\.net|:10000\//.test(f.filepath || ''),
    )
    .map((f) => extractBlobPath(f.filepath, container))
    .filter(Boolean);
  if (!paths.length) return { existing: 0, paths: [] };
  const client = await getAzureContainerClient(container);
  if (!client) return { existing: 'Azure Blob client not configured', paths };
  const existing = [];
  for (const p of paths) {
    if (await client.getBlockBlobClient(p).exists()) existing.push(p);
  }
  return { existing: existing.length, paths: existing };
}

function langfuseAuth(env = process.env) {
  const base = resolveLangfuseBaseUrl(env);
  if (!base || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  const token = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString(
    'base64',
  );
  return { base, headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' } };
}

/** Langfuse `userId` IS the Mongo id (pinned by KK20-327). Page until empty. */
async function probeLangfuse({ id, env = process.env }) {
  const auth = langfuseAuth(env);
  if (!auth) return { traces: 'LANGFUSE_* unset', scores: 'LANGFUSE_* unset', traceIds: [] };
  const list = async (route) => {
    const ids = [];
    for (let page = 1; page <= 50; page++) {
      const res = await fetch(
        `${auth.base}/api/public/${route}?userId=${encodeURIComponent(String(id))}&limit=100&page=${page}`,
        {
          headers: auth.headers,
        },
      );
      if (!res.ok) return `HTTP ${res.status}`;
      const body = await res.json();
      const data = body.data || [];
      ids.push(...data.map((d) => d.id));
      if (data.length < 100) break;
    }
    return ids;
  };
  const traceIds = await list('traces');
  const scoreIds = await list('scores');
  return {
    traces: Array.isArray(traceIds) ? traceIds.length : traceIds,
    scores: Array.isArray(scoreIds) ? scoreIds.length : scoreIds,
    traceIds: Array.isArray(traceIds) ? traceIds : [],
  };
}

async function deleteLangfuseTraces({ traceIds, env = process.env, log }) {
  const auth = langfuseAuth(env);
  if (!auth)
    throw new Error('LANGFUSE_BASE_URL/LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY are required');
  const batches = buildLangfuseDeleteBatches(traceIds);
  for (const [i, body] of batches.entries()) {
    const res = await fetch(`${auth.base}/api/public/traces`, {
      method: 'DELETE',
      headers: auth.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`Langfuse batch ${i + 1}/${batches.length} failed: HTTP ${res.status}`);
    log(
      `[langfuse] batch ${i + 1}/${batches.length}: ${body.traceIds.length} traces accepted (async, ≤ ~15 min)`,
    );
  }
  return batches.length;
}

/* ------------------------------------------------------------------ phases */

async function snapshot({ models, mongoose, id, email, inventory, skip, ragQuery, deps, log }) {
  const snap = { generatedAt: new Date().toISOString(), subject: { _id: String(id), email } };
  Object.assign(snap, await probeMongo({ models, mongoose, id }));
  snap.inventory = inventory;
  if (!skip.includes('meili')) snap.meili = await probeMeili({ id });
  if (!skip.includes('rag'))
    snap.rag = await probeRag({
      id,
      inventory,
      ragQuery,
      generateShortLivedToken: deps.generateShortLivedToken,
    });
  if (!skip.includes('blob'))
    snap.blob = await probeBlob({
      inventory,
      getAzureContainerClient: deps.getAzureContainerClient,
    });
  if (!skip.includes('langfuse')) snap.langfuse = await probeLangfuse({ id });
  log(
    JSON.stringify(
      {
        ...snap,
        inventory: `${inventory.files.length} files, ${inventory.agentIds.length} agents`,
      },
      null,
      2,
    ),
  );
  return snap;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (
    args.help ||
    !PHASES.includes(args.phase) ||
    !args.out ||
    (args.phase === 'before' && !args.user)
  ) {
    console.log(
      'usage: node knauf/scripts/erasure-verify.js --phase before --user <id|email> --out DIR\n' +
        '       node knauf/scripts/erasure-verify.js --phase langfuse-delete --out DIR --confirm\n' +
        '       node knauf/scripts/erasure-verify.js --phase after --out DIR\n' +
        '       [--tenant ID] [--rag-query TEXT] [--skip meili,rag,blob,langfuse]',
    );
    process.exit(args.help ? 0 : 1);
  }
  for (const s of args.skip) {
    if (!PROBES.includes(s)) {
      console.error(`unknown --skip value "${s}" (allowed: ${PROBES.join(',')})`);
      process.exit(1);
    }
  }
  fs.mkdirSync(args.out, { recursive: true });
  const beforePath = path.join(args.out, 'before.json');

  if (args.phase === 'langfuse-delete') {
    if (!args.confirm) {
      console.error('Refusing to delete Langfuse traces without --confirm.');
      process.exit(1);
    }
    const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
    const ids = before.langfuse?.traceIds || [];
    if (!ids.length) {
      console.log('[langfuse] no trace ids captured in before.json — nothing to delete');
      return;
    }
    const n = await deleteLangfuseTraces({ traceIds: ids, log: console.log });
    fs.writeFileSync(
      path.join(args.out, 'langfuse-delete.json'),
      JSON.stringify(
        { requestedAt: new Date().toISOString(), traces: ids.length, batches: n },
        null,
        2,
      ),
    );
    return;
  }

  // Same bootstrap as dsar-collect.js / config/migrate-orphaned-agent-files.js.
  require('module-alias')({ base: path.resolve(__dirname, '..', '..', 'api') });
  const connect = require('../../config/connect');
  const { runAsSystem, tenantStorage } = require('@librechat/data-schemas');
  const { generateShortLivedToken, getAzureContainerClient } = require('@librechat/api');
  const mongoose = require('mongoose');
  await connect();
  const models = require('~/db/models');
  const deps = { generateShortLivedToken, getAzureContainerClient };

  const run = async () => {
    if (args.phase === 'before') {
      const { User } = models;
      const subject = /^[a-f0-9]{24}$/i.test(args.user)
        ? await User.findById(args.user).lean()
        : await User.findOne({
            $or: [{ email: args.user }, { username: args.user }, { openidId: args.user }],
          }).lean();
      if (!subject) {
        console.error(`No user matches "${args.user}".`);
        process.exit(2);
      }
      const inventory = await inventoryFiles({ models, id: subject._id });
      const snap = await snapshot({
        models,
        mongoose,
        id: subject._id,
        email: subject.email,
        inventory,
        skip: args.skip,
        ragQuery: args.ragQuery,
        deps,
        log: console.log,
      });
      fs.writeFileSync(beforePath, JSON.stringify(snap, null, 2));
      console.log(
        `\nbefore.json written. Now delete through the product (runbook §2), then run --phase after.`,
      );
      return;
    }

    // after: re-probe with the ids captured before deletion — the user document is gone.
    const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
    const id = new mongoose.Types.ObjectId(before.subject._id);
    const after = await snapshot({
      models,
      mongoose,
      id,
      email: before.subject.email,
      inventory: before.inventory,
      skip: args.skip,
      ragQuery: args.ragQuery,
      deps,
      log: console.log,
    });
    const evaluation = evaluate(after);
    fs.writeFileSync(
      path.join(args.out, 'after.json'),
      JSON.stringify({ ...after, evaluation }, null, 2),
    );
    const report = renderReport({ before, after, evaluation });
    fs.writeFileSync(path.join(args.out, 'report.md'), report);
    console.log('\n' + report);
    if (!evaluation.ok) process.exitCode = 3;
  };

  if (args.tenant && tenantStorage?.run) {
    await tenantStorage.run({ tenantId: args.tenant }, run);
  } else {
    await runAsSystem(run);
  }
  await mongoose.disconnect();
}

module.exports = {
  PHASES,
  PROBES,
  RETAINED_BY_DESIGN,
  LANGFUSE_DELETE_BATCH,
  parseArgs,
  extractBlobPath,
  buildLangfuseDeleteBatches,
  resolveLangfuseBaseUrl,
  evaluate,
  renderReport,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
// End [knauf]
