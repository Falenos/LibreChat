#!/usr/bin/env node
// [knauf] KK20-350 — erasure verification: prove an Art. 17 deletion reached every
// store the environment's sink manifest declares, or say exactly why it cannot.
//
// This script NEVER deletes application data. Deletion runs through the real product
// paths — `DELETE /api/user/delete` (account) and `DELETE /api/convos` (one chat) — so
// the evidence describes what a user actually gets. `config/delete-user.js` is NOT the
// path under test: it raw-`deleteMany`s and never calls `processDeleteRequest`, so
// Blob bytes and vectors survive it (runbook §1). The one write is
// `--phase langfuse-delete`, because no product path deletes traces.
//
// PR #350 review (Falenos, 2026-09-04): the first version could print CLEAN on normal
// runs. Each fix below is fail-closed — the failure mode it removes can no longer
// reach exit 0:
//   1. Vectors are counted by the RAG service's exact, read-only
//      `POST /verification/vectors` (agentic-karl-rag-api), keyed by physical asset id,
//      the subject's user id and their authored agent (entity) ids. The old probe asked
//      the SEMANTIC search routes, where a chunk outside top-k read as zero. Adapter
//      missing, backend unavailable or an inexact answer ⇒ NOT PROBED, never zero.
//   2. Every sink is materialised as `{ status, count, exact, method, reason }`, and the
//      verdict iterates the environment MANIFEST, not the snapshot: a sink that was
//      skipped or never produced a result cannot drop out of evaluation. `--skip`
//      exists only in `--mode rehearsal`, which can never print CLEAN.
//   3. The verdict evaluates the before → after transition. A mandatory sink needs a
//      positive baseline — proof that the probe's identifiers hit real data — or an
//      APPROVED, reason-coded exemption in the manifest.
//   4. Evidence runs require the canonical Mongo `_id` plus `--tenant <id|none>`, verify
//      the pair, and persist the identity tuple in before.json before anything else.
//      The Langfuse deletion re-confirms that tuple and refuses anything weaker.
//   5. Blob is enumerated from STORAGE — every canonical `{base}/{userId}/` prefix,
//      paged, including versions, snapshots and soft-deleted objects — and reconciled
//      against the Mongo pointers, so an object no row points at is still found. A
//      pointer outside the known layout makes the sink NOT PROBED.
//   6. "Every copy" is no longer prose: `knauf/docs/privacy/erasure-sinks/<env>.json` is
//      a versioned, reviewed manifest in which every store resolves to deleted /
//      eventually-deleted (deadline) / retained (basis + expiry) / externally-controlled
//      (controller + notification duty) / not-probed. Anything unknown, unapproved or
//      contradicted by the environment blocks CLEAN.
//
// PR #350 second round (AlexZahar, 2026-09-25), same rule — each finding is fail-closed:
//   7. The Langfuse leg is bound to the PROJECT the credentials resolve to
//      (`GET /api/public/projects`), not only to the host. Baseline, deletion and after
//      must all resolve to the same project id; rotating keys inside a project is fine.
//   8. Every store's physical identity (host/database/index/container/project, never a
//      secret) is recorded at baseline and compared at `after`; a different backend is
//      refused before anything is probed. `envSignals` alone could not see an endpoint
//      swapped for an empty one.
//   9. Translation (`KNAUF_FILE_TRANSLATION_ENABLED`) and code execution
//      (`KNAUF_CODE_EXECUTION_ENABLED`) are detected from the environment and have their
//      own stores: the code-adapter staging container is probed by the sessions the
//      subject's File rows reference (`metadata.codeEnvRef`), and the translation scratch
//      containers, which carry no subject key, are probed for objects that outlived the
//      lifecycle rule the manifest declares.
//  10. Baseline trace AND score ids are verified by direct lookup at `after`. The score
//      list filters by userId through a join to the parent trace, so once the trace is
//      gone a surviving score vanishes from the list; a direct `GET /scores/{id}` does
//      not need the parent.
//
// Usage:
//   node knauf/scripts/erasure-verify.js --phase before --env stage \
//        --user <mongo _id> --tenant <tenantId|none> --out ./erasure-<date>/
//   ...operator deletes through the product (runbook §2)...
//   node knauf/scripts/erasure-verify.js --phase langfuse-delete --env stage \
//        --user <mongo _id> --tenant <tenantId|none> --out ./erasure-<date>/ --confirm
//   node knauf/scripts/erasure-verify.js --phase after --env stage --out ./erasure-<date>/
//   rehearsal (never evidence): --mode rehearsal [--user <email>] [--skip redis,blob,...]
//
// Exit codes: 0 CLEAN (evidence mode only) · 1 usage · 2 subject not found ·
//             3 RESIDUALS FOUND · 4 INCOMPLETE · 5 NOT EVIDENCE (rehearsal) · 6 refused
//
// Runbook: knauf/docs/privacy/runbooks/erasure-verify.md
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  MONGO_SINKS,
  RAW_COLLECTIONS,
  sinkFilter,
  resolveSubject,
  AmbiguousSubjectError,
  classifyVectorStores,
  prepareOutputDir,
  writeBundleFile,
  assertNoSymlinkInPath,
  readSecureJson,
} = require('./dsar-collect');

/* ------------------------------------------------------------------ constants */

const EVIDENCE_KIND = 'knauf-erasure-evidence';
const SCHEMA_VERSION = 2;
const PHASES = ['before', 'langfuse-delete', 'after'];
const MODES = ['evidence', 'rehearsal'];
/** Probe groups `--skip` accepts — rehearsal mode only. */
const PROBE_GROUPS = [
  'mongo',
  'meili',
  'vectors',
  'blob',
  'langfuse',
  'redis',
  'logs',
  'translation',
  'code',
];
const DISPOSITIONS = [
  'deleted',
  'eventually-deleted',
  'retained',
  'externally-controlled',
  'not-probed',
];
/**
 * Reason codes under which a mandatory store may lack a positive baseline:
 * the feature is off here; the subject cannot create the data (admin-only surfaces); or
 * the store carries no subject key at all, so the probe measures the store's own
 * guarantee instead (translation scratch: objects that outlived the lifecycle rule).
 */
const BASELINE_EXEMPTIONS = [
  'FEATURE_DISABLED_IN_ENVIRONMENT',
  'NOT_CREATABLE_BY_SUBJECT',
  'NOT_SUBJECT_ADDRESSABLE',
];
const EXIT = {
  CLEAN: 0,
  USAGE: 1,
  NOT_FOUND: 2,
  RESIDUALS: 3,
  INCOMPLETE: 4,
  NOT_EVIDENCE: 5,
  REFUSED: 6,
};

/** A baseline older than this at `after` time is stale: re-run the recipe. */
const MAX_BASELINE_AGE_MS = 24 * 60 * 60 * 1000;
/** Langfuse deletes asynchronously ("within 15 minutes"). */
const LANGFUSE_SETTLE_MS = 15 * 60 * 1000;
const LANGFUSE_DELETE_BATCH = 100;
const LANGFUSE_PAGE_SIZE = 100;
const LANGFUSE_MAX_PAGES = 1000;
/** Direct `GET /{traces,scores}/{id}` lookups per phase before the answer is inexact. */
const LANGFUSE_MAX_LOOKUPS = 5000;

const RAG_ADAPTER = 'knauf-vector-verification';
/** Version 2 reports the storage identity behind each backend (review round 2, item 8). */
const RAG_ADAPTER_MIN_VERSION = 2;
const RAG_MAX_VALUES = 500;
const RAG_PAGE_SIZE = 1000;
const RAG_MAX_PAGES = 1000;
/** JWT principal for adapter calls, so RAG logs never attribute them to the subject. */
const RAG_PRINCIPAL = 'knauf-erasure-verifier';

const REDIS_MAX_SCAN_ROUNDS = 100000;

/**
 * Every `{basePath}/{userId}/{fileName}` layout `Azure/crud.js` writes. Objects under
 * these prefixes are the subject's by construction, so they are enumerated from storage
 * rather than looked up through Mongo pointers.
 */
const BLOB_BASE_PATHS = ['images', 'uploads', 'avatars', 'documents', 'files'];
const BLOB_CLASSES = ['current', 'versions', 'snapshots', 'softDeleted'];

/**
 * The code adapter stages every input and output as `<container>/<sessionId>/<fileId>`
 * (knauf/code-adapter, store/filesRepo.ts). The container name is a deployment fact and
 * is read from the manifest entry (`files:execute_code`.container); this is the
 * adapter's default.
 */
const CODE_STAGING_CONTAINER_DEFAULT = 'code-adapter-staging';
/**
 * Azure batch translation stages `<uuid>/<name>` in these containers
 * (translation/providers/azure.js). The uuid is never persisted, so scratch cannot be
 * found per subject; the probe measures what outlived the lifecycle rule instead.
 */
const TRANSLATION_SCRATCH_CONTAINERS = (env = process.env) => [
  env.AZURE_TRANSLATION_SOURCE_CONTAINER || 'translation-source',
  env.AZURE_TRANSLATION_TARGET_CONTAINER || 'translation-target',
];
const TRANSLATION_LIFECYCLE_DEFAULT = 'P1D';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_DIR = path.join(REPO_ROOT, 'knauf', 'docs', 'privacy', 'erasure-sinks');
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const ENV_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/* ------------------------------------------------------------------ inventory */

/** Every sink this script can measure. The manifest must place each one. */
function probedSinkKeys() {
  return [
    'mongo:users',
    ...MONGO_SINKS.map((s) => `mongo:${s.model}`),
    ...RAW_COLLECTIONS.map((r) => `raw:${r.collection}`),
    'mongo:auditlogs',
    'meili:messages',
    'meili:convos',
    'vectors:pgvector',
    'vectors:azureAiSearch',
    'blob:primary',
    'langfuse:traces',
    'langfuse:scores',
    'redis:keys',
    'logs:files',
    'translation:scratch',
    'files:execute_code',
  ];
}

function probeGroupOf(key) {
  const prefix = key.split(':')[0];
  if (prefix === 'raw') return 'mongo';
  if (prefix === 'files') return 'code';
  return prefix;
}

/**
 * Environment facts the manifest can be checked against. A store the environment
 * shows as configured must never be declared `configured: false` (that would turn a
 * live copy into a silent not-applicable).
 */
function environmentSignals(env = process.env) {
  const on = (v) => String(v ?? '').toLowerCase() === 'true';
  return {
    meili: Boolean(env.MEILI_HOST) && String(env.SEARCH ?? 'true').toLowerCase() !== 'false',
    'vectors:pgvector': Boolean(env.RAG_API_URL),
    'vectors:azureAiSearch': on(env.AZURE_SEARCH_ENABLED),
    langfuse: Boolean(
      env.LANGFUSE_PUBLIC_KEY || env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || env.LANGFUSE_BASEURL,
    ),
    'redis:keys': on(env.USE_REDIS),
    'logs:files': String(env.LOG_TO_FILE ?? '').toLowerCase() !== 'false',
    'blob:primary': Boolean(env.AZURE_STORAGE_CONNECTION_STRING || env.AZURE_STORAGE_ACCOUNT_NAME),
    // Review round 2: both features are live in dev, stage and prod (agk-deployment-configs)
    // and hold copies the manifest used to declare absent.
    'translation:scratch': on(env.KNAUF_FILE_TRANSLATION_ENABLED),
    'files:execute_code': on(env.KNAUF_CODE_EXECUTION_ENABLED),
    'code:table': on(env.KNAUF_CODE_EXECUTION_ENABLED),
  };
}

function signalFor(key, signals = {}) {
  if (key.startsWith('meili:')) return signals.meili ?? null;
  if (key.startsWith('langfuse:')) return signals.langfuse ?? null;
  return signals[key] ?? null;
}

/* ------------------------------------------------------------------ pure helpers */

const FLAGS_WITH_VALUE = {
  '--phase': 'phase',
  '--env': 'env',
  '--mode': 'mode',
  '--user': 'user',
  '--tenant': 'tenant',
  '--out': 'out',
  '--skip': 'skip',
  '--log-dir': 'logDir',
};

function parseArgs(argv) {
  const args = { mode: 'evidence', confirm: false, skip: [], unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE[a]) {
      const value = argv[++i];
      if (a === '--skip') {
        args.skip = String(value || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        args[FLAGS_WITH_VALUE[a]] = value;
      }
    } else if (a === '--confirm') args.confirm = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args.unknown.push(a);
  }
  return args;
}

/** Returns a usage error, or null. Evidence-mode rules are enforced here, up front. */
function validateArgs(args) {
  if (args.unknown.length) return `unknown argument(s): ${args.unknown.join(' ')}`;
  if (!PHASES.includes(args.phase)) return `--phase must be one of ${PHASES.join(', ')}`;
  if (!MODES.includes(args.mode)) return `--mode must be one of ${MODES.join(', ')}`;
  if (!args.env || !ENV_NAME_RE.test(args.env)) return '--env <name> is required (e.g. stage)';
  if (!args.out) return '--out <dir> is required';
  for (const s of args.skip) {
    if (!PROBE_GROUPS.includes(s)) return `unknown --skip value "${s}" (${PROBE_GROUPS.join(',')})`;
  }
  if (args.skip.length && args.mode !== 'rehearsal') {
    return '--skip is only accepted with --mode rehearsal: a skipped sink is not evidence';
  }
  const needsIdentity =
    args.phase === 'langfuse-delete' || (args.phase === 'before' && args.mode === 'evidence');
  if (args.phase === 'before' && !args.user) return '--user is required for --phase before';
  if (needsIdentity) {
    if (!OBJECT_ID_RE.test(String(args.user || ''))) {
      return `--phase ${args.phase}${args.phase === 'before' ? ' (evidence)' : ''} needs the canonical Mongo _id in --user — email/OIDC lookups are rehearsal-only`;
    }
    if (!args.tenant) {
      return `--phase ${args.phase}${args.phase === 'before' ? ' (evidence)' : ''} needs --tenant <tenantId|none>`;
    }
  }
  if (args.phase === 'langfuse-delete' && !args.confirm) {
    return 'Refusing to delete Langfuse traces without --confirm';
  }
  return null;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function unique(values) {
  return [...new Set(values.filter((v) => v !== undefined && v !== null && v !== '').map(String))];
}

function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** ISO 8601 durations in weeks/days/hours/minutes → ms. Months/years are ambiguous: refused. */
function parseDuration(iso) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(String(iso ?? ''));
  if (!m || !m.slice(1).some((x) => x !== undefined)) return null;
  const [w, d, h, min] = m.slice(1).map((x) => Number(x || 0));
  return (((w * 7 + d) * 24 + h) * 60 + min) * 60 * 1000;
}

function isApproved(o) {
  return Boolean(
    o &&
      typeof o.approvedBy === 'string' &&
      o.approvedBy.trim() &&
      typeof o.approvedAt === 'string' &&
      !Number.isNaN(Date.parse(o.approvedAt)),
  );
}

/**
 * Pure mirror of `extractBlobPathFromAzureUrl` (api/server/services/Files/Azure/crud.js):
 * `new URL()` drops any SAS query string; the container is located as a path segment so
 * path-style (Azurite) URLs resolve too. Mismatch falls back to the legacy strip-first-
 * segment behaviour, exactly like the delete path does.
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

/**
 * Where a stored file's bytes live, as far as the logical row can tell. Anything that is
 * not the primary Blob container becomes its own `files:<store>` sink, which the
 * manifest must then place — an unexpected store can never be silently ignored.
 */
function classifyPointer(filepath, source, containerName) {
  if (!filepath) return null;
  if (source === 'execute_code') return { kind: 'store', store: 'execute_code' };
  if (source === 'openai' || source === 'azure') return { kind: 'store', store: 'openai' };
  const value = String(filepath);
  if (/^https?:\/\//i.test(value)) {
    const isBlob =
      source === 'azure_blob' ||
      /\.blob\.core\.windows\.net\//i.test(value) ||
      /:10000\//.test(value);
    if (!isBlob) return { kind: 'store', store: 'external' };
    const blobPath = extractBlobPath(value, containerName);
    return blobPath ? { kind: 'blob', path: blobPath } : { kind: 'store', store: 'unrecognised' };
  }
  if (value.startsWith('/')) return { kind: 'store', store: 'local' };
  return { kind: 'store', store: 'unrecognised' };
}

/** Langfuse `DELETE /api/public/traces` takes `{ traceIds: string[] }`; batch to stay small. */
function buildLangfuseDeleteBatches(traceIds, size = LANGFUSE_DELETE_BATCH) {
  const ids = unique(traceIds || []);
  const batches = [];
  for (let i = 0; i < ids.length; i += size) batches.push({ traceIds: ids.slice(i, i + size) });
  return batches;
}

/** Mirror of feedback.ts's base-URL resolution so the probe hits the same instance. */
function resolveLangfuseBaseUrl(env = process.env) {
  const raw = env.LANGFUSE_BASE_URL || env.LANGFUSE_HOST || env.LANGFUSE_BASEURL || '';
  return raw.replace(/\/+$/, '');
}

function langfuseAuth(env = process.env) {
  const base = resolveLangfuseBaseUrl(env);
  if (!base || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  const token = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString(
    'base64',
  );
  return { base, headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' } };
}

/* ------------------------------------------------------------- probe results */

/** One materialised sink result. `count` is only meaningful when status is 'ok'. */
function probeResult(key, status, { count = null, exact = false, method, reason, detail } = {}) {
  return {
    key,
    status,
    count: status === 'ok' ? count : null,
    exact: status === 'ok' ? exact : false,
    method: method ?? null,
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {}),
  };
}

const ok = (key, count, method, detail) =>
  probeResult(key, 'ok', { count, exact: true, method, detail });

/* ------------------------------------------------------------- identity */

const IDENTITY_FIELDS = [
  '_id',
  'tenantId',
  'email',
  'emailNormalized',
  'username',
  'provider',
  'openidId',
  'idOnTheSource',
  'createdAt',
];

/**
 * The identity tuple every later phase is bound to. `evidenceGrade` is true only when
 * the subject was located by canonical `_id` AND the tenant was asserted and verified —
 * the only resolution that cannot pick the wrong person (PR #350 review).
 */
function buildIdentity(user, { resolvedBy, tenantAsserted }) {
  const identity = {
    _id: String(user._id),
    tenantId: user.tenantId != null ? String(user.tenantId) : null,
    email: user.email ?? null,
    emailNormalized: user.email ? String(user.email).trim().toLowerCase() : null,
    username: user.username ?? null,
    provider: user.provider ?? null,
    openidId: user.openidId ?? null,
    idOnTheSource: user.idOnTheSource ?? null,
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
  };
  const digest = sha256(
    stableStringify(Object.fromEntries(IDENTITY_FIELDS.map((k) => [k, identity[k]]))),
  );
  return {
    ...identity,
    resolvedBy,
    tenantAsserted: tenantAsserted ?? null,
    evidenceGrade: resolvedBy === 'canonical-id' && tenantAsserted != null,
    digest,
  };
}

/** Error text when the subject's recorded tenant contradicts `--tenant`, else null. */
function tenantMismatch(user, tenantArg) {
  if (tenantArg == null) return null;
  const actual = user.tenantId != null ? String(user.tenantId) : null;
  if (tenantArg === 'none') {
    return actual ? `subject belongs to tenant "${actual}", but --tenant said none` : null;
  }
  return actual === String(tenantArg)
    ? null
    : `subject tenant is "${actual ?? '(none)'}", but --tenant said "${tenantArg}"`;
}

function identityMatches(identity, { user, tenant }) {
  if (!identity || String(identity._id) !== String(user)) return false;
  if (tenant === 'none') return identity.tenantId === null;
  return identity.tenantId !== null && identity.tenantId === String(tenant);
}

/* ------------------------------------------------------------- manifest */

function loadManifest(envName, dir = MANIFEST_DIR) {
  if (!ENV_NAME_RE.test(String(envName))) throw new Error(`invalid environment name "${envName}"`);
  const file = path.join(dir, `${envName}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return {
    manifest: JSON.parse(raw),
    raw,
    file: path.relative(REPO_ROOT, file),
    sha256: sha256(raw),
  };
}

const REQUIRED_FIELDS = {
  'eventually-deleted': ['deadline', 'basis'],
  retained: ['basis', 'expiry'],
  'externally-controlled': ['controller', 'notification'],
  'not-probed': ['reason'],
  deleted: [],
};

/** Problems that make the manifest itself invalid, independent of any run. */
function structuralProblems(manifest, envName) {
  const problems = [];
  const add = (key, problem) => problems.push({ key: key ?? '(manifest)', problem });
  if (!manifest || typeof manifest !== 'object')
    return [{ key: '(manifest)', problem: 'not an object' }];
  if (manifest.manifestVersion !== 1) add(null, 'manifestVersion must be 1');
  if (envName && manifest.environment !== envName) {
    add(null, `environment is "${manifest.environment}", expected "${envName}"`);
  }
  if (typeof manifest.revision !== 'string' || !manifest.revision.trim())
    add(null, 'revision missing');
  if (!Array.isArray(manifest.sinks))
    return [...problems, { key: '(manifest)', problem: 'sinks must be an array' }];

  const probed = new Set(probedSinkKeys());
  const seen = new Set();
  for (const entry of manifest.sinks) {
    const key = entry?.key;
    if (typeof key !== 'string' || !key) {
      add(null, 'an entry has no key');
      continue;
    }
    if (seen.has(key)) add(key, 'duplicate key');
    seen.add(key);
    if (![true, false, 'unknown'].includes(entry.configured)) {
      add(key, 'configured must be true, false or "unknown"');
    }
    if (!DISPOSITIONS.includes(entry.disposition)) {
      add(key, `disposition must be one of ${DISPOSITIONS.join(', ')}`);
      continue;
    }
    if (entry.disposition === 'deleted' && !probed.has(key)) {
      add(key, '"deleted" needs a probe this script runs — use eventually-deleted or not-probed');
    }
    for (const field of REQUIRED_FIELDS[entry.disposition]) {
      if (typeof entry[field] !== 'string' || !entry[field].trim())
        add(key, `${entry.disposition} requires "${field}"`);
    }
    if (entry.disposition === 'eventually-deleted' && parseDuration(entry.deadline) === null) {
      add(key, `deadline "${entry.deadline}" is not an ISO 8601 duration in W/D/H/M`);
    }
    if (entry.baseline !== undefined && entry.baseline !== 'required') {
      if (!BASELINE_EXEMPTIONS.includes(entry.baseline?.exempt)) {
        add(key, `baseline must be "required" or { exempt: ${BASELINE_EXEMPTIONS.join('|')} }`);
      } else if (typeof entry.baseline.note !== 'string' || !entry.baseline.note.trim()) {
        add(key, 'a baseline exemption needs a written note');
      }
    }
    if (entry.lifecycleWindow !== undefined && parseDuration(entry.lifecycleWindow) === null) {
      add(key, `lifecycleWindow "${entry.lifecycleWindow}" is not a W/D/H/M duration`);
    }
    for (const field of ['container']) {
      if (
        entry[field] !== undefined &&
        (typeof entry[field] !== 'string' || !entry[field].trim())
      ) {
        add(key, `${field} must be a non-empty string`);
      }
    }
    if (entry.eventualClasses !== undefined) {
      for (const [cls, duration] of Object.entries(entry.eventualClasses || {})) {
        if (!['versions', 'softDeleted'].includes(cls))
          add(key, `eventualClasses.${cls} is not a lifecycle-expiring class`);
        if (parseDuration(duration) === null)
          add(key, `eventualClasses.${cls} deadline is not a W/D/H/M duration`);
      }
    }
  }
  for (const key of probed) {
    if (!seen.has(key)) add(key, 'probed by this script but missing from the manifest');
  }
  return problems;
}

/** Why an entry cannot resolve in this environment, or null. */
function entryBlocker(entry, signals) {
  if (entry.configured === 'unknown')
    return 'configured: "unknown" — record whether this store exists here';
  const signal = signalFor(entry.key, signals);
  if (entry.configured === false) {
    return signal === true
      ? 'manifest says not configured, but the environment shows it configured (drift)'
      : null;
  }
  if (entry.disposition === 'not-probed') return `declared not probed — ${entry.reason}`;
  const needsApproval = ['eventually-deleted', 'retained', 'externally-controlled'].includes(
    entry.disposition,
  );
  if (needsApproval && !isApproved(entry)) {
    return `${entry.disposition} is PROPOSED, not approved (approvedBy/approvedAt empty)`;
  }
  if (entry.eventualClasses && Object.keys(entry.eventualClasses).length && !isApproved(entry)) {
    return 'eventualClasses are PROPOSED, not approved (approvedBy/approvedAt empty)';
  }
  if (entry.baseline && entry.baseline !== 'required' && !isApproved(entry.baseline)) {
    return `baseline exemption ${entry.baseline.exempt} is PROPOSED, not approved`;
  }
  return null;
}

/**
 * Everything wrong with the manifest before any data is touched. Evidence mode refuses
 * to take a baseline while this is non-empty: a run that cannot end CLEAN should not
 * cost the operator a deletion first.
 */
function preflight(manifest, { envName, signals }) {
  const problems = structuralProblems(manifest, envName).map((p) => `${p.key}: ${p.problem}`);
  for (const entry of manifest?.sinks || []) {
    if (!entry?.key || !DISPOSITIONS.includes(entry.disposition)) continue;
    const blocker = entryBlocker(entry, signals);
    if (blocker) problems.push(`${entry.key}: ${blocker}`);
  }
  return problems;
}

/* ------------------------------------------------------------- probes */

async function probeMongo({ models, mongoose, view, tenantId }) {
  const out = {};
  const key = { $in: [view._id, String(view._id)] };
  out['mongo:users'] = ok(
    'mongo:users',
    await models.User.countDocuments({ _id: view._id }),
    'countDocuments',
  );
  for (const sink of MONGO_SINKS) {
    const k = `mongo:${sink.model}`;
    const Model = models[sink.model];
    out[k] = Model
      ? ok(k, await Model.countDocuments(sinkFilter(sink, view)), 'countDocuments(sinkFilter)')
      : probeResult(k, 'not-probed', {
          reason: 'model not registered in this build',
          method: 'countDocuments',
        });
  }
  const db = mongoose.connection.db;
  for (const raw of RAW_COLLECTIONS) {
    const k = `raw:${raw.collection}`;
    // Raw driver reads bypass the tenant plugin, so tenant-scoped collections are
    // filtered explicitly (same rule as dsar-collect).
    const filter = { [raw.field]: key };
    if (raw.tenantField && tenantId) filter[raw.tenantField] = tenantId;
    out[k] = ok(
      k,
      await db.collection(raw.collection).countDocuments(filter),
      'countDocuments(raw)',
    );
  }
  out['mongo:auditlogs'] = ok(
    'mongo:auditlogs',
    await db.collection('auditlogs').countDocuments({
      $or: [{ 'actor.id': String(view._id) }, { 'target.id': String(view._id) }],
    }),
    'countDocuments(raw)',
  );
  return out;
}

/**
 * Everything the `after` phase needs once the user document is gone: physical vector
 * ids (`knauf_asset_id ?? file_id`), the subject's asset ids, their authored agent ids
 * (agent-knowledge chunks carry the AGENT id as `user_id`/`entity_id`, never the
 * uploader's), and every Mongo pointer to a stored object.
 */
function buildInventory({
  files = [],
  assets = [],
  agents = [],
  avatar = null,
  containerName = 'files',
}) {
  const vectors = classifyVectorStores(files, assets);
  const blobPointers = [];
  const nonBlob = {};
  const codeSessions = [];
  const note = (pointer) => {
    if (!pointer) return;
    if (pointer.kind === 'blob') blobPointers.push(pointer.path);
    else nonBlob[pointer.store] = (nonBlob[pointer.store] ?? 0) + 1;
  };
  for (const f of files) {
    const pointer = classifyPointer(f.filepath || f.storageKey, f.source, containerName);
    // Review round 2: a code-execution file is persisted to Blob (`source: azure_blob`)
    // AND stays staged in the code adapter under `metadata.codeEnvRef`. The Blob copy
    // is a pointer like any other; the staged copy is a second store, keyed by session.
    const session = f.metadata?.codeEnvRef?.storage_session_id;
    const codeCopy = Boolean(session) || pointer?.store === 'execute_code';
    if (pointer?.store !== 'execute_code') note(pointer);
    if (codeCopy) nonBlob.execute_code = (nonBlob.execute_code ?? 0) + 1;
    if (session) codeSessions.push(String(session));
  }
  for (const a of assets) note(classifyPointer(a.blob?.path, a.blob?.source, containerName));
  if (avatar) note(classifyPointer(avatar, undefined, containerName));
  return {
    files: files.length,
    assets: assets.length,
    assetIds: unique([...files.map((f) => f.knauf_asset_id), ...assets.map((a) => a.asset_id)]),
    agentIds: unique(agents.map((a) => a.id)),
    codeSessions: unique(codeSessions),
    vectorIds: unique([...vectors.pgvector, ...vectors.azureAiSearch, ...vectors.unverified]),
    vectorEntries: vectors.entries.map((e) => ({
      vectorId: e.vectorId,
      backend: e.backend,
      activeGeneration: e.activeGeneration ?? null,
      staleGenerations: e.staleGenerations ?? [],
      unverified: e.unverified,
    })),
    blobPointers: unique(blobPointers),
    nonBlobPointers: nonBlob,
    containerName,
  };
}

async function inventorySubject({ models, view, containerName }) {
  const fileSink = MONGO_SINKS.find((s) => s.model === 'File');
  const assetSink = MONGO_SINKS.find((s) => s.model === 'KnaufFileAsset');
  const files = models.File
    ? await models.File.find(sinkFilter(fileSink, view))
        .select('file_id filepath storageKey source context embedded knauf_asset_id metadata')
        .lean()
    : [];
  const assetIds = unique(files.map((f) => f.knauf_asset_id));
  const assets = models.KnaufFileAsset
    ? await models.KnaufFileAsset.find(sinkFilter(assetSink, { ...view, _dsarAssetIds: assetIds }))
        .select(
          'asset_id vector_backend active_generation stale_generations blob scope_type scope_id status',
        )
        .lean()
    : [];
  const agents = models.Agent
    ? await models.Agent.find({ author: { $in: [view._id, String(view._id)] } })
        .select('id')
        .lean()
    : [];
  return buildInventory({ files, assets, agents, avatar: view.avatar, containerName });
}

async function probeMeili({ identity, env = process.env, fetchImpl = fetch }) {
  const keys = ['meili:messages', 'meili:convos'];
  if (!env.MEILI_HOST || !env.MEILI_MASTER_KEY) {
    return Object.fromEntries(
      keys.map((k) => [
        k,
        probeResult(k, 'not-probed', {
          reason: 'MEILI_HOST/MEILI_MASTER_KEY unset in the verifier environment',
        }),
      ]),
    );
  }
  const base = env.MEILI_HOST.replace(/\/+$/, '');
  const out = {};
  for (const index of ['messages', 'convos']) {
    const k = `meili:${index}`;
    const method = `POST /indexes/${index}/search (filter user, page/hitsPerPage)`;
    try {
      // page/hitsPerPage returns an exhaustive `totalHits`; offset/limit only ever
      // reports `estimatedTotalHits` (same finding as the DSAR collector).
      const res = await fetchImpl(`${base}/indexes/${index}/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.MEILI_MASTER_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: '',
          filter: `user = "${identity._id}"`,
          hitsPerPage: 1,
          page: 1,
        }),
      });
      if (!res.ok) {
        out[k] = probeResult(k, 'error', { method, reason: `HTTP ${res.status}` });
        continue;
      }
      const body = await res.json();
      out[k] = Number.isFinite(body?.totalHits)
        ? ok(k, body.totalHits, method)
        : probeResult(k, 'inexact', { method, reason: 'response carries no exhaustive totalHits' });
    } catch (err) {
      out[k] = probeResult(k, 'error', { method, reason: err.message });
    }
  }
  return out;
}

/**
 * Page one exact scan through `POST /verification/vectors` to exhaustion. Anything that
 * is not a complete, exact, self-consistent answer returns `{ ok: false }` — the caller
 * turns that into NOT PROBED, never into zero.
 */
async function ragScan({ fetchImpl, base, headers: headersFor, backend, key, values }) {
  let total = 0;
  const groups = [];
  /** The adapter's non-secret storage identity (v2) — must not change between pages. */
  let storage = null;
  for (const slice of chunk(values, RAG_MAX_VALUES)) {
    let cursor = null;
    let firstTotal = null;
    let sum = 0;
    let pages = 0;
    do {
      if (++pages > RAG_MAX_PAGES)
        return { ok: false, status: 'inexact', reason: `more than ${RAG_MAX_PAGES} pages` };
      let res;
      try {
        res = await fetchImpl(`${base}/verification/vectors`, {
          method: 'POST',
          // Minted per request: the app's short-lived JWT expires in minutes.
          headers: typeof headersFor === 'function' ? headersFor() : headersFor,
          body: JSON.stringify({ backend, key, values: slice, page_size: RAG_PAGE_SIZE, cursor }),
        });
      } catch (err) {
        return { ok: false, status: 'error', reason: err.message };
      }
      if (res.status === 404) {
        return {
          ok: false,
          status: 'not-probed',
          reason:
            'RAG verification adapter not deployed (RAG_VERIFICATION_ENABLED off, or an image without /verification/vectors)',
        };
      }
      if (res.status === 503)
        return {
          ok: false,
          status: 'not-probed',
          reason: `RAG service reports ${backend} unavailable`,
        };
      if (!res.ok)
        return {
          ok: false,
          status: 'error',
          reason: `HTTP ${res.status} from /verification/vectors`,
        };
      const body = await res.json();
      if (
        body?.adapter !== RAG_ADAPTER ||
        !(Number(body.adapter_version) >= RAG_ADAPTER_MIN_VERSION)
      ) {
        return {
          ok: false,
          status: 'not-probed',
          reason: `unexpected adapter ${body?.adapter}@${body?.adapter_version}`,
        };
      }
      if (body.backend !== backend || body.key !== key) {
        return { ok: false, status: 'error', reason: 'adapter answered a different query' };
      }
      if (!body.storage || typeof body.storage !== 'object') {
        return {
          ok: false,
          status: 'not-probed',
          reason: 'adapter did not report the storage identity behind this backend',
        };
      }
      if (storage === null) storage = body.storage;
      else if (stableStringify(storage) !== stableStringify(body.storage)) {
        return {
          ok: false,
          status: 'error',
          reason: 'adapter reported a different storage identity between pages',
        };
      }
      if (body.exact !== true) {
        return {
          ok: false,
          status: 'inexact',
          reason: body.inexact_reason || 'adapter reported an inexact answer',
        };
      }
      if (!Number.isInteger(body.total_chunks) || !Array.isArray(body.groups)) {
        return {
          ok: false,
          status: 'error',
          reason: 'adapter response is missing total_chunks/groups',
        };
      }
      if (firstTotal === null) firstTotal = body.total_chunks;
      else if (body.total_chunks !== firstTotal) {
        return {
          ok: false,
          status: 'inexact',
          reason: `total moved between pages (${firstTotal} → ${body.total_chunks})`,
        };
      }
      for (const g of body.groups) sum += Number(g.chunks) || 0;
      groups.push(...body.groups);
      cursor = body.next_cursor ?? null;
    } while (cursor);
    if (sum !== firstTotal) {
      return {
        ok: false,
        status: 'inexact',
        reason: `groups sum to ${sum} but the adapter reports ${firstTotal}`,
      };
    }
    total += firstTotal;
  }
  return { ok: true, total, groups, storage };
}

/** Scans per backend. Values that do not exist in a backend simply count zero there. */
function vectorScans(backend, identity, inventory) {
  const owners = unique([identity._id, ...inventory.agentIds]);
  const scans = [['asset_id', inventory.vectorIds]];
  if (backend === 'azure_search') scans.push(['entity_id', inventory.agentIds]);
  scans.push(['user_id', owners]);
  return scans;
}

async function probeVectors({
  backend,
  identity,
  inventory,
  env = process.env,
  fetchImpl = fetch,
  mintToken,
}) {
  const k = backend === 'pgvector' ? 'vectors:pgvector' : 'vectors:azureAiSearch';
  const method = 'POST /verification/vectors (exact, read-only)';
  if (!env.RAG_API_URL)
    return probeResult(k, 'not-probed', {
      method,
      reason: 'RAG_API_URL unset in the verifier environment',
    });
  if (typeof mintToken !== 'function')
    return probeResult(k, 'not-probed', { method, reason: 'no JWT minting available' });
  const base = env.RAG_API_URL.replace(/\/+$/, '');
  const headers = () => ({
    Authorization: `Bearer ${mintToken(RAG_PRINCIPAL)}`,
    'Content-Type': 'application/json',
  });
  const scans = [];
  let count = 0;
  let storage = null;
  for (const [key, values] of vectorScans(backend, identity, inventory)) {
    if (!values.length) {
      scans.push({ key, values: 0, total: 0, note: 'no identifiers of this kind' });
      continue;
    }
    const r = await ragScan({ fetchImpl, base, headers, backend, key, values });
    if (!r.ok) return probeResult(k, r.status, { method, reason: `${key} scan: ${r.reason}` });
    if (storage === null) storage = r.storage;
    else if (stableStringify(storage) !== stableStringify(r.storage)) {
      return probeResult(k, 'error', {
        method,
        reason: `${key} scan: adapter reported a different storage identity than the previous scan`,
      });
    }
    count += r.total;
    const byMatch = {};
    for (const g of r.groups) {
      const m = (byMatch[g.match] ??= {});
      const gen = g.generation ?? 'legacy';
      m[gen] = (m[gen] ?? 0) + g.chunks;
    }
    scans.push({ key, values: values.length, total: r.total, chunksByMatchAndGeneration: byMatch });
  }
  // Scans overlap (one chunk can match by asset id AND by owner), so `count` is a
  // sum of per-scan totals: zero exactly when every scan is zero, which is the
  // question erasure asks.
  // The `user_id` scan always carries the subject id, so a successful probe has always
  // asked the adapter at least once and `storage` is recorded.
  return ok(k, count, method, { scans, storage });
}

function classifyBlobItem(item) {
  if (item.deleted) return 'softDeleted';
  if (item.snapshot) return 'snapshots';
  if (item.versionId && item.isCurrentVersion === false) return 'versions';
  return 'current';
}

async function listAll(containerClient, prefix) {
  const items = [];
  const pages = containerClient
    .listBlobsFlat({ prefix, includeVersions: true, includeSnapshots: true, includeDeleted: true })
    .byPage({ maxPageSize: 1000 });
  for await (const page of pages) items.push(...(page?.segment?.blobItems ?? []));
  return items;
}

/**
 * Enumerate the subject's objects from STORAGE and reconcile against Mongo pointers.
 * Pointers outside the canonical layout are checked by exact path, but orphans under
 * such a layout cannot be enumerated — so their presence makes the sink NOT PROBED.
 */
async function probeBlob({ identity, inventory, containerClient }) {
  const k = 'blob:primary';
  const method = `listBlobsFlat(prefix, versions+snapshots+deleted), ${BLOB_BASE_PATHS.length} canonical prefixes`;
  if (!containerClient)
    return probeResult(k, 'not-probed', {
      method,
      reason: 'Azure Blob client not configured in the verifier environment',
    });
  const classes = Object.fromEntries(BLOB_CLASSES.map((c) => [c, 0]));
  const names = new Set();
  const prefixes = BLOB_BASE_PATHS.map((b) => `${b}/${identity._id}/`);
  try {
    for (const prefix of prefixes) {
      for (const item of await listAll(containerClient, prefix)) {
        classes[classifyBlobItem(item)] += 1;
        names.add(item.name);
      }
    }
    const outside = inventory.blobPointers.filter(
      (p) => !prefixes.some((prefix) => p.startsWith(prefix)),
    );
    for (const p of outside) {
      for (const item of await listAll(containerClient, p)) {
        if (item.name !== p) continue;
        classes[classifyBlobItem(item)] += 1;
        names.add(item.name);
      }
    }
    const pointed = new Set(inventory.blobPointers);
    const detail = {
      container: inventory.containerName,
      prefixes,
      classes,
      objects: [...names].sort(),
      withoutMongoPointer: [...names].filter((n) => !pointed.has(n)).length,
      pointersOutsideCanonicalLayout: outside.length,
    };
    const count = BLOB_CLASSES.reduce((n, c) => n + classes[c], 0);
    if (outside.length) {
      return probeResult(k, 'not-probed', {
        method,
        detail,
        reason: `${outside.length} Mongo pointer(s) outside the canonical {base}/{userId}/ layout — objects under that layout cannot be enumerated`,
      });
    }
    return ok(k, count, method, detail);
  } catch (err) {
    return probeResult(k, 'error', { method, reason: err.message });
  }
}

/**
 * Code-adapter staging: every input and output the subject's File rows reference lives
 * at `<container>/<sessionId>/…` until the adapter's TTL reaper removes it (review
 * round 2). Listing the session prefixes finds staged copies whether or not a File row
 * still points at them. Sessions come from the baseline inventory, because the rows are
 * gone by `after`.
 */
async function probeCodeStaging({ inventory, containerClient, containerName }) {
  const k = 'files:execute_code';
  const method = `listBlobsFlat(<sessionId>/, versions+snapshots+deleted) in ${containerName}`;
  if (!containerClient)
    return probeResult(k, 'not-probed', {
      method,
      reason: `Azure Blob client for ${containerName} not available in the verifier environment`,
    });
  const sessions = inventory?.codeSessions ?? [];
  const classes = Object.fromEntries(BLOB_CLASSES.map((c) => [c, 0]));
  const names = new Set();
  try {
    for (const sid of sessions) {
      for (const item of await listAll(containerClient, `${sid}/`)) {
        classes[classifyBlobItem(item)] += 1;
        names.add(item.name);
      }
    }
  } catch (err) {
    return probeResult(k, 'error', { method, reason: err.message });
  }
  const count = BLOB_CLASSES.reduce((n, c) => n + classes[c], 0);
  return ok(k, count, method, {
    container: containerName,
    sessions,
    classes,
    objects: [...names].sort(),
  });
}

/**
 * Translation scratch carries no subject key (`<uuid>/<name>`, uuid never persisted), so
 * the probe checks the store's own promise instead: the app deletes scratch after each
 * batch, and a storage lifecycle rule removes what a lost or cancelled batch leaves. A
 * current object older than that window means the rule is not enforcing, and every
 * subject's scratch is then a residual. Soft-deleted and versioned copies are reported,
 * not counted: they belong to the account's own retention, like `blob:primary`'s.
 */
async function probeTranslationScratch({ clients = [], names = [], windowMs, now = Date.now() }) {
  const k = 'translation:scratch';
  const method = `listBlobsFlat('') in ${names.join(', ')}; current objects older than the lifecycle window`;
  const missing = names.filter((_, i) => !clients[i]);
  if (missing.length || !names.length)
    return probeResult(k, 'not-probed', {
      method,
      reason: `Azure Blob client for ${missing.join(', ') || 'the scratch containers'} not available in the verifier environment`,
    });
  const cutoff = now - windowMs;
  const overdue = [];
  const classes = Object.fromEntries(BLOB_CLASSES.map((c) => [c, 0]));
  try {
    for (const [i, client] of clients.entries()) {
      for (const item of await listAll(client, '')) {
        const cls = classifyBlobItem(item);
        classes[cls] += 1;
        if (cls !== 'current') continue;
        const raw = item.properties?.lastModified ?? item.lastModified;
        const modified = raw instanceof Date ? raw.getTime() : Date.parse(raw ?? '');
        if (!Number.isFinite(modified))
          return probeResult(k, 'inexact', {
            method,
            reason: `${names[i]}/${item.name} carries no lastModified`,
          });
        if (modified < cutoff) overdue.push(`${names[i]}/${item.name}`);
      }
    }
  } catch (err) {
    return probeResult(k, 'error', { method, reason: err.message });
  }
  return ok(k, overdue.length, method, {
    containers: names,
    olderThan: new Date(cutoff).toISOString(),
    classes,
    overdue: overdue.slice(0, 50),
  });
}

/**
 * The project the credentials are scoped to (`GET /api/public/projects`). Review round
 * 2: a host is not an identity — project B on the same host, reached with rotated
 * credentials, must never be deleted from on the strength of a baseline taken in A.
 */
async function resolveLangfuseProject({ auth, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${auth.base}/api/public/projects`, { headers: auth.headers });
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status} from /api/public/projects` };
  const body = await res.json();
  const projects = Array.isArray(body?.data) ? body.data : [];
  if (projects.length !== 1 || !projects[0]?.id) {
    return {
      ok: false,
      reason: `credentials resolve to ${projects.length} project(s); expected exactly one`,
    };
  }
  return { ok: true, id: String(projects[0].id), name: projects[0].name ?? null };
}

/**
 * Direct `GET /api/public/{route}/{id}` for every baseline id. The list routes filter
 * scores by userId through a join to the parent trace, so a score whose trace is gone
 * disappears from the list and from `totalItems`; a lookup by id does not need the
 * parent. 404 = gone; 200 = still there; anything else is not an answer.
 */
async function lookupLangfuseIds({ auth, route, ids, fetchImpl = fetch }) {
  const wanted = unique(ids);
  if (wanted.length > LANGFUSE_MAX_LOOKUPS) {
    return {
      ok: false,
      status: 'inexact',
      reason: `${route}: ${wanted.length} baseline ids exceed the ${LANGFUSE_MAX_LOOKUPS} direct-lookup bound`,
    };
  }
  const present = [];
  for (const id of wanted) {
    let res;
    try {
      res = await fetchImpl(`${auth.base}/api/public/${route}/${encodeURIComponent(id)}`, {
        headers: auth.headers,
      });
    } catch (err) {
      return { ok: false, status: 'error', reason: `${route}/${id}: ${err.message}` };
    }
    if (res.status === 404) continue;
    if (!res.ok)
      return { ok: false, status: 'error', reason: `${route}/${id}: HTTP ${res.status}` };
    present.push(id);
  }
  return { ok: true, present, absent: wanted.length - present.length };
}

/**
 * Why `--phase langfuse-delete` must not run, or null. Pure, so the refusals are
 * testable: the same instance AND the same project as the baseline (rotated keys inside
 * the project are fine), an exact listing, and a listing that shares at least one id
 * with the baseline — the account is already deleted, so nothing new can be written for
 * this subject, and a disjoint listing is another scope, not new data.
 */
function langfuseDeleteRefusal({ before, auth, project, current }) {
  const recordedBase = before?.backends?.langfuse?.baseUrl;
  if (!auth || !recordedBase || auth.base !== recordedBase) {
    return `Langfuse here (${auth?.base ?? 'unset'}) is not the instance the baseline probed (${recordedBase ?? 'none'})`;
  }
  const recordedProject = before?.backends?.langfuse?.projectId;
  if (!project?.ok || !recordedProject || project.id !== recordedProject) {
    return `these credentials resolve to Langfuse project ${project?.ok ? project.id : `(${project?.reason ?? 'unresolved'})`}, the baseline was taken in ${recordedProject ?? '(none recorded)'}`;
  }
  if (!current?.ok) {
    return `could not list the subject's traces exactly (${current?.reason ?? 'no listing'})`;
  }
  const captured = new Set(before.sinks?.['langfuse:traces']?.detail?.traceIds ?? []);
  if (captured.size && current.ids.length && !current.ids.some((id) => captured.has(id))) {
    return `the ${current.ids.length} trace(s) listed now share no id with the ${captured.size} captured at baseline — wrong project, instance or subject`;
  }
  return null;
}

/** Page a Langfuse list route to exhaustion and reconcile against `meta.totalItems`. */
async function listLangfuse({ auth, route, userId, fetchImpl }) {
  const ids = new Set();
  let totalItems = null;
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    if (page > LANGFUSE_MAX_PAGES)
      return {
        ok: false,
        status: 'inexact',
        reason: `${route}: more than ${LANGFUSE_MAX_PAGES} pages`,
      };
    let res;
    try {
      res = await fetchImpl(
        `${auth.base}/api/public/${route}?userId=${encodeURIComponent(userId)}&limit=${LANGFUSE_PAGE_SIZE}&page=${page}`,
        { headers: auth.headers },
      );
    } catch (err) {
      return { ok: false, status: 'error', reason: `${route}: ${err.message}` };
    }
    if (!res.ok)
      return { ok: false, status: 'error', reason: `${route}: HTTP ${res.status} on page ${page}` };
    const body = await res.json();
    const meta = body?.meta ?? {};
    if (
      !Array.isArray(body?.data) ||
      !Number.isFinite(meta.totalItems) ||
      !Number.isFinite(meta.totalPages)
    ) {
      return {
        ok: false,
        status: 'inexact',
        reason: `${route}: response has no data/meta.totalItems/meta.totalPages`,
      };
    }
    if (totalItems === null) totalItems = meta.totalItems;
    else if (meta.totalItems !== totalItems) {
      return { ok: false, status: 'inexact', reason: `${route}: totalItems moved between pages` };
    }
    totalPages = meta.totalPages;
    for (const row of body.data) {
      if (
        row.userId !== undefined &&
        row.userId !== null &&
        String(row.userId) !== String(userId)
      ) {
        return {
          ok: false,
          status: 'error',
          reason: `${route}: API returned a row for another userId`,
        };
      }
      ids.add(row.id);
    }
  }
  if (ids.size !== totalItems) {
    return {
      ok: false,
      status: 'inexact',
      reason: `${route}: collected ${ids.size} ids but the API reports ${totalItems}`,
    };
  }
  return { ok: true, ids: [...ids], total: totalItems };
}

/**
 * Langfuse `userId` IS the Mongo id (pinned by KK20-327). With `baseline` (the `after`
 * phase) every id captured at baseline is also looked up directly, and the count is the
 * union of what the list still returns and what the lookups still find.
 */
async function probeLangfuse({ identity, env = process.env, fetchImpl = fetch, baseline = null }) {
  const auth = langfuseAuth(env);
  const keys = { traces: 'langfuse:traces', scores: 'langfuse:scores' };
  const idField = { traces: 'traceIds', scores: 'scoreIds' };
  const method = baseline
    ? 'GET /api/public/{traces,scores}?userId (paged, reconciled) ∪ GET /api/public/{traces,scores}/{id} for every baseline id'
    : 'GET /api/public/{traces,scores}?userId (paged, reconciled to meta.totalItems)';
  const both = (status, reason, detail) =>
    Object.fromEntries(
      Object.values(keys).map((k) => [k, probeResult(k, status, { method, reason, detail })]),
    );
  if (!auth) {
    return both(
      'not-probed',
      'LANGFUSE_BASE_URL/LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY unset in the verifier environment',
    );
  }
  const project = await resolveLangfuseProject({ auth, fetchImpl });
  if (!project.ok) {
    return both('not-probed', `cannot bind the credentials to a project: ${project.reason}`, {
      baseUrl: auth.base,
    });
  }
  const bound = { baseUrl: auth.base, projectId: project.id, projectName: project.name };
  const out = {};
  for (const [route, k] of Object.entries(keys)) {
    const r = await listLangfuse({ auth, route, userId: identity._id, fetchImpl });
    if (!r.ok) {
      out[k] = probeResult(k, r.status, { method, reason: r.reason, detail: bound });
      continue;
    }
    const ids = new Set(r.ids);
    let surviving = [];
    if (baseline) {
      const lookup = await lookupLangfuseIds({
        auth,
        route,
        ids: baseline[idField[route]] ?? [],
        fetchImpl,
      });
      if (!lookup.ok) {
        out[k] = probeResult(k, lookup.status, { method, reason: lookup.reason, detail: bound });
        continue;
      }
      surviving = lookup.present;
      for (const id of surviving) ids.add(id);
    }
    out[k] = ok(k, ids.size, method, {
      ...bound,
      [idField[route]]: [...ids],
      ...(baseline ? { listed: r.total, survivingBaselineIds: surviving } : {}),
    });
  }
  return out;
}

async function deleteLangfuseTraces({ traceIds, env = process.env, fetchImpl = fetch, log }) {
  const auth = langfuseAuth(env);
  if (!auth)
    throw new Error('LANGFUSE_BASE_URL/LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY are required');
  const batches = buildLangfuseDeleteBatches(traceIds);
  const accepted = [];
  for (const [i, body] of batches.entries()) {
    const res = await fetchImpl(`${auth.base}/api/public/traces`, {
      method: 'DELETE',
      headers: auth.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = new Error(`Langfuse batch ${i + 1}/${batches.length} failed: HTTP ${res.status}`);
      err.accepted = accepted;
      throw err;
    }
    accepted.push(...body.traceIds);
    log(
      `[langfuse] batch ${i + 1}/${batches.length}: ${body.traceIds.length} traces accepted (async, ≤ ~15 min)`,
    );
  }
  return { batches: batches.length, accepted };
}

/**
 * Keys that embed the subject id (`PENDING_REQ:<id>`, `tools:mcp:<id>:…`, `user:<id>`,
 * `<id>:<conversationId>` …). Exact for key-addressable entries; entries keyed by a
 * session or token id cannot be found by subject and belong to `redis:opaque`.
 */
async function probeRedis({ identity, client }) {
  const k = 'redis:keys';
  const method = 'SCAN MATCH *<id>* (standalone)';
  if (!client)
    return probeResult(k, 'not-probed', {
      method,
      reason: 'no Redis client in the verifier environment (REDIS_URI unset, or cluster mode)',
    });
  const pattern = `*${identity._id}*`;
  const keys = new Set();
  let cursor = '0';
  let rounds = 0;
  try {
    do {
      if (++rounds > REDIS_MAX_SCAN_ROUNDS)
        return probeResult(k, 'inexact', { method, reason: 'SCAN did not complete' });
      const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      for (const key of batch) keys.add(key);
      cursor = String(next);
    } while (cursor !== '0');
  } catch (err) {
    return probeResult(k, 'error', { method, reason: err.message });
  }
  const namespaces = {};
  for (const key of keys) {
    const ns = key.split(':')[0] || '(none)';
    namespaces[ns] = (namespaces[ns] ?? 0) + 1;
  }
  return ok(k, keys.size, method, { pattern, namespaces });
}

function probeLogs({ identity, env = process.env, logDir }) {
  const k = 'logs:files';
  const method = 'grep <id> in *.log and *.log.gz';
  if (String(env.LOG_TO_FILE ?? '').toLowerCase() === 'false') {
    return probeResult(k, 'not-probed', {
      method,
      reason: 'LOG_TO_FILE=false — server logs go to stdout and the log platform (logs:platform)',
    });
  }
  const dir = logDir || env.LIBRECHAT_LOG_DIR || path.join(REPO_ROOT, 'api', 'logs');
  if (!fs.existsSync(dir))
    return probeResult(k, 'not-probed', {
      method,
      reason: `log directory ${dir} not reachable from here`,
    });
  const zlib = require('node:zlib');
  let lines = 0;
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.log') || n.endsWith('.log.gz'));
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f));
      const text = f.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      lines += text.split('\n').filter((l) => l.includes(identity._id)).length;
    } catch (err) {
      return probeResult(k, 'error', { method, reason: `could not read ${f}: ${err.message}` });
    }
  }
  return ok(k, lines, method, { dir, filesScanned: files.length });
}

/**
 * Take one snapshot. Every probed key gets a result — `skipped` and `not-configured`
 * included — so nothing can be absent by accident.
 */
async function takeSnapshot({
  manifest,
  identity,
  inventory,
  skip = [],
  deps,
  env = process.env,
  logDir,
  /** The `before` snapshot's sinks; present in the `after` phase for id lookups. */
  baselineSinks = null,
}) {
  const sinks = {};
  const entries = new Map((manifest.sinks || []).map((e) => [e.key, e]));
  const keysOf = (group) => probedSinkKeys().filter((k) => probeGroupOf(k) === group);
  const run = async (group, fn) => {
    const keys = keysOf(group);
    if (skip.includes(group)) {
      for (const k of keys)
        sinks[k] = probeResult(k, 'skipped', { reason: `--skip ${group} (rehearsal)` });
      return;
    }
    const wanted = keys.filter((k) => entries.get(k)?.configured !== false);
    for (const k of keys.filter((k) => !wanted.includes(k))) {
      sinks[k] = probeResult(k, 'not-configured', { reason: 'manifest: configured false' });
    }
    if (!wanted.length) return;
    try {
      const results = await fn(wanted);
      for (const k of wanted) {
        sinks[k] = results[k] ?? probeResult(k, 'error', { reason: 'probe produced no result' });
      }
    } catch (err) {
      for (const k of wanted) sinks[k] = probeResult(k, 'error', { reason: err.message });
    }
  };

  const view = {
    ...identity,
    _id: deps.toObjectId(identity._id),
    _dsarAssetIds: inventory.assetIds,
  };
  await run('mongo', () =>
    probeMongo({ models: deps.models, mongoose: deps.mongoose, view, tenantId: identity.tenantId }),
  );
  await run('meili', () => probeMeili({ identity, env, fetchImpl: deps.fetch }));
  await run('vectors', async (wanted) => {
    const out = {};
    if (wanted.includes('vectors:pgvector')) {
      out['vectors:pgvector'] = await probeVectors({
        backend: 'pgvector',
        identity,
        inventory,
        env,
        fetchImpl: deps.fetch,
        mintToken: deps.mintToken,
      });
    }
    if (wanted.includes('vectors:azureAiSearch')) {
      out['vectors:azureAiSearch'] = await probeVectors({
        backend: 'azure_search',
        identity,
        inventory,
        env,
        fetchImpl: deps.fetch,
        mintToken: deps.mintToken,
      });
    }
    return out;
  });
  const containers = deps.containers ?? { clients: {}, names: {} };
  await run('blob', async () => ({
    'blob:primary': await probeBlob({
      identity,
      inventory,
      containerClient: containers.clients?.primary ?? null,
    }),
  }));
  await run('langfuse', () =>
    probeLangfuse({
      identity,
      env,
      fetchImpl: deps.fetch,
      baseline: baselineSinks
        ? {
            traceIds: baselineSinks['langfuse:traces']?.detail?.traceIds ?? [],
            scoreIds: baselineSinks['langfuse:scores']?.detail?.scoreIds ?? [],
          }
        : null,
    }),
  );
  await run('redis', async () => ({
    'redis:keys': await probeRedis({ identity, client: deps.redis }),
  }));
  await run('logs', async () => ({ 'logs:files': probeLogs({ identity, env, logDir }) }));
  await run('translation', async () => {
    const entry = entries.get('translation:scratch');
    const windowMs =
      parseDuration(entry?.lifecycleWindow) ?? parseDuration(TRANSLATION_LIFECYCLE_DEFAULT);
    return {
      'translation:scratch': await probeTranslationScratch({
        clients: containers.clients?.translation ?? [],
        names: containers.names?.translation ?? TRANSLATION_SCRATCH_CONTAINERS(env),
        windowMs,
      }),
    };
  });
  await run('code', async () => ({
    'files:execute_code': await probeCodeStaging({
      inventory,
      containerClient: containers.clients?.codeStaging ?? null,
      containerName: containers.names?.codeStaging ?? CODE_STAGING_CONTAINER_DEFAULT,
    }),
  }));
  return sinks;
}

/* ------------------------------------------------------------- backend identity */

/** `scheme://[user:pass@]hosts/path` → the same without credentials or query. */
function stripCredentials(uri) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/?#]*)([^?#]*)?/i.exec(String(uri ?? ''));
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    hosts: m[2]
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
      .sort(),
    path: (m[3] || '').replace(/^\/+/, '').replace(/\/+$/, ''),
  };
}

/**
 * Container clients for every Blob store the probes read. Names are deployment facts:
 * the primary container from the app's env, the code-adapter container from the
 * manifest entry, the scratch containers from the translation env.
 */
async function openContainers({ manifest, env = process.env, getAzureContainerClient }) {
  const names = {
    primary: env.AZURE_CONTAINER_NAME || 'files',
    codeStaging:
      (manifest?.sinks || []).find((s) => s?.key === 'files:execute_code')?.container ||
      CODE_STAGING_CONTAINER_DEFAULT,
    translation: TRANSLATION_SCRATCH_CONTAINERS(env),
  };
  const open = async (name) => {
    try {
      return (await getAzureContainerClient(name)) ?? null;
    } catch {
      return null;
    }
  };
  return {
    names,
    clients: {
      primary: await open(names.primary),
      codeStaging: await open(names.codeStaging),
      translation: await Promise.all(names.translation.map(open)),
    },
  };
}

/**
 * The non-secret physical identity of every store the verifier can name locally:
 * hosts, database, endpoint, index, container URL. Review round 2: `envSignals` said
 * only whether a store was configured, so an endpoint swapped for an empty instance
 * between phases read as CLEAN.
 */
function localBackends({ env = process.env, mongoose = null, containers = null } = {}) {
  const b = {};
  const mongo = stripCredentials(env.MONGO_URI);
  if (mongo) {
    b.mongo = { hosts: mongo.hosts, database: mongo.path.split('/')[0] || null };
  } else if (mongoose?.connection?.host) {
    b.mongo = {
      hosts: [`${mongoose.connection.host}:${mongoose.connection.port ?? ''}`],
      database: mongoose.connection.name ?? null,
    };
  }
  const meili = stripCredentials(env.MEILI_HOST);
  if (meili) b.meili = { endpoint: `${meili.scheme}://${meili.hosts.join(',')}` };
  const rag = stripCredentials(env.RAG_API_URL);
  if (rag) {
    b.ragApi = {
      endpoint: `${rag.scheme}://${rag.hosts.join(',')}${rag.path ? `/${rag.path}` : ''}`,
    };
  }
  const langfuse = resolveLangfuseBaseUrl(env);
  if (langfuse) b.langfuse = { baseUrl: langfuse };
  const redis = stripCredentials(String(env.REDIS_URI || '').split(',')[0]);
  if (redis) b.redis = { hosts: redis.hosts, db: redis.path || '0' };
  const url = (client) => (client?.url ? String(client.url).split('?')[0] : null);
  const clients = containers?.clients ?? {};
  if (url(clients.primary)) b['container:primary'] = { url: url(clients.primary) };
  if (url(clients.codeStaging)) b['container:codeStaging'] = { url: url(clients.codeStaging) };
  (clients.translation ?? []).forEach((c, i) => {
    if (url(c)) b[`container:translation${i}`] = { url: url(c) };
  });
  return b;
}

/** Local identities plus what the probes learned: the Langfuse project, the RAG storage. */
function collectBackends({ local = {}, sinks = {} }) {
  const b = { ...local };
  const projectId =
    sinks['langfuse:traces']?.detail?.projectId ?? sinks['langfuse:scores']?.detail?.projectId;
  if (projectId) b.langfuse = { ...(b.langfuse ?? {}), projectId };
  for (const [key, name] of [
    ['vectors:pgvector', 'pgvector'],
    ['vectors:azureAiSearch', 'azureAiSearch'],
  ]) {
    const storage = sinks[key]?.detail?.storage;
    if (storage) b[`vectors:${name}`] = storage;
  }
  return b;
}

/**
 * Field-level comparison: every field the CURRENT side knows must equal what the
 * baseline recorded for it. A field only the baseline knows (the Langfuse project id
 * before the probes run) is not a mismatch; a field only the current side knows is new
 * information, not drift.
 */
function backendMismatch(before = {}, current = {}) {
  const out = [];
  for (const [key, value] of Object.entries(current ?? {})) {
    const recorded = before?.[key];
    if (recorded === undefined || value === undefined) continue;
    const fields = value && typeof value === 'object' ? Object.keys(value) : [];
    if (!fields.length) {
      if (stableStringify(recorded) !== stableStringify(value))
        out.push({ key, field: null, before: recorded, after: value });
      continue;
    }
    for (const field of fields) {
      if (recorded?.[field] === undefined) continue;
      if (stableStringify(recorded[field]) !== stableStringify(value[field])) {
        out.push({ key, field, before: recorded[field], after: value[field] });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------- verdict */

function fmtCount(result) {
  if (!result) return '—';
  if (result.status === 'ok') return String(result.count);
  return result.status;
}

/** Why a probe result is not usable evidence, or null. */
function probeGap(result, phase) {
  if (!result) return `${phase}: no result recorded (absent from the snapshot)`;
  if (result.status !== 'ok')
    return `${phase}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`;
  if (result.exact !== true || !Number.isFinite(result.count))
    return `${phase}: not an exact count`;
  return null;
}

/**
 * Sinks the before-inventory proves are in play but no probe covers: files stored
 * outside the primary Blob container. Each needs its own manifest entry.
 */
function inventorySinkKeys(inventory) {
  return Object.keys(inventory?.nonBlobPointers ?? {}).map((source) => `files:${source}`);
}

/**
 * Which sinks lack a usable baseline — what the operator must seed before deleting.
 * Shared by `before` (fail fast) and the verdict.
 */
function baselineGaps(manifest, before) {
  const gaps = [];
  for (const entry of manifest.sinks || []) {
    if (entry.configured !== true) continue;
    if (!['deleted', 'eventually-deleted'].includes(entry.disposition)) continue;
    if (!probedSinkKeys().includes(entry.key)) continue;
    const b = before?.sinks?.[entry.key];
    const gap = probeGap(b, 'before');
    if (gap) gaps.push({ key: entry.key, reason: gap });
    else if (
      b.count === 0 &&
      !(entry.baseline && entry.baseline !== 'required' && isApproved(entry.baseline))
    ) {
      gaps.push({
        key: entry.key,
        reason: 'NO BASELINE — before count is 0; seed it or record an approved exemption',
      });
    }
  }
  return gaps;
}

function deadlineFrom(startIso, duration) {
  const ms = parseDuration(duration);
  const start = Date.parse(startIso);
  return ms === null || Number.isNaN(start) ? null : new Date(start + ms);
}

/**
 * The verdict. Iterates the MANIFEST (plus anything the inventory proves exists), never
 * the snapshot, so a missing or skipped result is a blocker rather than a silent pass.
 */
function evaluate({
  manifest,
  before,
  after,
  langfuseDelete = null,
  now = Date.now(),
  signals = after?.envSignals,
}) {
  const rows = [];
  const blockers = [];
  const residuals = [];
  const obligations = [];
  const notes = [];
  const block = (key, text) => blockers.push({ key, text });

  for (const p of structuralProblems(manifest, before?.environment)) block(p.key, p.problem);

  // run-level bindings
  if (before?.kind !== EVIDENCE_KIND || before?.schemaVersion !== SCHEMA_VERSION)
    block('(run)', 'before.json is not a v2 erasure baseline');
  if (after && before && after.runId !== before.runId)
    block('(run)', 'after snapshot belongs to a different run');
  if (!before?.identity?.evidenceGrade) {
    block(
      '(identity)',
      'subject was not resolved by canonical _id + verified tenant — not evidence-grade',
    );
  }
  const baselineAge = Date.parse(after?.generatedAt) - Date.parse(before?.generatedAt);
  if (!(baselineAge >= 0)) block('(run)', 'after snapshot is not later than the baseline');
  else if (baselineAge > MAX_BASELINE_AGE_MS)
    block('(run)', 'STALE baseline — older than 24 h; re-run the recipe');
  for (const [signal, value] of Object.entries(before?.envSignals ?? {})) {
    if (after?.envSignals && after.envSignals[signal] !== value) {
      block(
        '(environment)',
        `environment changed between phases: ${signal} ${value} → ${after.envSignals[signal]}`,
      );
    }
  }
  // Physical storage identity (review round 2): the same hosts, database, index,
  // container and project on both sides, or the comparison is meaningless.
  if (!before?.backends || !Object.keys(before.backends).length) {
    block('(storage)', 'the baseline recorded no backend identities');
  }
  const drift = backendMismatch(before?.backends, after?.backends);
  for (const d of drift) {
    block(
      `(storage:${d.key})`,
      `backend changed between phases${d.field ? ` (${d.field})` : ''}: ${stableStringify(d.before)} → ${stableStringify(d.after)}`,
    );
  }
  if (
    langfuseDelete &&
    (langfuseDelete.runId !== before?.runId ||
      langfuseDelete.identityDigest !== before?.identity?.digest)
  ) {
    block('langfuse:traces', 'langfuse-delete record belongs to another run or identity');
  }
  const baselineProject = before?.backends?.langfuse?.projectId;
  if (langfuseDelete && baselineProject && langfuseDelete.projectId !== baselineProject) {
    block(
      'langfuse:traces',
      `langfuse-delete ran against Langfuse project ${langfuseDelete.projectId ?? '(unknown)'}, the baseline was taken in ${baselineProject}`,
    );
  }

  const probed = new Set(probedSinkKeys());
  const entries = [...(manifest?.sinks || [])];
  const declared = new Set(entries.map((e) => e?.key));
  for (const key of inventorySinkKeys(before?.inventory)) {
    if (!declared.has(key)) {
      block(
        key,
        `before-inventory holds ${before.inventory.nonBlobPointers[key.slice(6)]} file(s) stored as "${key.slice(6)}", and the manifest has no entry for that store`,
      );
    }
  }
  const inventoryNeeds = new Set(inventorySinkKeys(before?.inventory));

  for (const entry of entries) {
    if (!entry?.key || !DISPOSITIONS.includes(entry.disposition)) continue;
    const key = entry.key;
    const b = before?.sinks?.[key];
    const a = after?.sinks?.[key];
    const row = {
      key,
      label: entry.label ?? key,
      disposition: entry.disposition,
      before: fmtCount(b),
      after: fmtCount(a),
      status: '',
    };
    rows.push(row);
    const stop = (status, text = status) => {
      row.status = status;
      block(key, text);
    };

    const blocker = entryBlocker(entry, signals ?? {});
    if (entry.configured === false) {
      if (blocker) stop(`UNKNOWN — ${blocker}`, blocker);
      else if (inventoryNeeds.has(key)) {
        stop(
          'UNKNOWN — inventory holds data here but manifest says not configured',
          'before-inventory contradicts configured: false',
        );
      } else row.status = 'NOT CONFIGURED';
      continue;
    }
    if (blocker) {
      stop(
        entry.disposition === 'not-probed'
          ? `NOT PROBED — ${entry.reason}`
          : `UNKNOWN — ${blocker}`,
        blocker,
      );
      continue;
    }

    if (entry.disposition === 'externally-controlled') {
      row.status = `EXTERNALLY CONTROLLED — ${entry.controller}`;
      obligations.push({ key, text: `${entry.controller}: ${entry.notification}` });
      continue;
    }

    if (!probed.has(key)) {
      // eventually-deleted or retained with no probe: resolved by approval, stated as such.
      if (entry.disposition === 'eventually-deleted') {
        const by = deadlineFrom(before?.generatedAt, entry.deadline);
        row.status = `EVENTUALLY DELETED — by ${by ? by.toISOString().slice(0, 10) : '?'} (not verified here)`;
        obligations.push({
          key,
          text: `${entry.basis} — confirm by ${by ? by.toISOString() : entry.deadline}`,
        });
      } else {
        row.status = `RETAINED — ${entry.basis}; expiry ${entry.expiry}`;
      }
      continue;
    }

    // probed sink: both phases must be exact, usable results
    const gap = probeGap(b, 'before') || probeGap(a, 'after');
    if (gap) {
      stop(`NOT PROBED — ${gap}`, gap);
      continue;
    }

    if (entry.disposition === 'retained') {
      row.status = `RETAINED — ${entry.basis}; expiry ${entry.expiry}`;
      continue;
    }

    // deleted / eventually-deleted: the before → after transition
    const exempt = entry.baseline && entry.baseline !== 'required' && isApproved(entry.baseline);
    if (b.count === 0 && !exempt) {
      stop(
        'NO BASELINE',
        'before count is 0 — the probe never proved it can see this data; seed it or approve an exemption',
      );
      continue;
    }
    if (a.count === 0) {
      row.status = b.count === 0 ? `N/A — ${entry.baseline.exempt} (approved)` : 'DELETED';
      continue;
    }

    // after > 0
    if (key === 'langfuse:traces' || key === 'langfuse:scores') {
      const requested = Date.parse(langfuseDelete?.requestedAt);
      if (!langfuseDelete) {
        stop(
          'RESIDUAL — run --phase langfuse-delete',
          'Langfuse still holds data and no deletion was requested',
        );
        residuals.push({ key, count: a.count });
        continue;
      }
      if (now < requested + LANGFUSE_SETTLE_MS) {
        const at = new Date(requested + LANGFUSE_SETTLE_MS).toISOString();
        stop(
          `PENDING — Langfuse deletes asynchronously; re-run after ${at}`,
          `settling until ${at}`,
        );
        continue;
      }
    }
    const classes = a.detail?.classes;
    if (classes && entry.eventualClasses) {
      const expiring = Object.keys(entry.eventualClasses);
      const hard = BLOB_CLASSES.filter((c) => !expiring.includes(c)).reduce(
        (n, c) => n + (classes[c] ?? 0),
        0,
      );
      const overdue = expiring.filter(
        (c) =>
          (classes[c] ?? 0) > 0 &&
          now > (deadlineFrom(before.generatedAt, entry.eventualClasses[c])?.getTime() ?? 0),
      );
      if (!hard && !overdue.length) {
        const latest = expiring
          .filter((c) => (classes[c] ?? 0) > 0)
          .map((c) => deadlineFrom(before.generatedAt, entry.eventualClasses[c]))
          .sort((x, y) => y - x)[0];
        row.status = `EVENTUALLY DELETED — ${expiring.filter((c) => classes[c]).join('+')} expire by ${latest.toISOString().slice(0, 10)}`;
        obligations.push({
          key,
          text: `lifecycle-expiring copies (${JSON.stringify(classes)}) — confirm gone after ${latest.toISOString()}`,
        });
        continue;
      }
    }
    if (entry.disposition === 'eventually-deleted') {
      const by = deadlineFrom(before.generatedAt, entry.deadline);
      if (by && now <= by.getTime()) {
        row.status = `EVENTUALLY DELETED — ${a.count} left, due by ${by.toISOString().slice(0, 10)}`;
        obligations.push({ key, text: `${entry.basis} — re-check after ${by.toISOString()}` });
        continue;
      }
    }
    row.status = 'RESIDUAL';
    residuals.push({ key, count: a.count });
    block(key, `RESIDUAL — ${a.count} left after deletion`);
  }

  for (const key of probed) {
    if (!declared.has(key))
      rows.push({
        key,
        label: key,
        disposition: '—',
        before: fmtCount(before?.sinks?.[key]),
        after: fmtCount(after?.sinks?.[key]),
        status: 'UNKNOWN — not in the manifest',
      });
  }

  const mode = before?.mode === 'evidence' ? 'evidence' : 'rehearsal';
  let verdict;
  if (residuals.length) verdict = 'RESIDUALS FOUND';
  else if (blockers.length) verdict = 'INCOMPLETE';
  else verdict = mode === 'evidence' ? 'CLEAN' : 'NOT EVIDENCE';
  if (mode !== 'evidence')
    notes.push('rehearsal mode — this run is never evidence, whatever it shows');
  return {
    verdict,
    ok: verdict === 'CLEAN',
    mode,
    rows,
    blockers,
    residuals,
    obligations,
    notes,
    backends: { compared: Object.keys(before?.backends ?? {}).length, mismatches: drift },
  };
}

function exitCodeFor(verdict) {
  return (
    {
      CLEAN: EXIT.CLEAN,
      'RESIDUALS FOUND': EXIT.RESIDUALS,
      INCOMPLETE: EXIT.INCOMPLETE,
      'NOT EVIDENCE': EXIT.NOT_EVIDENCE,
    }[verdict] ?? EXIT.INCOMPLETE
  );
}

/** Markdown evidence. Counts and identifiers only — the subject's email stays in before.json. */
function renderReport({ before, after, evaluation, langfuseDelete, currentManifestSha }) {
  const cell = (v) => String(v ?? '').replace(/\|/g, '/');
  const lines = [
    '# Erasure verification report',
    '',
    '| | |',
    '|---|---|',
    `| Verdict | **${evaluation.verdict}**${evaluation.blockers.length ? ` — ${evaluation.blockers.length} blocker(s)` : ''} |`,
    `| Mode | ${evaluation.mode} |`,
    `| Environment | ${cell(before.environment)} — \`${cell(before.manifest?.file)}\` rev \`${cell(before.manifest?.revision)}\`, sha256 \`${cell(before.manifest?.sha256)}\` |`,
    `| Run | \`${cell(before.runId)}\` |`,
    `| Subject | \`${cell(before.identity?._id)}\` · tenant \`${cell(before.identity?.tenantId ?? 'none')}\` · identity sha256 \`${cell(before.identity?.digest)}\` (resolved by ${cell(before.identity?.resolvedBy)}) |`,
    `| Baseline | ${cell(before.generatedAt)} |`,
    `| After | ${cell(after.generatedAt)} |`,
    `| Langfuse deletion | ${langfuseDelete ? `requested ${cell(langfuseDelete.requestedAt)}, ${langfuseDelete.traces} trace(s)` : 'not requested'} |`,
    `| Tool | \`knauf/scripts/erasure-verify.js\` sha256 \`${cell(after.tool?.sha256)}\` |`,
    `| Storage | ${evaluation.backends?.compared ?? 0} backend identities bound at baseline (${
      Object.keys(before.backends ?? {})
        .sort()
        .join(', ') || 'none'
    }); ${evaluation.backends?.mismatches?.length ? `**${evaluation.backends.mismatches.length} changed**` : 'unchanged at after'} |`,
    '',
    '## Sinks',
    '',
    '| Sink | Disposition | Before | After | Status |',
    '|---|---|---|---|---|',
    ...evaluation.rows.map(
      (r) =>
        `| \`${cell(r.key)}\` | ${cell(r.disposition)} | ${cell(r.before)} | ${cell(r.after)} | ${cell(r.status)} |`,
    ),
    '',
  ];
  if (evaluation.blockers.length) {
    lines.push('## Blockers — each one keeps this run from being CLEAN', '');
    for (const b of evaluation.blockers) lines.push(`- \`${cell(b.key)}\` — ${cell(b.text)}`);
    lines.push('');
  }
  if (evaluation.obligations.length) {
    lines.push('## Obligations outside this run', '');
    for (const o of evaluation.obligations) lines.push(`- \`${cell(o.key)}\` — ${cell(o.text)}`);
    lines.push('');
  }
  const notes = [...evaluation.notes];
  if (currentManifestSha && currentManifestSha !== before.manifest?.sha256) {
    notes.push(
      `the repository manifest has changed since the baseline (now sha256 ${currentManifestSha}); this run is judged against the revision in force at baseline`,
    );
  }
  if (notes.length) {
    lines.push('## Notes', '');
    for (const n of notes) lines.push(`- ${cell(n)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------- evidence files */

function toolInfo() {
  return { file: 'knauf/scripts/erasure-verify.js', sha256: sha256(fs.readFileSync(__filename)) };
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** An existing evidence directory from an earlier phase: no symlinks, 0700, has before.json. */
function openEvidenceDir(out) {
  const dir = assertNoSymlinkInPath(out);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    throw new Error(`Evidence directory does not exist: ${dir}`);
  fs.chmodSync(dir, 0o700);
  const before = readSecureJson(path.join(dir, 'before.json'), {
    bundleDir: dir,
    required: true,
  }).data;
  if (
    before?.kind !== EVIDENCE_KIND ||
    before?.schemaVersion !== SCHEMA_VERSION ||
    before?.phase !== 'before'
  ) {
    throw new Error(
      'before.json is not a v2 erasure baseline — re-run --phase before into a fresh directory',
    );
  }
  return { dir, before };
}

function latestLangfuseDelete(dir) {
  const names = fs
    .readdirSync(dir)
    .filter((n) => /^langfuse-delete-.*\.json$/.test(n))
    .sort();
  if (!names.length) return null;
  return readSecureJson(path.join(dir, names[names.length - 1]), { bundleDir: dir }).data;
}

/* ------------------------------------------------------------- main */

const USAGE = `usage:
  node knauf/scripts/erasure-verify.js --phase before --env <env> --user <mongo _id> --tenant <id|none> --out DIR
  node knauf/scripts/erasure-verify.js --phase langfuse-delete --env <env> --user <mongo _id> --tenant <id|none> --out DIR --confirm
  node knauf/scripts/erasure-verify.js --phase after --env <env> --out DIR
rehearsal (never evidence): --mode rehearsal [--user <email|username|openidId>] [--skip ${PROBE_GROUPS.join(',')}]
other: --log-dir DIR (only where LOG_TO_FILE is on)`;

/** A later phase must run against the same environment and mode as its baseline. */
function bindingError(args, before) {
  if (args.env !== before.environment) {
    return `baseline was taken for environment "${before.environment}", not "${args.env}"`;
  }
  if (args.phase === 'after' && args.mode !== before.mode) {
    return `baseline was taken in ${before.mode} mode; re-run with --mode ${before.mode}`;
  }
  if ((args.user || args.tenant) && !identityMatches(before.identity, args)) {
    return '--user/--tenant do not match the identity recorded in before.json';
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(EXIT.CLEAN);
  }
  const usage = validateArgs(args);
  if (usage) {
    console.error(`${usage}\n\n${USAGE}\n(runbook: knauf/docs/privacy/runbooks/erasure-verify.md)`);
    process.exit(EXIT.USAGE);
  }
  const env = process.env;

  if (args.phase === 'langfuse-delete') {
    const { dir, before } = openEvidenceDir(args.out);
    const bound = bindingError(args, before);
    if (bound) {
      console.error(`Refusing: ${bound}.`);
      process.exit(EXIT.REFUSED);
    }
    if (!before.identity?.evidenceGrade) {
      console.error(
        'Refusing: the baseline identity was not resolved by canonical _id + verified tenant.',
      );
      process.exit(EXIT.REFUSED);
    }
    const auth = langfuseAuth(env);
    const project = auth ? await resolveLangfuseProject({ auth, fetchImpl: fetch }) : null;
    const current = auth
      ? await listLangfuse({ auth, route: 'traces', userId: before.identity._id, fetchImpl: fetch })
      : null;
    const refusal = langfuseDeleteRefusal({ before, auth, project, current });
    if (refusal) {
      console.error(`Refusing: ${refusal}.`);
      process.exit(EXIT.REFUSED);
    }
    const captured = new Set(before.sinks['langfuse:traces'].detail.traceIds ?? []);
    const record = {
      kind: EVIDENCE_KIND,
      schemaVersion: SCHEMA_VERSION,
      phase: 'langfuse-delete',
      runId: before.runId,
      identityDigest: before.identity.digest,
      baseUrl: auth.base,
      projectId: project.id,
      requestedAt: new Date().toISOString(),
      traces: current.ids.length,
      capturedAtBaseline: captured.size,
      newSinceBaseline: current.ids.filter((id) => !captured.has(id)).length,
      alreadyGone: [...captured].filter((id) => !current.ids.includes(id)).length,
    };
    let exitCode = EXIT.CLEAN;
    try {
      const result = await deleteLangfuseTraces({ traceIds: current.ids, env, log: console.log });
      Object.assign(record, {
        status: 'requested',
        batches: result.batches,
        accepted: result.accepted.length,
      });
    } catch (err) {
      Object.assign(record, {
        status: 'partial',
        error: err.message,
        accepted: err.accepted?.length ?? 0,
      });
      exitCode = EXIT.INCOMPLETE;
    }
    writeBundleFile(dir, `langfuse-delete-${stamp()}.json`, JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record, null, 2));
    process.exit(exitCode);
  }

  // Mongo-backed phases. Same bootstrap as dsar-collect.js.
  require('module-alias')({ base: path.join(REPO_ROOT, 'api') });
  const connect = require('../../config/connect');
  const { runAsSystem, tenantStorage } = require('@librechat/data-schemas');
  const { generateShortLivedToken, getAzureContainerClient } = require('@librechat/api');
  const mongoose = require('mongoose');
  await connect();
  const models = require('~/db/models');
  const containerName = env.AZURE_CONTAINER_NAME || 'files';
  let redis = null;
  const redisUrls = String(env.REDIS_URI || '')
    .split(',')
    .filter(Boolean);
  if (
    String(env.USE_REDIS).toLowerCase() === 'true' &&
    redisUrls.length === 1 &&
    String(env.USE_REDIS_CLUSTER).toLowerCase() !== 'true'
  ) {
    const IoRedis = require('ioredis');
    const client = new IoRedis(redisUrls[0], {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      retryStrategy: () => null,
    });
    try {
      await client.connect();
      redis = client;
    } catch {
      // No client means `redis:keys` is NOT PROBED; never leave a reconnect loop behind.
      client.disconnect();
    }
  }
  const deps = {
    models,
    mongoose,
    fetch,
    redis,
    mintToken: generateShortLivedToken,
    // `containers` is attached per phase, once the manifest names the code container.
    containers: null,
    toObjectId: (id) => new mongoose.Types.ObjectId(id),
  };
  const inScope = (tenantId, fn) =>
    tenantId && tenantStorage?.run ? tenantStorage.run({ tenantId }, fn) : runAsSystem(fn);
  const signals = environmentSignals(env);
  let exitCode = EXIT.CLEAN;

  try {
    if (args.phase === 'before') {
      const loaded = loadManifest(args.env);
      const problems = preflight(loaded.manifest, { envName: args.env, signals });
      if (problems.length) {
        console.error(`Manifest ${loaded.file} cannot resolve every store (${problems.length}):`);
        for (const p of problems) console.error(`  - ${p}`);
        if (args.mode === 'evidence') {
          console.error(
            '\nRefusing an evidence baseline that could never end CLEAN. Fix the manifest, or use --mode rehearsal.',
          );
          exitCode = EXIT.REFUSED;
          return;
        }
      }
      // Resolution runs as system so a cross-tenant duplicate is DETECTED, not guessed.
      let user;
      let resolvedBy;
      if (OBJECT_ID_RE.test(args.user)) {
        user = await runAsSystem(() => models.User.findOne({ _id: args.user }).lean());
        resolvedBy = 'canonical-id';
      } else {
        try {
          user = await runAsSystem(() =>
            resolveSubject(models, args.user, args.tenant === 'none' ? undefined : args.tenant),
          );
        } catch (err) {
          if (err instanceof AmbiguousSubjectError) {
            console.error(err.message);
            exitCode = EXIT.REFUSED;
            return;
          }
          throw err;
        }
        resolvedBy = 'reference';
      }
      if (!user) {
        console.error(`No user matches "${args.user}".`);
        exitCode = EXIT.NOT_FOUND;
        return;
      }
      const mismatch = tenantMismatch(user, args.tenant);
      if (mismatch) {
        console.error(`Refusing: ${mismatch}.`);
        exitCode = EXIT.REFUSED;
        return;
      }
      const identity = buildIdentity(user, { resolvedBy, tenantAsserted: args.tenant });
      const dir = prepareOutputDir(args.out);
      deps.containers = await openContainers({
        manifest: loaded.manifest,
        env,
        getAzureContainerClient,
      });
      const local = localBackends({ env, mongoose, containers: deps.containers });
      const view = { ...identity, _id: deps.toObjectId(identity._id) };
      const inventory = await inScope(identity.tenantId, () =>
        inventorySubject({ models, view: { ...view, avatar: user.avatar }, containerName }),
      );
      const sinks = await inScope(identity.tenantId, () =>
        takeSnapshot({
          manifest: loaded.manifest,
          identity,
          inventory,
          skip: args.skip,
          deps,
          env,
          logDir: args.logDir,
        }),
      );
      const before = {
        kind: EVIDENCE_KIND,
        schemaVersion: SCHEMA_VERSION,
        phase: 'before',
        mode: args.mode,
        runId: crypto.randomUUID(),
        generatedAt: new Date().toISOString(),
        environment: args.env,
        manifest: {
          file: loaded.file,
          revision: loaded.manifest.revision,
          sha256: loaded.sha256,
          raw: loaded.raw,
        },
        tool: toolInfo(),
        identity,
        envSignals: signals,
        backends: collectBackends({ local, sinks }),
        inventory,
        sinks,
      };
      writeBundleFile(dir, 'before.json', JSON.stringify(before, null, 2));
      const gaps = baselineGaps(loaded.manifest, before);
      for (const [k, r] of Object.entries(sinks))
        console.log(`${k.padEnd(34)} ${fmtCount(r)}${r.reason ? `  (${r.reason})` : ''}`);
      if (gaps.length) {
        const fatal = args.mode === 'evidence';
        console.error(
          `\n${fatal ? 'NOT READY' : 'Rehearsal gaps'} — ${gaps.length} sink(s) have no usable baseline${fatal ? '. Do NOT delete yet' : ''}:`,
        );
        for (const g of gaps) console.error(`  - ${g.key}: ${g.reason}`);
        if (fatal) {
          console.error('Seed them (runbook §0), then take a new baseline into a fresh directory.');
          exitCode = EXIT.INCOMPLETE;
          return;
        }
      }
      console.log(`\nbefore.json written to ${dir}. Delete through the product next (runbook §2).`);
      if (args.mode !== 'evidence') exitCode = EXIT.NOT_EVIDENCE;
      return;
    }

    // after
    const { dir, before } = openEvidenceDir(args.out);
    const bound = bindingError(args, before);
    if (bound) {
      console.error(`Refusing: ${bound}.`);
      exitCode = EXIT.REFUSED;
      return;
    }
    if (sha256(before.manifest?.raw ?? '') !== before.manifest?.sha256) {
      console.error(
        'Refusing: the manifest embedded in before.json does not match its recorded digest.',
      );
      exitCode = EXIT.REFUSED;
      return;
    }
    const manifest = JSON.parse(before.manifest.raw);
    let currentManifestSha = null;
    try {
      currentManifestSha = loadManifest(before.environment).sha256;
    } catch {
      currentManifestSha = 'unreadable';
    }
    // Review round 2: refuse a different physical backend before probing anything. The
    // identities the probes learn (Langfuse project, RAG storage) are compared in
    // evaluate(); these are the ones the verifier can name from its own environment.
    deps.containers = await openContainers({ manifest, env, getAzureContainerClient });
    const local = localBackends({ env, mongoose, containers: deps.containers });
    const drift = backendMismatch(before.backends, local);
    if (drift.length) {
      console.error('Refusing: this environment is not the storage the baseline was taken on:');
      for (const d of drift) {
        console.error(
          `  - ${d.key}${d.field ? `.${d.field}` : ''}: ${stableStringify(d.before)} → ${stableStringify(d.after)}`,
        );
      }
      exitCode = EXIT.REFUSED;
      return;
    }
    const skip = before.mode === 'rehearsal' ? args.skip : [];
    const sinks = await inScope(before.identity.tenantId, () =>
      takeSnapshot({
        manifest,
        identity: before.identity,
        inventory: before.inventory,
        skip,
        deps,
        env,
        logDir: args.logDir,
        baselineSinks: before.sinks,
      }),
    );
    const after = {
      kind: EVIDENCE_KIND,
      schemaVersion: SCHEMA_VERSION,
      phase: 'after',
      mode: before.mode,
      runId: before.runId,
      generatedAt: new Date().toISOString(),
      environment: before.environment,
      tool: toolInfo(),
      envSignals: signals,
      backends: collectBackends({ local, sinks }),
      sinks,
    };
    const langfuseDelete = latestLangfuseDelete(dir);
    const evaluation = evaluate({ manifest, before, after, langfuseDelete });
    const tag = stamp(new Date(after.generatedAt));
    writeBundleFile(dir, `after-${tag}.json`, JSON.stringify({ ...after, evaluation }, null, 2));
    const report = renderReport({ before, after, evaluation, langfuseDelete, currentManifestSha });
    writeBundleFile(dir, `report-${tag}.md`, report);
    console.log(`\n${report}`);
    exitCode = exitCodeFor(evaluation.verdict);
  } finally {
    await redis?.quit().catch(() => {});
    await mongoose.disconnect();
    process.exitCode = exitCode;
  }
}

module.exports = {
  EVIDENCE_KIND,
  SCHEMA_VERSION,
  PHASES,
  MODES,
  PROBE_GROUPS,
  DISPOSITIONS,
  BASELINE_EXEMPTIONS,
  EXIT,
  BLOB_BASE_PATHS,
  LANGFUSE_DELETE_BATCH,
  LANGFUSE_SETTLE_MS,
  MAX_BASELINE_AGE_MS,
  LANGFUSE_MAX_LOOKUPS,
  RAG_ADAPTER,
  MANIFEST_DIR,
  CODE_STAGING_CONTAINER_DEFAULT,
  TRANSLATION_SCRATCH_CONTAINERS,
  probedSinkKeys,
  environmentSignals,
  parseArgs,
  validateArgs,
  parseDuration,
  isApproved,
  extractBlobPath,
  classifyPointer,
  buildLangfuseDeleteBatches,
  resolveLangfuseBaseUrl,
  buildIdentity,
  tenantMismatch,
  identityMatches,
  loadManifest,
  structuralProblems,
  entryBlocker,
  preflight,
  buildInventory,
  probeResult,
  probeMeili,
  ragScan,
  probeVectors,
  probeBlob,
  probeCodeStaging,
  probeTranslationScratch,
  resolveLangfuseProject,
  lookupLangfuseIds,
  langfuseDeleteRefusal,
  listLangfuse,
  probeLangfuse,
  deleteLangfuseTraces,
  probeRedis,
  takeSnapshot,
  stripCredentials,
  openContainers,
  localBackends,
  collectBackends,
  backendMismatch,
  baselineGaps,
  evaluate,
  exitCodeFor,
  renderReport,
  bindingError,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(EXIT.USAGE);
  });
}
// End [knauf]
