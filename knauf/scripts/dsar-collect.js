#!/usr/bin/env node
// [knauf] KK20-331 — DSAR collector: everything Agentic Karl holds about one user.
//
// READ-ONLY. It uses `.find().lean()` and `countDocuments` only, never a write. It
// exists because Art. 15 is a live obligation and the self-service export endpoint
// (P2-6) does not exist yet; without a scripted collector, an access request means
// hand-querying ~30 Mongo stores plus Meilisearch, Langfuse, Blob and the logs, and
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
 * Every Mongo store that holds data about a subject.
 *
 * PR #349 review: this list used to be justified solely by pinning it against
 * `deleteUserController`. That cannot prove completeness — the cascade is not an
 * independent schema inventory, and anything the cascade itself forgets is invisible
 * to a test that only compares the two. The spec now enumerates the live model
 * registry instead and forces every registered model into exactly one of:
 * collected here, or listed in NOT_SUBJECT_SCOPED with a reason. The cascade pin is
 * kept as a second, weaker check (erasure must not reach a store disclosure does not).
 */
const MONGO_SINKS = [
  { model: 'Message', field: 'user', note: 'incl. content[] think parts and feedback.text' },
  { model: 'Conversation', field: 'user' },
  { model: 'MemoryEntry', field: 'userId', note: 'profiling-grade' },
  { model: 'File', field: 'user', note: 'logical row; bytes are in Blob, vectors keyed by asset' },
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
  // KK20-248 project workspace — `instructions` is subject-authored free text.
  { model: 'ChatProject', field: 'user', note: 'project-level instructions (free text)' },
  { model: 'ChatProjectSource', field: 'user', note: 'project source associations + errors' },
  // KK20-195 physical ledger — authoritative for blob/vector identity and state.
  {
    model: 'KnaufFileAsset',
    field: 'scope_id',
    note: 'physical blob/vector identity, generations, indexing errors',
  },
  { model: 'SkillFile', field: 'author', note: 'subject-authored skill file content' },
  { model: 'SkillSyncStatus', field: 'owner' },
  // `principalId` is Mixed and shared by user/group/role principals, so both of
  // these pin `principalType: 'user'` — a group's id must never resolve as the
  // subject's.
  {
    model: 'Config',
    field: 'principalId',
    principalType: 'user',
    note: 'per-principal config overrides',
  },
  {
    model: 'SystemGrant',
    field: 'principalId',
    principalType: 'user',
    // The subject may see which capabilities they hold; the admin who granted
    // them is a third party (Art. 15(4)).
    redactFields: ['grantedBy'],
    note: 'capabilities held; grantedBy redacted as a third party',
  },
  { model: 'AgentApiKey', field: 'userId', existenceOnly: true },
  { model: 'PluginAuth', field: 'userId', existenceOnly: true },
  { model: 'Key', field: 'userId', existenceOnly: true },
  { model: 'Token', field: 'userId', existenceOnly: true },
  { model: 'Session', field: 'user', existenceOnly: true },
  { model: 'SkillSyncCredential', field: 'createdBy', existenceOnly: true },
  // Self-review: this was excluded with the reason "keyed by file/collection, not by
  // subject", which described a different collection entirely. The schema header says
  // "one document per allowed user (keyed by normalised email)", and `{timestamps:true}`
  // records WHEN platform access was granted — an access decision about the subject.
  // It is also the only email-keyed sink, hence `emailField`.
  {
    model: 'MigrationAllowlist',
    field: 'emailNormalized',
    emailField: true,
    note: 'platform access decision + the date it was granted',
  },
  { model: 'Group', field: 'memberIds', membership: true },
  {
    model: 'AclEntry',
    field: 'principalId',
    // Self-review: `grantedBy` here is `ObjectId, ref: 'User'` — the colleague who
    // shared the resource. The collector already redacts exactly this field on
    // SystemGrant for Art. 15(4) and shipped it raw here. Same field, same third party,
    // same rule.
    redactFields: ['grantedBy'],
    note: 'what the subject can access; grantedBy redacted as a third party',
  },
];

/**
 * Registered models that hold nothing about a subject, each with the reason it is
 * not collected. The spec asserts MONGO_SINKS ∪ NOT_SUBJECT_SCOPED covers the whole
 * live registry, so a new model cannot be added without a disclosure decision.
 */
const NOT_SUBJECT_SCOPED = {
  User: 'collected separately as users.json (the subject document itself)',
  AuditLog: 'collected separately with Art. 15(4) actor redaction (see auditlogs.json)',
  Role: 'role definitions — reference data, not per-subject',
  AccessRole: 'ACL role definitions — reference data, not per-subject',
  AgentCategory: 'marketplace taxonomy — reference data, not per-subject',
  Banner: 'global announcements — no subject scope',
  // NOTE: MigrationAllowlist is NOT here — it is one row per user, keyed by their
  // normalised email, and is collected in MONGO_SINKS.
  KnaufAuditRetentionCheckpoint: 'retention bookkeeping (hash chain), carries no subject data',
  KnaufAuditRetentionLease: 'distributed lock document, carries no subject data',
};

/**
 * Collections registered OUTSIDE `createModels()` — the registry sweep above cannot
 * see these, so they are enumerated by hand and pinned by their own spec check.
 *
 * PR #349 review (round 2): `knauf_translation_jobs` is registered lazily inside
 * `api/server/services/Files/knauf/translation/jobs.js`, never through `createModels`,
 * so the registry test reported full coverage while a store holding the subject's
 * filenames, locales, protected terms, job reports and error detail went uncollected.
 * A "complete" inventory that can only see one registration mechanism is not complete;
 * the spec now greps the tree for `collection: '<name>'` declarations and fails on any
 * that appear in neither MONGO_SINKS, RAW_COLLECTIONS nor NOT_SUBJECT_SCOPED_RAW.
 */
const RAW_COLLECTIONS = [
  // Purged per user by api/knauf/scheduler/userLifecycle.js.
  { collection: 'knauf_agent_schedules', field: 'user' },
  { collection: 'knauf_scheduled_agent_runs', field: 'ownerId' },
  // KK20-297 File Translation. Tenant-scoped; redactions reviewed below.
  {
    collection: 'knauf_translation_jobs',
    field: 'user',
    tenantField: 'tenantId',
    redactFields: ['lease_owner', 'execution_token', 'idempotency_key', 'request_key'],
    note: 'filenames, locales, preserve_terms, report, last_error_detail — all subject data',
  },
];

/**
 * Raw collections that hold nothing about a subject, with the reason. Same contract as
 * NOT_SUBJECT_SCOPED but for hand-registered / non-`createModels` collections.
 */
const NOT_SUBJECT_SCOPED_RAW = {
  // keyv cache namespaces (packages/api/src/cache/keyvMongo.ts). Opaque cache keys with
  // TTL expiry and no subject-scoped field, so they cannot be queried per subject.
  // Transient and derived: anything user-linked here also exists in a primary store
  // that IS collected. Say so if asked; do not claim the cache holds nothing.
  keyv: 'keyv cache namespace — opaque keys, TTL-bounded, no subject field to filter on',
  logs: 'keyv cache namespace (the instantiated store) — same as `keyv`',
  // Reached raw in places, but the SAME collections as model sinks above — the raw
  // access path is an implementation detail, not a second store.
  conversations: 'collected as the Conversation model sink',
  sharedlinks: 'collected as the SharedLink model sink',
  prompts: 'collected as the Prompt model sink',
  // Legacy GLOBAL sharing registry: one row per project name holding agentIds/promptIds
  // that are shared platform-wide. Not per-subject; an agent the subject authored is
  // disclosed through their own Agent row, along with its sharing state.
  projects: 'global sharing registry keyed by project name, not by subject',
  knauf_file_indexing_locks: 'distributed reconciler lease (ownerId = host/pid), no subject data',
  knauf_file_indexing_locks_test: 'test fixture for the lease above',
  __transaction_test__: 'transaction-support probe; never written to',
  knauf_file_assets: 'collected as the KnaufFileAsset model sink (user + agent scope)',
  knauf_audit_retention_checkpoints: 'retention bookkeeping (hash chain), no subject data',
  knauf_audit_retention_leases: 'distributed lock documents, no subject data',
  auditlogs: 'collected separately with Art. 15(4) actor + context redaction',
};

/**
 * Every external sink that must be executed and reconciled before a bundle is
 * releasable. PR #349 review (round 2): the collector emitted Langfuse/Meilisearch
 * recipes and left Blob, RAG and the log platform to the runbook, then exited 0 —
 * so "the script succeeded" said nothing about whether those sinks had run. Each is
 * now PENDING by construction and only `--finalize` can clear it, by ingesting a
 * machine-readable result and verifying its totals.
 */
const EXTERNAL_SINKS = [
  {
    key: 'langfuse',
    label: 'Langfuse traces + scores',
    resultFile: 'results/langfuse.json',
    runbook: '§1.6 — run langfuse.sh where the CLI has credentials',
    notApplicableWhen: (m) =>
      m.environment?.langfuseEnabled === false ? 'Langfuse is not configured' : null,
  },
  {
    key: 'meilisearch',
    label: 'Meilisearch messages + convos',
    resultFile: 'results/meilisearch.json',
    runbook: '§1.2 — run the paged recipe in meilisearch.md',
    // Machine-checkable: no search backend configured, or nothing indexable to find.
    notApplicableWhen: (m) => {
      if (m.environment?.searchEnabled === false) {
        return 'no search backend configured (MEILI_HOST unset)';
      }
      if (derivedExpectedTotals(m).meilisearch === 0) {
        return 'phase one found no indexable messages or conversations';
      }
      return null;
    },
  },
  {
    key: 'blob',
    label: 'Azure Blob objects',
    resultFile: 'results/blob.json',
    runbook: '§1.5 — pull the objects listed in blob-objects.json',
    notApplicableWhen: (m) =>
      derivedExpectedTotals(m).blob === 0 ? 'phase one enumerated no blob objects' : null,
  },
  {
    key: 'ragVectors',
    label: 'RAG vector inventory confirmation',
    resultFile: 'results/rag-vectors.json',
    runbook: '§1.3/1.4 — send vector-inventory-request.json to the RAG service',
    notApplicableWhen: (m) =>
      derivedExpectedTotals(m).ragVectors === 0 ? 'phase one emitted no vector ids' : null,
  },
  {
    // No machine-checkable not-applicable condition exists: "the platform cannot query
    // by userId" is a human claim about an external system. Round-4 review: an
    // INACCESSIBLE sink must stay incomplete, so this one can only reach `limitation`,
    // which is recorded, distinguishable from `pending`, and still blocks completeness.
    key: 'logPlatform',
    label: 'Server logs / APM export',
    resultFile: 'results/log-platform.json',
    runbook: '§1.10 — owner-approved bounded export, or a recorded limitation',
  },
  // Self-review: when USE_REDIS is on, the keyv namespaces this collector dismissed as
  // Mongo collections actually live in Redis, alongside resumable-stream job state and
  // abuse/violation counters keyed by user id. The script has no Redis client and must
  // not pretend otherwise — so it is a tracked external sink that starts pending, and a
  // deployment that does not use Redis clears it with `not-applicable` + a note.
  {
    key: 'redis',
    label: 'Redis — stream jobs, violation counters, sessions',
    resultFile: 'results/redis.json',
    runbook: '§1.11 — scan by subject id, or record not-applicable when USE_REDIS is off',
    notApplicableWhen: (m) =>
      m.environment?.redisEnabled === false ? 'USE_REDIS is off in this environment' : null,
  },
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

/**
 * Group fields safe to disclose. `memberIds` is deliberately absent: it is the list of
 * every OTHER member's identifier, and Art. 15(4) bars disclosing it to satisfy this
 * subject's request (PR #349 review).
 */
const GROUP_SUBJECT_FIELDS = [
  '_id',
  'name',
  'description',
  'source',
  'idOnTheSource',
  'tenantId',
  'createdAt',
  'updatedAt',
];

/**
 * Actor-side forensic fields on an audit row (`buildAuditContext`). Every one of them
 * describes the ADMIN who acted, not the subject, so none may survive on a target-only
 * row. Listed explicitly so the spec can assert each is absent from the serialized bundle.
 */
const AUDIT_ACTOR_CONTEXT_FIELDS = ['ip', 'userAgent', 'sessionId', 'requestId'];

const AUDIT_CONTEXT_REDACTED = '[redacted — third-party request context, Art. 15(4)]';

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
 * The identifier the application actually stores in `Group.memberIds`.
 * `userGroup.js` writes `user.idOnTheSource || userId.toString()`, so an
 * OIDC/Entra-sourced subject is a member under their external id, never their Mongo
 * `_id`. Querying by `_id` alone silently returns zero groups for exactly the users
 * who have them (PR #349 review).
 */
function groupMembershipKeys(subject) {
  const keys = [String(subject._id)];
  if (subject.idOnTheSource && !keys.includes(subject.idOnTheSource)) {
    keys.unshift(subject.idOnTheSource);
  }
  return keys;
}

/**
 * Art. 15(4): the subject may learn which groups they belong to, not who else is in
 * them. Project to non-identifying group metadata and record which key matched.
 */
function toSubjectGroupView(group, membershipKeys) {
  const out = {};
  for (const k of GROUP_SUBJECT_FIELDS) if (group[k] !== undefined) out[k] = group[k];
  const members = Array.isArray(group.memberIds) ? group.memberIds.map(String) : [];
  out._dsarMembershipKey = membershipKeys.find((k) => members.includes(k)) ?? null;
  out._dsarMemberCount = members.length;
  out._dsarNote = 'memberIds withheld — other members are third parties (Art. 15(4))';
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
    const out = {
      ...row,
      _dsarRole: 'target',
      actor: { type: row.actor?.type, name: '[redacted — third party, Art. 15(4)]' },
    };
    // PR #349 review (round 2): `context` is built by `buildAuditContext(req)` from
    // the ACTING ADMIN's request — their IP, user agent, session and correlation id.
    // Blanking `actor.name` while shipping `context.ip` still identifies and
    // correlates the third party, so the whole context goes on target-only rows.
    // Kept as an explicit marker rather than deleted, so the subject can see that
    // forensic context exists and was withheld, not that none was recorded.
    if (row.context !== undefined) {
      out.context = AUDIT_CONTEXT_REDACTED;
    }
    return out;
  });
}

/* ------------------------------------------------------ external-sink commands */

const LANGFUSE_PAGE_SIZE = 100;
/** Refuse to loop forever if the API keeps reporting more pages. */
const MAX_PAGES = 10000;

/**
 * Langfuse userId IS the Mongo user id (pinned by KK20-327's identity assertion).
 *
 * PR #349 review: the previous version emitted `for p in 1..10`, which silently
 * stopped at 1,000 traces / 500 scores — a large account would export a truncated
 * bundle and the script would still exit 0. The Langfuse API returns
 * `meta.totalItems` / `meta.totalPages` on every paginated response, so the emitted
 * script now pages until the API reports exhaustion, reconciles the number of rows it
 * actually wrote against `totalItems`, and **exits non-zero** when they disagree.
 * A DSAR bundle must never be silently short.
 */
function buildLangfuseCommands(subjectId) {
  const id = String(subjectId);
  return `#!/usr/bin/env bash
# [knauf] KK20-331 — Langfuse collection for DSAR subject ${id}.
# Run where the Langfuse CLI has credentials (see package.json langfuse:* scripts).
# Exits non-zero if completeness cannot be established — do not release a bundle
# produced by a failed run.
set -euo pipefail

SUBJECT="${id}"
LIMIT=${LANGFUSE_PAGE_SIZE}
MAX_PAGES=${MAX_PAGES}
RETRIES="\${LANGFUSE_RETRIES:-3}"
TIMEOUT="\${LANGFUSE_TIMEOUT:-120}"

# One bounded, retried CLI call. Fails the script when every attempt fails.
lf() {
  local out="$1"; shift
  local attempt=1
  until timeout "$TIMEOUT" npx langfuse "$@" --json > "$out"; do
    if [ "$attempt" -ge "$RETRIES" ]; then
      echo "FAIL: langfuse $* did not succeed after $RETRIES attempts" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep $((attempt * 2))
  done
}

# Pages <resource> until meta.totalPages is reached, then reconciles the row count
# against meta.totalItems. Any mismatch is a hard failure.
collect() {
  local resource="$1"; shift
  local page=1 total_pages=1 total_items=0 seen=0

  while [ "$page" -le "$total_pages" ] && [ "$page" -le "$MAX_PAGES" ]; do
    lf "langfuse-\${resource}-p\${page}.json" api "$@" \\
      --user-id "$SUBJECT" --limit "$LIMIT" --page "$page"

    # The ? guards matter: a jq ERROR (indexing an array with a string) is not
    # caught by the // operator, and the CLI may return the API body bare or
    # wrapped in {ok,status,data}. Both shapes must parse, or the loop dies
    # mid-collection and the run reports nothing rather than failing loudly.
    total_pages=$(jq -r '(.data.meta? // .meta? // {}) | .totalPages // 1' "langfuse-\${resource}-p\${page}.json")
    total_items=$(jq -r '(.data.meta? // .meta? // {}) | .totalItems // 0' "langfuse-\${resource}-p\${page}.json")
    seen=$((seen + $(jq -r '(.data.data? // .data? // []) | length' "langfuse-\${resource}-p\${page}.json")))
    page=$((page + 1))
  done

  if [ "$page" -gt "$MAX_PAGES" ]; then
    echo "FAIL: \${resource} exceeded MAX_PAGES=\${MAX_PAGES}; completeness not established" >&2
    return 1
  fi
  if [ "$seen" -ne "$total_items" ]; then
    echo "FAIL: \${resource} collected $seen rows but API reports $total_items" >&2
    return 1
  fi
  echo "OK: \${resource} — $seen/$total_items rows across $((page - 1)) page(s)"
}

# Traces carry prompts, completions, reasoning and tool outputs (in observations).
collect traces traces list --fields core,io,observations
# Feedback scores. Scores created before KK20-327 may carry free-text comments —
# review before release.
collect scores scores list --fields score,trace

echo "Langfuse collection complete for \${SUBJECT}."
`;
}

/**
 * PR #349 review: `{"limit": 1000}` returns one page and Meilisearch reports only
 * `estimatedTotalHits` for offset/limit queries. Using `page`/`hitsPerPage` instead
 * returns an exact `totalHits` and `totalPages`, so the emitted recipe can page to
 * exhaustion and prove it collected everything.
 *
 * `user` is the only filterable attribute on both indexes (api/db/indexSync.js), which
 * is exactly what a DSAR needs.
 */
function buildMeilisearchQueries(subjectId) {
  const id = String(subjectId);
  return `# [knauf] KK20-331 — Meilisearch collection for DSAR subject ${id}.
#
# These are DERIVED copies of Mongo messages/conversations: attest counts, do not
# double-disclose. \`user\` is the only filterable attribute on either index.
#
# Use page/hitsPerPage (NOT offset/limit): it returns an exact \`totalHits\` and
# \`totalPages\`, so completeness is provable. offset/limit only ever reports
# \`estimatedTotalHits\`, and a single 1,000-hit page silently truncates a heavy user.

POST /indexes/messages/search  {"filter": "user = ${id}", "hitsPerPage": 1000, "page": 1}
POST /indexes/convos/search    {"filter": "user = ${id}", "hitsPerPage": 1000, "page": 1}

# Page until \`page\` > \`totalPages\`, then check the rows you wrote against
# \`totalHits\`. Scripted equivalent (jq + curl), fails closed on any mismatch:

    set -euo pipefail
    collect() {  # collect <index> <outfile-prefix>
      local idx="$1" out="$2" page=1 total_pages=1 total_hits=0 seen=0
      while [ "$page" -le "$total_pages" ]; do
        curl -fsS --max-time 120 -X POST "\${MEILI_HOST}/indexes/\${idx}/search" \\
          -H "Authorization: Bearer \${MEILI_MASTER_KEY}" -H 'Content-Type: application/json' \\
          -d "{\\"filter\\":\\"user = ${id}\\",\\"hitsPerPage\\":1000,\\"page\\":\${page}}" \\
          > "\${out}-p\${page}.json"
        total_pages=$(jq -r '.totalPages' "\${out}-p\${page}.json")
        total_hits=$(jq -r '.totalHits' "\${out}-p\${page}.json")
        seen=$((seen + $(jq -r '.hits | length' "\${out}-p\${page}.json")))
        page=$((page + 1))
      done
      [ "$seen" -eq "$total_hits" ] || { echo "FAIL: \${idx} $seen != $total_hits" >&2; return 1; }
      echo "OK: \${idx} — $seen/$total_hits"
    }
    collect messages meili-messages
    collect convos   meili-convos
`;
}

/* ------------------------------------------------------------- vector identity */

/**
 * Physical vector state for the subject's files.
 *
 * PR #349 review: the previous version split files by `context === 'agents'` and
 * reported the logical `file_id`. Both are wrong as of KK20-195/KK20-204:
 *
 *  - the physical vector id is `knauf_asset_id ?? file_id` — see
 *    `VectorDB/crud.js` (`deleteVectorsForFiles`, `deleteVectors`), which routes on
 *    exactly that value. A deduplicated or re-indexed file's vectors do not live
 *    under its logical `file_id` at all;
 *  - the backend is recorded on the asset as `vector_backend`, not inferred from
 *    `context`. The context heuristic also ignores `isAzureSearchEnabledForAgents()`,
 *    so with Azure Search disabled it attests Azure for files that are in pgvector;
 *  - `active_generation` / `stale_generations` decide which vectors are actually
 *    live, and stale generations are cleanup debt that may still hold embeddings.
 *
 * So: join File rows to their KnaufFileAsset and report the asset's own state.
 * Files with no asset row (pre-KK20-195 legacy) fall back to the old heuristic and
 * are marked `unverified: true` so the reviewer can see the attestation is weaker
 * for them rather than being told a guess is a fact.
 */
function classifyVectorStores(files, assets = []) {
  const byAssetId = new Map(assets.map((a) => [String(a.asset_id), a]));
  const entries = files
    .filter((f) => f.embedded === true || f.knauf_asset_id)
    .map((f) => {
      const asset = f.knauf_asset_id ? byAssetId.get(String(f.knauf_asset_id)) : undefined;
      const vectorId = f.knauf_asset_id ?? f.file_id;
      if (!asset) {
        return {
          file_id: f.file_id,
          vectorId,
          backend: f.context === 'agents' ? 'azure_search' : 'pgvector',
          unverified: true,
          note: 'no FileAsset row — backend inferred from context; confirm with the RAG service',
        };
      }
      return {
        file_id: f.file_id,
        vectorId,
        backend: asset.vector_backend,
        status: asset.status,
        activeGeneration: asset.active_generation ?? null,
        staleGenerations: asset.stale_generations ?? [],
        lastErrorCode: asset.last_error_code ?? null,
        unverified: false,
      };
    });

  const byBackend = (name) => entries.filter((e) => e.backend === name);
  return {
    entries,
    azureAiSearch: byBackend('azure_search').map((e) => e.vectorId),
    pgvector: byBackend('pgvector').map((e) => e.vectorId),
    unverified: entries.filter((e) => e.unverified).map((e) => e.vectorId),
    staleGenerationDebt: entries
      .filter((e) => (e.staleGenerations ?? []).length > 0)
      .map((e) => ({ vectorId: e.vectorId, staleGenerations: e.staleGenerations })),
  };
}

/**
 * Neither pgvector nor Azure AI Search exposes a by-subject read-back path, so the
 * bundle cannot enumerate stored chunks itself. It can, however, hand the RAG service
 * an exact, tenant-scoped list of physical ids to confirm against — which is what
 * Art. 15 needs and what an attestation built on the wrong id could not give.
 */
function buildVectorInventoryRequest(subjectId, tenantId, vectors) {
  return {
    subject: String(subjectId),
    tenantId: tenantId ?? null,
    askTheRagService:
      'Confirm, per id below, which chunks exist under this tenant and return their count. ' +
      'Ids are physical vector ids (knauf_asset_id where present, else the legacy file_id).',
    pgvector: vectors.pgvector,
    azureAiSearch: vectors.azureAiSearch,
    unverifiedBackend: vectors.unverified,
    staleGenerationDebt: vectors.staleGenerationDebt,
  };
}

/** Tells the operator exactly what each external sink must drop into results/. */
function buildResultsReadme(binding = {}) {
  const RUN_ID = binding.runId ?? '<runId from manifest.json>';
  const SUBJECT_ID = binding.subject ?? '<subject._id from manifest.json>';
  const TENANT_JSON = JSON.stringify(binding.tenant ?? null);
  const rows = EXTERNAL_SINKS.map(
    (e) => `| \`${e.key}\` | ${e.label} | \`${e.resultFile}\` | ${e.runbook} |`,
  ).join('\n');
  return `# External sink results — REQUIRED before this bundle is releasable

The collector cannot execute these sinks itself, so it records them as **pending** and
refuses to report a complete bundle until each has a VERIFIED result here.

| Key | Sink | Drop the result at | Runbook |
|---|---|---|---|
${rows}

Each file is JSON, **bound to this bundle**, and must name the artifact it produced:

\`\`\`json
{
  "runId": "${RUN_ID}",
  "sink": "langfuse",
  "subject": "${SUBJECT_ID}",
  "tenant": ${TENANT_JSON},
  "status": "complete",
  "artifact": "results/langfuse-traces.jsonl",
  "checksum": "<sha256 of that file>"
}
\`\`\`

\`runId\`, \`sink\`, \`subject\` and \`tenant\` must match this bundle exactly — that is what
stops a result being copied from another bundle or replayed from an earlier run against a
stale inventory. The values above are already filled in for you.

**Two independent checks run, and both must pass.**

1. **The artifact is hashed.** \`artifact\` must be a real file inside this bundle (no
   symlinks, no paths escaping it) and its sha256 must equal \`checksum\`. A number with
   no file behind it is not evidence. Generate it with:
   \`sha256sum results/<file>\`

2. **The count is checked against OUR number, not yours.** For \`meilisearch\`, \`blob\` and
   \`ragVectors\` the collector derives the expected total from phase one's own counts
   (Mongo messages+convos, enumerated blob keys, emitted vector ids) and **ignores any
   \`expected\` you supply** — \`collected\` must match what the collector computed.
   \`langfuse\`, \`logPlatform\` and \`redis\` are not derived from Mongo, so no such
   expectation exists. A \`complete\` result for them is still hashed, parsed and bound to
   this run, but it is recorded as **\`manual-verification-required\`** — never
   \`complete\` — with \`expectationSource: "artifact-parsed, total unverified"\`. That
   status **keeps the bundle incomplete**: this tool cannot promote it; a service-specific
   adapter or an approved attestation must (runbook §2.1).

**The count comes from the artifact, not from you.** The collector parses the file
(JSONL, a JSON array, or an envelope with \`data\`/\`hits\`/\`results\`/\`items\`) and counts the
records itself. If you also send \`collected\` it must agree, and if the file is in neither
shape the sink **fails** — export in one of them so the count is evidence rather than a claim.

\`status: "not-applicable"\` is accepted **only where the collector can check the condition
itself** — Redis off, no search backend, Langfuse unconfigured, or phase one having found
nothing to export. Anywhere else it is downgraded to \`limitation\`.

\`status: "limitation"\` records a sink that could not be answered (e.g. the log platform
cannot query by \`userId\`). It **keeps the bundle incomplete** — an inaccessible sink is an
unanswered sink — and the note must appear in the Art. 15 response.

Anything else — missing file, unreadable JSON, a symlinked or foreign-owned file, checksum
mismatch, count mismatch, binding mismatch — keeps the bundle incomplete.

Then reconcile (no database needed):

\`\`\`bash
node knauf/scripts/dsar-collect.js --out <this-bundle-dir> --finalize
\`\`\`

That is the only run that can set \`manifest.completeness.ok = true\`. It rewrites
\`manifest.json\` atomically and touches nothing else. While any sink is
\`manual-verification-required\` or \`limitation\` it will not: the log platform has no
machine-checkable exemption, so in this version a bundle with the log platform in scope
always finishes with exit 4 and an explicit list of what remains.
`;
}

/* --------------------------------------------------------------- safe output dir */

/**
 * Refuse a symlink anywhere in `target`'s path, from `stopAt` (exclusive) downwards —
 * or from the filesystem root when `stopAt` is omitted.
 *
 * PR #349 review (round 4): this walk existed in `assertSecureExistingDir`, was added to
 * `verifyBundleArtifact` during self-review, and was STILL missing from
 * `prepareOutputDir` — the one that writes the entire corpus. Three hand-written copies
 * of the same check, two of them right. It is one function now, because the recurrence
 * was the real defect.
 *
 * Note the limit: this is lstat-then-use, so it is not TOCTOU-proof against an attacker
 * who can race the filesystem. The bundle must live where only the operator can write.
 */
function assertNoSymlinkInPath(target, stopAt) {
  const resolved = path.resolve(target);
  let cursor;
  let rest;
  if (stopAt) {
    cursor = path.resolve(stopAt);
    rest = path.relative(cursor, resolved);
    if (rest.startsWith('..')) {
      throw new Error(`Path escapes its root: ${target}`);
    }
  } else {
    cursor = path.parse(resolved).root;
    rest = resolved.slice(cursor.length);
  }
  for (const part of rest.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = fs.lstatSync(cursor);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Everything below here does not exist yet; nothing left to follow.
        return resolved;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to use a path that passes through a symlink: ${cursor}`);
    }
  }
  return resolved;
}

/**
 * Read a JSON file the bundle depends on, with no-follow semantics and an ownership /
 * permission check.
 *
 * PR #349 review (round 4): finalization opened `manifest.json` and every result file by
 * pathname, so a symlinked FILE inside an otherwise-validated directory was followed, and
 * a result written by shell redirection stayed world-readable at 0644 while the bundle was
 * declared releasable. Every consumed file is now checked before it can influence
 * completeness.
 */
function readSecureJson(file, { bundleDir, required = false } = {}) {
  assertNoSymlinkInPath(file, bundleDir);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (required) throw new Error(`Required bundle file is missing: ${file}`);
      return null;
    }
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to read a symlinked bundle file: ${file}`);
  }
  if (!st.isFile()) {
    throw new Error(`Bundle file is not a regular file: ${file}`);
  }
  if (st.uid !== process.getuid?.()) {
    throw new Error(
      `Bundle file is not owned by the operator running this script: ${file} ` +
        `(owner uid ${st.uid}, expected ${process.getuid?.()})`,
    );
  }
  // Tighten rather than reject: a result produced by `… > results/x.json` inherits the
  // umask, and failing the whole run for that would push operators toward workarounds.
  // Recorded on the manifest so the tightening is visible, not silent.
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    fs.chmodSync(file, 0o600);
  }
  return {
    data: JSON.parse(fs.readFileSync(file, 'utf8')),
    tightenedFrom: mode === 0o600 ? null : mode,
  };
}

/**
 * PR #349 review (round 2): the bundle is the subject's entire personal-data corpus,
 * and the old code did `fs.mkdirSync(out, { recursive: true })` — which accepts an
 * existing directory or a symlink, leaves unrelated files in place, writes predictable
 * filenames under the ambient umask, and made `langfuse.sh` world-readable at 0755.
 *
 * Round 4: it also checked only the FINAL component, so with a symlinked parent and a
 * non-existent leaf, `mkdirSync({recursive:true})` followed the link and wrote the whole
 * corpus into the linked location. Reproduced before fixing. Now the full ancestry is
 * validated first.
 */
function prepareOutputDir(out) {
  const resolved = assertNoSymlinkInPath(out);
  let st = null;
  try {
    st = fs.lstatSync(resolved);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (st) {
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to write a DSAR bundle into a symlink: ${resolved}. ` +
          "The link target is not under this script's control.",
      );
    }
    if (!st.isDirectory()) {
      throw new Error(`--out exists and is not a directory: ${resolved}`);
    }
    if (fs.readdirSync(resolved).length > 0) {
      throw new Error(
        `Refusing to write into a non-empty directory: ${resolved}. ` +
          "Stale files from an earlier run would be indistinguishable from this one's " +
          'output. Use a fresh path.',
      );
    }
    fs.chmodSync(resolved, 0o700);
    return resolved;
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  // mkdir honours the umask, so set the mode explicitly afterwards.
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

/** Write one bundle file 0600, exclusively — never clobber, never inherit the umask. */
function writeBundleFile(dir, name, contents) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(target, 0o600);
  return target;
}

/* ------------------------------------------------------- external-sink finalization */

/** Every external sink starts PENDING; nothing but a verified result clears it. */
function initialExternalSinkState() {
  const state = {};
  for (const sink of EXTERNAL_SINKS) {
    state[sink.key] = {
      status: 'pending',
      label: sink.label,
      expects: sink.resultFile,
      runbook: sink.runbook,
    };
  }
  return state;
}

/**
 * Totals the collector derives ITSELF from phase one, per sink.
 *
 * PR #349 review (round 3): `collected` and `expected` both came out of the same
 * operator-written JSON, so `1 === 1` proved only that someone typed two equal numbers.
 * Where a sink is a DERIVED COPY of something already counted in Mongo, the expectation
 * is ours to compute and the operator's number must match OURS:
 *
 *  - Meilisearch indexes `messages` + `convos`, so it mirrors those Mongo counts;
 *  - Blob holds one object per file key phase one enumerated;
 *  - the RAG inventory is exactly the physical vector ids phase one emitted.
 *
 * Langfuse and the log platform are NOT derived from Mongo — they have their own
 * retention regimes, so no honest expectation can be computed for them. Those can never
 * reach `complete` here: they stop at `manual-verification-required` and the manifest
 * says why (`expectationSource`), rather than implying a verification that did not
 * happen. They must still ship a checksummed artifact, so the number is at least bound
 * to a real file.
 */
function derivedExpectedTotals(manifest) {
  const sinks = manifest?.sinks ?? {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const vectors = sinks.vectorStores ?? {};
  // Self-review: deriving Meilisearch from the RAW Message/Conversation counts was
  // wrong and would have REJECTED a correct export. `mongoMeili.isIndexableDocument`
  // deliberately keeps temporary/expiring chats out of the index
  // (`isTemporary === false && hasActiveExpiration`), so the replica is legitimately
  // SMALLER than Mongo whenever the subject used Temporary Chat — which is on by
  // default. A gate that fails valid work is worse than no gate: the operator could
  // never clear the sink and the bundle would be permanently unreleasable.
  //
  // Phase one now counts the indexable subset separately (`*Indexable`) using the same
  // predicate the indexer uses, and that is what Meilisearch is measured against.
  // Older bundles without those counts get `undefined` — no derived expectation, so the
  // sink stops at `manual-verification-required` rather than being rejected on a stale
  // number (or, worse, trusted).
  const indexable =
    sinks.MessageIndexable === undefined && sinks.ConversationIndexable === undefined
      ? undefined
      : num(sinks.MessageIndexable) + num(sinks.ConversationIndexable);
  return {
    meilisearch: indexable,
    // Blob covers File rows, FileAsset blobs AND avatars (which have no File row).
    blob: num(sinks.blob?.objects),
    ragVectors: num(vectors.pgvector) + num(vectors.azureAiSearch),
  };
}

/**
 * Decide whether one external sink counts as executed AND reconciled.
 *
 * A result must (a) name an artifact whose sha256 matches its declared checksum, and
 * (b) report a `collected` total equal to the collector's own derived expectation where
 * one exists. An operator-supplied `expected` is IGNORED whenever we can compute it.
 * Where no expectation can be derived at all, `complete` is unreachable: the sink stops
 * at `manual-verification-required` (round-5 review).
 */
function reconcileExternalResult(sinkKey, raw, opts = {}) {
  const { derivedExpected, verifyArtifact, bundleDir, manifest } = opts;
  const sink = EXTERNAL_SINKS.find((e) => e.key === sinkKey);
  const base = { label: sink?.label ?? sinkKey, expects: sink?.resultFile, runbook: sink?.runbook };
  const hasDerived = Number.isFinite(derivedExpected);

  if (raw == null) {
    return { ...base, status: 'pending', reason: 'no result file found' };
  }

  // --- binding: this evidence must belong to THIS run, sink, subject and tenant -------
  // Round-4 review: without it a result file could be copied between bundles, reused
  // from an earlier run against a stale inventory, or filed under the wrong sink.
  if (manifest) {
    const expectBinding = {
      runId: manifest.runId,
      sink: sinkKey,
      subject: manifest.subject?._id,
      tenant: manifest.tenant?.resolved ?? null,
    };
    for (const [field, expected] of Object.entries(expectBinding)) {
      if (expected === undefined) continue;
      const actual = raw[field] ?? null;
      if (String(actual) !== String(expected)) {
        return {
          ...base,
          status: 'failed',
          reason: `binding mismatch on \`${field}\`: result says ${JSON.stringify(actual)}, this bundle is ${JSON.stringify(expected)}`,
        };
      }
    }
  }

  // --- not-applicable: only where the condition is machine-checkable -----------------
  if (raw.status === 'not-applicable') {
    if (!raw.note) {
      return { ...base, status: 'failed', reason: 'not-applicable requires a written note' };
    }
    const condition = sink?.notApplicableWhen?.(manifest ?? {}) ?? null;
    if (!condition) {
      return {
        ...base,
        status: 'limitation',
        note: raw.note,
        reason:
          'not-applicable is not independently verifiable for this sink — recorded as a ' +
          'LIMITATION. The bundle stays incomplete and the note must appear in the Art. 15 response.',
      };
    }
    return { ...base, status: 'not-applicable', note: raw.note, verifiedCondition: condition };
  }

  if (raw.status === 'limitation') {
    if (!raw.note) {
      return { ...base, status: 'failed', reason: 'limitation requires a written note' };
    }
    return {
      ...base,
      status: 'limitation',
      note: raw.note,
      reason: 'recorded limitation — the bundle is incomplete and the response must say so',
    };
  }

  if (raw.status !== 'complete') {
    return { ...base, status: 'failed', reason: raw.reason ?? `status=${raw.status ?? 'missing'}` };
  }

  // --- the artifact must exist, hash as declared, and be PARSED for its own count ----
  if (!raw.artifact || !raw.checksum) {
    return {
      ...base,
      status: 'failed',
      reason: 'complete requires `artifact` (path within the bundle) and `checksum` (sha256)',
    };
  }
  let probe;
  if (typeof verifyArtifact === 'function') {
    try {
      probe = verifyArtifact(raw.artifact, bundleDir);
    } catch (err) {
      return { ...base, status: 'failed', reason: `artifact unreadable: ${err.message}` };
    }
    if (probe.checksum !== raw.checksum) {
      return {
        ...base,
        status: 'failed',
        reason: `checksum mismatch for ${raw.artifact}: declared ${raw.checksum}, actual ${probe.checksum}`,
      };
    }
    if (probe.records === null) {
      return {
        ...base,
        status: 'failed',
        reason:
          `cannot derive a record count from ${raw.artifact} — it is neither JSONL nor a ` +
          'JSON array/envelope. Export in one of those so the count is evidence, not a claim.',
      };
    }
  }

  // The count that matters is the one WE parsed out of the bytes.
  const observed = probe ? probe.records : Number(raw.collected);
  if (!Number.isFinite(observed)) {
    return { ...base, status: 'failed', reason: 'could not establish a record count' };
  }
  if (raw.collected !== undefined && Number(raw.collected) !== observed) {
    return {
      ...base,
      status: 'failed',
      reason: `result declares ${raw.collected} records but ${raw.artifact} contains ${observed}`,
    };
  }

  const shared = {
    ...base,
    collected: observed,
    countSource: probe ? 'parsed-from-artifact' : 'declared',
    artifact: raw.artifact,
    checksum: raw.checksum,
    ...(probe?.tightenedFrom ? { permissionsTightenedFrom: probe.tightenedFrom } : {}),
  };

  if (hasDerived) {
    if (observed !== derivedExpected) {
      return {
        ...shared,
        status: 'failed',
        reason:
          `artifact contains ${observed} records but phase one derived ${derivedExpected} — ` +
          'the extraction is short, or the bundle and the export disagree',
      };
    }
    return {
      ...shared,
      status: 'complete',
      expected: derivedExpected,
      expectationSource: 'derived-from-phase-one',
    };
  }

  // No Mongo-derived expectation exists for this sink. The count is parsed out of a
  // hashed artifact bound to this run, but nothing independent corroborates the TOTAL.
  // PR #349 review (round 5): a sink in that state must NOT become `complete` — that is
  // the status that lets the bundle print "releasable", and an uncorroborated total is
  // not a verified export. It stops at `manual-verification-required`: the evidence is
  // kept (count, artifact, checksum) so a reviewer can weigh it, but the bundle stays
  // incomplete. Promotion to `complete` needs a service-specific adapter that derives the
  // expectation from the service itself, or an approved attestation — neither ships here.
  return {
    ...shared,
    status: 'manual-verification-required',
    expected: null,
    expectationSource:
      'artifact-parsed, total unverified (no independent expectation exists for this sink)',
    reason:
      'the artifact is hashed and its record count parsed, but no independent total ' +
      'corroborates it — a service-specific adapter or an approved attestation must ' +
      'promote this sink before the bundle can be released',
  };
}

/**
 * Fold external-sink results into an EXISTING phase-one manifest. Expectations come
 * from that manifest's own counts, so finalization measures the export against what
 * phase one actually found — not against a number living in the same file as the claim.
 */
function finalizeManifest(manifest, out, readJson, opts = {}) {
  const external = manifest.externalSinks ?? initialExternalSinkState();
  const derived = derivedExpectedTotals(manifest);
  for (const sink of EXTERNAL_SINKS) {
    let raw = null;
    try {
      raw = readJson(path.join(out, sink.resultFile));
    } catch (err) {
      external[sink.key] = {
        label: sink.label,
        expects: sink.resultFile,
        runbook: sink.runbook,
        status: 'failed',
        reason: `unreadable result file: ${err.message}`,
      };
      continue;
    }
    external[sink.key] = reconcileExternalResult(sink.key, raw, {
      derivedExpected: derived[sink.key],
      verifyArtifact: opts.verifyArtifact,
      bundleDir: out,
      manifest,
    });
  }
  manifest.externalSinks = external;
  manifest.derivedExpectations = derived;

  // `limitation` is deliberately NOT releasable: an inaccessible sink is an unanswered
  // sink, however well documented (round-4 review). It is distinguished from `pending`
  // so the operator can see it was addressed and could not be satisfied.
  // `manual-verification-required` is not releasable either (round-5 review): the export
  // ran and its artifact is bound to this run, but nothing independent corroborates the
  // total, so only a service adapter or an approved attestation may promote it.
  const unresolved = Object.entries(external).filter(
    ([, v]) => v.status !== 'complete' && v.status !== 'not-applicable',
  );
  manifest.completeness.warnings = manifest.completeness.warnings.filter(
    (w) => !w.startsWith('externalSinks:'),
  );
  for (const [key, v] of unresolved) {
    manifest.completeness.warnings.push(
      `externalSinks: ${key} is ${v.status}${v.reason ? ` (${v.reason})` : ''} — ${v.runbook ?? v.expects}`,
    );
  }
  manifest.completeness.ok = manifest.completeness.warnings.length === 0;
  manifest.finalizedAt = new Date().toISOString();
  return manifest;
}

/**
 * One line per status, so the operator can tell "work still to do" (pending / failed)
 * from "nothing more this tool can verify" (manual-verification-required / limitation).
 * Round-5 review: the latter keeps the bundle unreleasable, but the message must not
 * read as if a re-run could fix it — only an adapter or an approved attestation can.
 */
function summarizeExternalSinks(external = {}) {
  const byStatus = {};
  for (const [key, v] of Object.entries(external)) {
    (byStatus[v.status] ??= []).push(key);
  }
  const lines = Object.entries(byStatus).map(([status, keys]) => `  ${status}: ${keys.join(', ')}`);
  const manual = byStatus['manual-verification-required'] ?? [];
  if (manual.length) {
    lines.push(
      `  → ${manual.join(', ')}: artifact hashed and counted, total not independently ` +
        'verified. This tool cannot promote these — a service-specific adapter or an ' +
        'approved attestation must (runbook §2.1).',
    );
  }
  return `External sinks by status:\n${lines.join('\n')}`;
}

/**
 * Validate an EXISTING bundle directory before finalization reads or writes anything.
 *
 * PR #349 review (round 3): `--finalize` skipped `prepareOutputDir()` and applied only
 * `path.resolve()`, so a symlinked bundle path was accepted — and no ANCESTOR was
 * checked either, so a symlinked parent could redirect both the results read and the
 * manifest written. Every component from the filesystem root down is lstat-ed.
 */
function assertSecureExistingDir(out) {
  const resolved = assertNoSymlinkInPath(out);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Bundle path does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`--out is not a directory: ${resolved}`);
  }
  if (!fs.existsSync(path.join(resolved, 'manifest.json'))) {
    throw new Error(
      `No manifest.json in ${resolved}. --finalize reconciles an existing phase-one ` +
        'bundle; run the collect phase first.',
    );
  }
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

/**
 * Hash an artifact that must live INSIDE the validated bundle. Rejects traversal and
 * symlinks so a result file cannot point the checksum at something else on disk.
 */
function verifyBundleArtifact(artifact, bundleDir) {
  const crypto = require('node:crypto');
  const resolved = path.resolve(bundleDir, artifact);
  if (resolved !== bundleDir && !resolved.startsWith(bundleDir + path.sep)) {
    throw new Error(`artifact escapes the bundle: ${artifact}`);
  }
  assertNoSymlinkInPath(resolved, bundleDir);
  const st = fs.lstatSync(resolved);
  if (!st.isFile()) {
    throw new Error(`artifact is not a regular file: ${artifact}`);
  }
  if (st.uid !== process.getuid?.()) {
    throw new Error(`artifact is not owned by the operator: ${artifact} (uid ${st.uid})`);
  }
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    // Externally produced artifacts arrive with the ambient umask; tighten before the
    // bundle can be called releasable (round-4 review).
    fs.chmodSync(resolved, 0o600);
  }
  const buf = fs.readFileSync(resolved);
  return {
    checksum: crypto.createHash('sha256').update(buf).digest('hex'),
    records: countArtifactRecords(buf, artifact),
    bytes: buf.length,
    tightenedFrom: mode === 0o600 ? null : mode.toString(8),
  };
}

/**
 * Derive an artifact's record count from its BYTES, not from the operator's number.
 *
 * PR #349 review (round 4): a checksum proves only that the named bytes exist — it says
 * nothing about how many records they contain, so `collected` was still an assertion.
 * JSONL (one record per line) and a top-level JSON array both parse deterministically;
 * anything else returns null and the sink falls back to declaring itself unverifiable
 * rather than silently passing.
 */
function countArtifactRecords(buf, artifactName) {
  const text = buf.toString('utf8').trim();
  if (!text) return 0;
  if (/\.jsonl$/i.test(artifactName) || (!text.startsWith('[') && !text.startsWith('{'))) {
    const lines = text.split('\n').filter((l) => l.trim());
    for (const l of lines) {
      try {
        JSON.parse(l);
      } catch {
        return null; // not JSONL after all — refuse to guess
      }
    }
    return lines.length;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed.length;
  // A single object wrapping the rows, e.g. { data: [...] } or { hits: [...] }.
  for (const key of ['data', 'hits', 'results', 'items', 'objects', 'records']) {
    if (Array.isArray(parsed[key])) return parsed[key].length;
  }
  return null;
}

/**
 * Replace manifest.json atomically, in place, 0600 — temp file in the SAME validated
 * directory then rename, so a crash mid-write can never leave a half-written manifest
 * that still reads as authoritative.
 */
function replaceManifestAtomically(dir, manifest) {
  const target = path.join(dir, 'manifest.json');
  const tmp = path.join(dir, `.manifest.${process.pid}.tmp`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  return target;
}

/**
 * The `--finalize` phase end to end. Deliberately takes NO database: it reconciles the
 * immutable phase-one bundle against the external results and rewrites exactly one file.
 *
 * Round 2 re-ran `collect()` here, which hit EEXIST on the first exclusive write
 * (`users.json`) before any result was read — the documented flow could not run at all,
 * and helper-level tests never executed it. This path is now covered end to end.
 */
function runFinalize(out, log = console.log) {
  const dir = assertSecureExistingDir(out);
  // Every consumed file goes through the no-follow / type / owner / mode check — the
  // manifest included, since a symlinked manifest.json inside a validated directory was
  // still followed before (round-4 review).
  const manifestRead = readSecureJson(path.join(dir, 'manifest.json'), {
    bundleDir: dir,
    required: true,
  });
  const manifest = manifestRead.data;
  finalizeManifest(manifest, dir, (f) => readSecureJson(f, { bundleDir: dir })?.data ?? null, {
    verifyArtifact: verifyBundleArtifact,
  });
  replaceManifestAtomically(dir, manifest);
  log(
    JSON.stringify(
      { externalSinks: manifest.externalSinks, completeness: manifest.completeness },
      null,
      2,
    ),
  );
  return manifest;
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
    else if (a === '--finalize') args.finalize = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/* ------------------------------------------------------------------ collection */

class AmbiguousSubjectError extends Error {
  constructor(userRef, tenantIds) {
    super(
      `"${userRef}" matches ${tenantIds.length} users across tenants [${tenantIds.join(', ')}]. ` +
        'Re-run with --tenant <id> to name the one the request is about. ' +
        'Refusing to guess: exporting the wrong person is a personal-data breach.',
    );
    this.name = 'AmbiguousSubjectError';
    this.tenantIds = tenantIds;
  }
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * Resolve the subject, tenant-safely.
 *
 * PR #349 review: `email` is unique only within `(email, tenantId)` —
 * `userSchema.index({ email: 1, tenantId: 1 }, { unique: true })` — and this script
 * runs under `runAsSystem`, which sets SYSTEM_TENANT_ID and makes `applyTenantIsolation`
 * skip tenant injection entirely. `findOne({ email })` therefore searched every tenant
 * and returned an arbitrary match: a DSAR could export the wrong person.
 *
 * Now: a non-ObjectId reference must resolve to exactly one user. Zero → not found;
 * more than one → refuse and name the tenants so the operator can disambiguate.
 * `--tenant` narrows the lookup up front, and a subject found by `_id` is still
 * checked against it.
 */
async function resolveSubject(models, userRef, tenantId) {
  const { User } = models;
  const scope = tenantId ? { tenantId } : {};

  if (OBJECT_ID_RE.test(userRef)) {
    const byId = await User.findOne({ _id: userRef, ...scope }).lean();
    if (byId) return byId;
    // Fall through: the reference may be a 24-hex external id, not a Mongo _id.
  }

  const matches = await User.find({
    ...scope,
    $or: [
      { email: userRef },
      { username: userRef },
      { openidId: userRef },
      { idOnTheSource: userRef },
    ],
  }).lean();

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new AmbiguousSubjectError(
      userRef,
      matches.map((m) => m.tenantId ?? '(none)'),
    );
  }
  return matches[0];
}

/** Build the Mongo filter for one sink. */
function sinkFilter(sink, subject) {
  const id = subject._id;
  if (sink.membership) {
    return { [sink.field]: { $in: groupMembershipKeys(subject) } };
  }
  if (sink.emailField) {
    // The only sink keyed by email rather than an id. Match the app's own
    // normalisation (`lowercase: true, trim: true` on the schema).
    const email = String(subject.email ?? '')
      .trim()
      .toLowerCase();
    return email ? { [sink.field]: email } : { [sink.field]: { $in: [] } };
  }
  if (sink.model === 'KnaufFileAsset') {
    // The asset ledger is scoped by (scope_type, scope_id), but SCOPE IS THE WRONG
    // OWNERSHIP TEST for a DSAR (PR #349 review, round 3).
    //
    // Round 2 selected every asset under an agent the subject authored. Wrong in both
    // directions: an agent's scope holds uploads from every EDIT-authorized
    // collaborator (disclosing their files to this subject), while the subject's own
    // uploads to somebody else's agent fell outside it entirely.
    //
    // Ownership lives on the LOGICAL row. `process.js` writes
    // `createFile({ user: req.user.id, knauf_asset_id })`, so the uploader owns the
    // File row no matter who authored the agent. Resolving physical assets through the
    // subject's own File rows' `knauf_asset_id` values is therefore exact both ways.
    // The user-scope branch stays because a `scope_type: 'user'` asset carrying the
    // subject's id is theirs by construction and can never be another person's.
    const assetIds = subject._dsarAssetIds ?? [];
    const branches = [{ scope_type: 'user', scope_id: { $in: [id, String(id)] } }];
    if (assetIds.length) {
      branches.push({ asset_id: { $in: assetIds } });
    }
    return branches.length === 1 ? branches[0] : { $or: branches };
  }
  const filter = { [sink.field]: { $in: [id, String(id)] } };
  if (sink.principalType) {
    filter.principalType = sink.principalType;
  }
  return filter;
}

/** Drop named third-party fields from a row, replacing them with a stated reason. */
function redactFields(row, fields) {
  const out = { ...row };
  for (const f of fields) {
    if (out[f] !== undefined) {
      out[f] = '[redacted — third party, Art. 15(4)]';
    }
  }
  return out;
}

/** Per-sink row shaping, so the projection rule lives next to the sink definition. */
function shapeRows(sink, rows, subject) {
  if (sink.existenceOnly) return rows.map(toExistenceOnly);
  if (sink.membership) {
    const keys = groupMembershipKeys(subject);
    return rows.map((r) => toSubjectGroupView(r, keys));
  }
  if (sink.redactFields) return rows.map((r) => redactFields(r, sink.redactFields));
  return rows;
}

async function collect({ models, mongoose, subject, tenantId, out, includeLogs, logDir, log }) {
  const id = subject._id;
  const manifest = {
    generatedAt: new Date().toISOString(),
    // Immutable identity for THIS collection. Every external result must carry it, so a
    // result cannot be copied from another bundle or replayed from an earlier run
    // against a stale inventory (round-4 review).
    runId: require('node:crypto').randomUUID(),
    // Recorded so `not-applicable` claims can be checked against the environment phase
    // one actually ran in, instead of being taken on trust.
    environment: {
      redisEnabled: String(process.env.USE_REDIS ?? '').toLowerCase() === 'true',
      searchEnabled:
        Boolean(process.env.MEILI_HOST) &&
        String(process.env.SEARCH ?? 'true').toLowerCase() !== 'false',
      langfuseEnabled: Boolean(process.env.LANGFUSE_HOST || process.env.LANGFUSE_PUBLIC_KEY),
      logToFile: String(process.env.LOG_TO_FILE ?? '').toLowerCase() !== 'false',
    },
    subject: { _id: String(id), email: subject.email },
    // Recorded and verified: everything below was read inside this tenant's context.
    tenant: {
      resolved: tenantId ?? null,
      note: tenantId
        ? 'collection ran inside tenantStorage.run({ tenantId })'
        : 'subject carries no tenantId (single-tenant deployment) — ran as system',
    },
    readOnly: true,
    sinks: {},
    redactions: [
      `users: ${USER_SECRET_FIELDS.filter((f) => f !== '__v').join(', ')} stripped`,
      'auditlogs: actor redacted on rows where the subject is the target (Art. 15(4))',
      'credential/session stores: existence-level fields only',
      'groups: memberIds withheld — other members are third parties (Art. 15(4))',
      // Derived from the sink definitions, never restated by hand: a redaction the
      // manifest claims is always one the code actually performs.
      ...MONGO_SINKS.filter((s) => s.redactFields).map(
        (s) => `${s.model}: ${s.redactFields.join(', ')} redacted (Art. 15(4))`,
      ),
    ],
    exclusions: [],
    // Every external sink is PENDING until `--finalize` ingests a verified result.
    externalSinks: initialExternalSinkState(),
    completeness: { ok: true, warnings: [] },
  };
  const warn = (msg) => {
    manifest.completeness.ok = false;
    manifest.completeness.warnings.push(msg);
  };
  const write = (name, data) => {
    if (!out) return;
    writeBundleFile(out, name, JSON.stringify(data, null, 2));
  };

  // users — the subject document itself, minus any traversal helper we attached.
  const { _dsarAgentIds: _a, _dsarAssetIds: _b, ...subjectDoc } = subject;
  write('users.json', redactUserDocument(subjectDoc));
  manifest.sinks.users = 1;

  // Physical assets resolve through the subject's OWN File rows, so the File sink must
  // be read before the asset sink regardless of MONGO_SINKS ordering — relying on array
  // position here would be a silent trap for the next editor.
  const fileSink = MONGO_SINKS.find((k) => k.model === 'File');
  const subjectFiles = models.File
    ? await models.File.find(sinkFilter(fileSink, subject)).lean()
    : [];
  const subjectView = {
    ...subject,
    _dsarAssetIds: [
      ...new Set(
        subjectFiles
          .map((f) => f.knauf_asset_id)
          .filter(Boolean)
          .map(String),
      ),
    ],
  };
  manifest.sinks.ownedAssetIds = subjectView._dsarAssetIds.length;

  // Meilisearch indexes only NON-temporary, unexpired documents
  // (`mongoMeili.buildIndexableQuery` -> `buildRetentionVisibilityFilter`). Count that
  // subset with the same predicate so the derived expectation measures the replica
  // against what is actually indexable, not against every row in Mongo.
  const indexableFilter = {
    $or: [
      { isTemporary: false, expiredAt: null },
      { isTemporary: false, expiredAt: { $gt: new Date() } },
      { isTemporary: null, expiredAt: null },
    ],
  };
  for (const [model, field] of [
    ['Message', 'user'],
    ['Conversation', 'user'],
  ]) {
    if (!models[model]) continue;
    manifest.sinks[`${model}Indexable`] = await models[model].countDocuments({
      [field]: { $in: [id, String(id)] },
      ...indexableFilter,
    });
  }

  // every subject-scoped Mongo store
  let files = [];
  let assets = [];
  for (const sink of MONGO_SINKS) {
    const Model = models[sink.model];
    if (!Model) {
      manifest.sinks[sink.model] = 'model not registered';
      warn(`${sink.model}: model not registered — sink not collected`);
      continue;
    }
    const rows =
      sink.model === 'File' ? subjectFiles : await Model.find(sinkFilter(sink, subjectView)).lean();
    manifest.sinks[sink.model] = rows.length;
    if (sink.model === 'File') files = rows;
    if (sink.model === 'KnaufFileAsset') assets = rows;
    write(`${sink.model}.json`, shapeRows(sink, rows, subjectView));
  }

  // knauf scheduler collections (raw)
  const db = mongoose.connection.db;
  for (const raw of RAW_COLLECTIONS) {
    // Raw driver reads bypass `applyTenantIsolation` (it is a mongoose plugin), so a
    // tenant-scoped raw collection must be filtered explicitly — the ALS context does
    // not reach `db.collection(...)`.
    const filter = { [raw.field]: { $in: [id, String(id)] } };
    if (raw.tenantField && tenantId) {
      filter[raw.tenantField] = tenantId;
    }
    const rows = await db.collection(raw.collection).find(filter).toArray();
    manifest.sinks[raw.collection] = rows.length;
    write(
      `${raw.collection}.json`,
      raw.redactFields ? rows.map((r) => redactFields(r, raw.redactFields)) : rows,
    );
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

  // physical vector + blob identity, from the FileAsset ledger
  const vectors = classifyVectorStores(files, assets);
  manifest.sinks.vectorStores = {
    pgvector: vectors.pgvector.length,
    azureAiSearch: vectors.azureAiSearch.length,
    unverifiedBackend: vectors.unverified.length,
    staleGenerationDebt: vectors.staleGenerationDebt.length,
  };
  if (vectors.unverified.length) {
    warn(
      `vectorStores: ${vectors.unverified.length} file(s) have no FileAsset row — ` +
        'backend inferred from context; confirm with the RAG service before release',
    );
  }
  write('vector-stores.json', vectors);
  write('vector-inventory-request.json', buildVectorInventoryRequest(id, tenantId, vectors));

  // Self-review: avatars are written straight to `images/<userId>/avatar-<ts>.<ext>` by
  // `Azure/images.js` / `Local/images.js` with NO `createFile` call, so they have no
  // File row and no FileAsset — a bundle built only from those two missed the subject's
  // own photograph. The stored URL is on the user document.
  const avatarObjects = subject.avatar
    ? [{ source: 'users.avatar', key: String(subject.avatar).split('?')[0], filename: 'avatar' }]
    : [];
  const fileObjects = files
    .map((f) => ({
      source: 'File',
      file_id: f.file_id,
      filename: f.filename,
      key: f.filepath || f.storageKey,
    }))
    .filter((o) => o.key);
  const assetObjects = assets
    .map((a) => ({
      source: 'KnaufFileAsset',
      asset_id: a.asset_id,
      filename: a.blob?.filename,
      key: a.blob?.path,
    }))
    .filter((o) => o.key);
  const blobObjects = [...fileObjects, ...assetObjects, ...avatarObjects];
  manifest.sinks.blob = {
    container: process.env.AZURE_CONTAINER_NAME || 'files',
    // The derived expectation is measured against THIS total, so it must count every
    // object the operator is told to pull — avatars included.
    objects: blobObjects.length,
    fromFileRows: fileObjects.length,
    fromAssets: assetObjects.length,
    avatars: avatarObjects.length,
    avatarPrefix: `images/${String(id)}/`,
  };
  write('blob-objects.json', blobObjects);

  if (out) {
    // 0600, not 0755: this is the subject's personal-data corpus, and the script
    // carries their id. Run it with `bash langfuse.sh`, not `./langfuse.sh`.
    writeBundleFile(out, 'langfuse.sh', buildLangfuseCommands(id));
    writeBundleFile(out, 'meilisearch.md', buildMeilisearchQueries(id));
    writeBundleFile(
      out,
      'results/README.md',
      buildResultsReadme({
        runId: manifest.runId,
        subject: manifest.subject._id,
        tenant: manifest.tenant.resolved,
      }),
    );
  }
  manifest.sinks.langfuse = 'PENDING — run langfuse.sh, then re-run with --finalize';
  manifest.sinks.meilisearch = 'PENDING — run the meilisearch.md recipe, then --finalize';
  manifest.exclusions.push(
    'pgvector / Azure AI Search: no by-subject read-back endpoint. The bundle lists exact ' +
      'physical vector ids (vector-inventory-request.json) for the RAG service to confirm; ' +
      'the content itself is the source file in Blob (runbook §1.3/1.4)',
    'Datadog browser RUM / Adobe Analytics: random per-session id, no setUser, ' +
      'defaultPrivacyLevel mask-user-input — not attributable to a named subject (runbook §1.9). ' +
      'Server-side logs and APM in Datadog ARE attributable and are handled in runbook §1.10',
  );

  // logs — see runbook §1.8. When LOG_TO_FILE=false (the deployed setting in any
  // environment that ships stdout to a log platform) there are no files to read here
  // and this sink is NOT the whole story: server logs carry userId/tenantId/requestId
  // through requestContextFormat on the console transport too. Runbook §1.10 covers
  // the platform-side export.
  const fileLoggingOff = String(process.env.LOG_TO_FILE ?? '').toLowerCase() === 'false';
  if (includeLogs) {
    const dir =
      logDir || process.env.LIBRECHAT_LOG_DIR || path.resolve(__dirname, '..', '..', 'api', 'logs');
    const hits = [];
    let unreadable = 0;
    if (fs.existsSync(dir)) {
      // Self-review: filtering on `.log` read ONLY today's file. Winston rotates with
      // `zippedArchive: true`, so the other 13 days of the retention window are
      // `*.log.gz` — they were skipped silently while the manifest claimed 14 days.
      const zlib = require('node:zlib');
      const names = fs.readdirSync(dir).filter((n) => n.endsWith('.log') || n.endsWith('.log.gz'));
      for (const f of names) {
        let text;
        try {
          const raw = fs.readFileSync(path.join(dir, f));
          text = f.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
        } catch (err) {
          unreadable += 1;
          warn(
            `winstonLogs: could not read ${f} (${err.message}) — lines from it are NOT included`,
          );
          continue;
        }
        const lines = text.split('\n').filter((l) => l.includes(String(id)));
        hits.push(...lines.map((l) => ({ file: f, line: l })));
      }
    }
    manifest.sinks.winstonLogs = {
      dir,
      matchingLines: hits.length,
      filesScanned: fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((n) => n.endsWith('.log') || n.endsWith('.log.gz')).length
        : 0,
      unreadableFiles: unreadable,
      window: '14-day rotation (includes rotated *.log.gz)',
      fileLoggingEnabled: !fileLoggingOff,
    };
    if (fileLoggingOff || !fs.existsSync(dir)) {
      warn(
        'winstonLogs: LOG_TO_FILE=false or no log directory — this host writes server logs to ' +
          'stdout only. Attributable server logs live in the log platform; run runbook §1.10.',
      );
    }
    write('logs.json', hits);
  } else {
    manifest.sinks.winstonLogs = 'skipped — pass --include-logs (platform team on prod)';
    warn('winstonLogs: not collected. Runbook §1.8/§1.10 must be completed by the platform team.');
  }

  for (const sink of EXTERNAL_SINKS) {
    warn(`externalSinks: ${sink.key} is pending — ${sink.runbook}`);
  }

  write('manifest.json', manifest);
  log(JSON.stringify(manifest, null, 2));
  return manifest;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.user && !args.finalize)) {
    console.log(
      'usage: node knauf/scripts/dsar-collect.js --user <mongo-id|email> [--out DIR] [--tenant ID] [--include-logs] [--log-dir DIR]\n' +
        '       node knauf/scripts/dsar-collect.js --out DIR --finalize   # reconcile an existing bundle; no database needed',
    );
    process.exit(args.help ? 0 : 1);
  }

  // --- phase two ------------------------------------------------------------------
  // Finalization reconciles the IMMUTABLE phase-one bundle. It opens no database and
  // rewrites exactly one file, so it cannot re-collect, cannot collide with phase one's
  // exclusive writes, and cannot drift from what was actually disclosed.
  if (args.finalize) {
    if (!args.out) {
      console.error('--finalize needs --out <existing bundle dir>.');
      process.exit(1);
    }
    let finalManifest;
    try {
      finalManifest = runFinalize(args.out, console.log);
    } catch (err) {
      console.error(err.message);
      process.exit(5);
    }
    if (!finalManifest.completeness.ok) {
      console.error(`\n${summarizeExternalSinks(finalManifest.externalSinks)}`);
      console.error(
        '\nIncomplete: see manifest.externalSinks and manifest.completeness.warnings. ' +
          'This bundle is NOT releasable.',
      );
      process.exit(4);
    }
    console.log('\nComplete: every external sink is reconciled. Bundle is releasable.');
    return;
  }

  // Same bootstrap as config/migrate-orphaned-agent-files.js.
  require('module-alias')({ base: path.resolve(__dirname, '..', '..', 'api') });
  const connect = require('../../config/connect');
  const { runAsSystem, tenantStorage } = require('@librechat/data-schemas');
  const mongoose = require('mongoose');
  await connect();
  const models = require('~/db/models');

  // The collect phase always demands a fresh, private directory it created itself.
  if (args.out) {
    args.out = prepareOutputDir(args.out);
  }

  // Resolution runs as system on purpose: the operator may not know the tenant yet,
  // and a cross-tenant lookup is how we DETECT ambiguity rather than silently
  // resolving it. Collection then runs pinned to the tenant we resolved.
  const subject = await runAsSystem(() =>
    resolveSubject(models, args.user, args.tenant).catch((err) => {
      if (err instanceof AmbiguousSubjectError) {
        console.error(err.message);
        process.exit(3);
      }
      throw err;
    }),
  );

  if (!subject) {
    console.error(
      `No user matches "${args.user}"${args.tenant ? ` in tenant ${args.tenant}` : ''} ` +
        '(tried _id, email, username, openidId, idOnTheSource).',
    );
    process.exit(2);
  }

  const subjectTenant = subject.tenantId ?? null;
  if (args.tenant && subjectTenant && String(subjectTenant) !== String(args.tenant)) {
    console.error(
      `Subject resolved into tenant "${subjectTenant}" but --tenant said "${args.tenant}". Refusing.`,
    );
    process.exit(3);
  }

  // Ownership of a physical asset is decided by the subject's own File rows
  // (`knauf_asset_id`), resolved inside collect(). Agent authorship is deliberately NOT
  // used: an agent's scope mixes every collaborator's uploads, and the subject's uploads
  // to other people's agents live outside it (PR #349 review round 3).
  const run = () =>
    collect({
      models,
      mongoose,
      subject,
      tenantId: subjectTenant,
      out: args.out,
      includeLogs: args.includeLogs,
      logDir: args.logDir,
      log: console.log,
    });

  // Pin every read to the subject's own tenant when they have one; only a genuinely
  // tenant-less (single-tenant) deployment falls back to system scope.
  const manifest =
    subjectTenant && tenantStorage?.run
      ? await tenantStorage.run({ tenantId: subjectTenant }, run)
      : await runAsSystem(run);

  await mongoose.disconnect();

  if (args.out) {
    // Phase one NEVER finalizes. It cannot: no external sink has run yet, so any
    // "complete" it produced would be a claim about work that had not happened.
    console.log(
      `\nPhase one complete. ${EXTERNAL_SINKS.length} external sinks are PENDING — see ` +
        `${path.join(args.out, 'results', 'README.md')}, then re-run with --finalize.`,
    );
  }

  if (!manifest.completeness.ok) {
    console.error(
      '\nIncomplete: the bundle has open completeness warnings (see manifest.completeness). ' +
        'Resolve them before releasing it to the subject.',
    );
    process.exit(4);
  }
}

module.exports = {
  MONGO_SINKS,
  NOT_SUBJECT_SCOPED,
  RAW_COLLECTIONS,
  USER_SECRET_FIELDS,
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
  NOT_SUBJECT_SCOPED_RAW,
  EXTERNAL_SINKS,
  summarizeExternalSinks,
  AUDIT_ACTOR_CONTEXT_FIELDS,
  AUDIT_CONTEXT_REDACTED,
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
  collect,
  sinkFilter,
  shapeRows,
  resolveSubject,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
// End [knauf]
