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
  { model: 'Group', field: 'memberIds', membership: true },
  { model: 'AclEntry', field: 'principalId' },
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
  MigrationAllowlist: 'operational allowlist keyed by file/collection, not by subject',
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
  },
  {
    key: 'meilisearch',
    label: 'Meilisearch messages + convos',
    resultFile: 'results/meilisearch.json',
    runbook: '§1.2 — run the paged recipe in meilisearch.md',
  },
  {
    key: 'blob',
    label: 'Azure Blob objects',
    resultFile: 'results/blob.json',
    runbook: '§1.5 — pull the objects listed in blob-objects.json',
  },
  {
    key: 'ragVectors',
    label: 'RAG vector inventory confirmation',
    resultFile: 'results/rag-vectors.json',
    runbook: '§1.3/1.4 — send vector-inventory-request.json to the RAG service',
  },
  {
    key: 'logPlatform',
    label: 'Server logs / APM export',
    resultFile: 'results/log-platform.json',
    runbook: '§1.10 — owner-approved bounded export, or a recorded limitation',
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
function buildResultsReadme() {
  const rows = EXTERNAL_SINKS.map(
    (e) => `| \`${e.key}\` | ${e.label} | \`${e.resultFile}\` | ${e.runbook} |`,
  ).join('\n');
  return `# External sink results — REQUIRED before this bundle is releasable

The collector cannot execute these sinks itself, so it records them as **pending** and
refuses to report a complete bundle until each one has a verified result here.

| Key | Sink | Drop the result at | Runbook |
|---|---|---|---|
${rows}

Each file is JSON:

\`\`\`json
{ "status": "complete", "collected": 1234, "expected": 1234, "checksum": "<sha256>" }
\`\`\`

- \`status: "complete"\` also requires \`collected === expected\`. If they differ the sink
  is recorded as **failed** — a truncated extract is not a completed step.
- \`status: "not-applicable"\` is allowed but **requires a \`note\`** stating why (e.g. the
  log platform cannot query by \`userId\`). The note goes into the Art. 15 response as a
  stated limitation.
- Anything else — missing file, unreadable JSON, \`status: "failed"\` — keeps the bundle
  incomplete.

Then re-run:

\`\`\`bash
node knauf/scripts/dsar-collect.js --user <id> --out <this-dir> --finalize
\`\`\`

Only that run can set \`manifest.completeness.ok = true\`.
`;
}

/* --------------------------------------------------------------- safe output dir */

/**
 * PR #349 review (round 2): the bundle is the subject's entire personal-data corpus,
 * and the old code did `fs.mkdirSync(out, { recursive: true })` — which accepts an
 * existing directory or a symlink, leaves unrelated files in place, writes predictable
 * filenames under the ambient umask, and made `langfuse.sh` world-readable at 0755.
 *
 * Now: refuse a symlink, refuse a non-empty destination, create fresh at 0700, and
 * write every file 0600 with `wx` (exclusive) so nothing is silently overwritten.
 */
function prepareOutputDir(out) {
  const resolved = path.resolve(out);
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
 * Ingest one external sink's machine-readable result and decide whether it counts as
 * executed AND reconciled. A result is only `complete` when it says so explicitly and
 * its own numbers agree — `collected === expected`. Anything else is `failed`, which
 * keeps `completeness.ok` false.
 *
 * Shape (written by the operator or the emitted scripts):
 *   { "status": "complete" | "not-applicable" | "failed",
 *     "collected": <n>, "expected": <n>, "checksum": "<sha256>", "note": "..." }
 */
function reconcileExternalResult(sinkKey, raw) {
  const sink = EXTERNAL_SINKS.find((e) => e.key === sinkKey);
  const base = { label: sink?.label ?? sinkKey, expects: sink?.resultFile };
  if (raw == null) {
    return { ...base, status: 'pending', reason: 'no result file found' };
  }
  if (raw.status === 'not-applicable') {
    if (!raw.note) {
      return { ...base, status: 'failed', reason: 'not-applicable requires a written note' };
    }
    return { ...base, status: 'not-applicable', note: raw.note };
  }
  if (raw.status !== 'complete') {
    return { ...base, status: 'failed', reason: raw.reason ?? `status=${raw.status ?? 'missing'}` };
  }
  const collected = Number(raw.collected);
  const expected = Number(raw.expected);
  if (!Number.isFinite(collected) || !Number.isFinite(expected)) {
    return { ...base, status: 'failed', reason: 'collected/expected must both be numbers' };
  }
  if (collected !== expected) {
    return {
      ...base,
      status: 'failed',
      reason: `collected ${collected} but expected ${expected} — truncated`,
    };
  }
  return { ...base, status: 'complete', collected, expected, checksum: raw.checksum ?? null };
}

/** Read `<out>/results/*.json` and fold them into the manifest's external-sink state. */
function finalizeManifest(manifest, out, readJson) {
  const external = manifest.externalSinks ?? initialExternalSinkState();
  for (const sink of EXTERNAL_SINKS) {
    let raw = null;
    try {
      raw = readJson(path.join(out, sink.resultFile));
    } catch (err) {
      external[sink.key] = {
        label: sink.label,
        expects: sink.resultFile,
        status: 'failed',
        reason: `unreadable result file: ${err.message}`,
      };
      continue;
    }
    external[sink.key] = reconcileExternalResult(sink.key, raw);
  }
  manifest.externalSinks = external;

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
  if (sink.model === 'KnaufFileAsset') {
    // The asset ledger is scoped by (scope_type, scope_id).
    //
    // PR #349 review (round 2): the previous filter pinned `scope_type: 'user'` and a
    // comment claimed agent-scoped rows were "reached via the subject's Agent rows" —
    // but nothing implemented that traversal, so every Agent Knowledge upload the
    // subject made was silently missing. `fileSearchAssetLifecycle.js` writes
    // `scope_type: 'agent'` with `scope_id: String(entityId ?? userId)`, i.e. the AGENT
    // id. The caller resolves the subject's authored agent ids and passes them in; a
    // resolution failure marks the sink incomplete rather than quietly under-reporting.
    const scopeIds = [id, String(id), ...(subject._dsarAgentIds ?? [])];
    return {
      $or: [
        { scope_type: 'user', scope_id: { $in: scopeIds } },
        { scope_type: 'agent', scope_id: { $in: scopeIds } },
      ],
    };
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

async function collect({
  models,
  mongoose,
  subject,
  tenantId,
  agentIdError,
  out,
  includeLogs,
  logDir,
  log,
}) {
  const id = subject._id;
  const manifest = {
    generatedAt: new Date().toISOString(),
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

  if (agentIdError) {
    warn(
      `KnaufFileAsset: could not resolve the subject's agent ids (${agentIdError}) — ` +
        'agent-scope assets are NOT in this bundle. Re-run once the lookup works.',
    );
  }
  manifest.sinks.agentScopeIds = (subject._dsarAgentIds ?? []).length;

  // users — the subject document itself, minus the traversal helper we attached.
  const { _dsarAgentIds: _agentIds, ...subjectDoc } = subject;
  write('users.json', redactUserDocument(subjectDoc));
  manifest.sinks.users = 1;

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
    const rows = await Model.find(sinkFilter(sink, subject)).lean();
    manifest.sinks[sink.model] = rows.length;
    if (sink.model === 'File') files = rows;
    if (sink.model === 'KnaufFileAsset') assets = rows;
    write(`${sink.model}.json`, shapeRows(sink, rows, subject));
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

  manifest.sinks.blob = {
    container: process.env.AZURE_CONTAINER_NAME || 'files',
    objects: files.map((f) => f.filepath || f.storageKey).filter(Boolean).length,
    assetBlobs: assets.map((a) => a.blob?.path).filter(Boolean).length,
  };
  write(
    'blob-objects.json',
    [
      ...files.map((f) => ({
        source: 'File',
        file_id: f.file_id,
        filename: f.filename,
        key: f.filepath || f.storageKey,
      })),
      ...assets.map((a) => ({
        source: 'KnaufFileAsset',
        asset_id: a.asset_id,
        filename: a.blob?.filename,
        key: a.blob?.path,
      })),
    ].filter((o) => o.key),
  );

  if (out) {
    // 0600, not 0755: this is the subject's personal-data corpus, and the script
    // carries their id. Run it with `bash langfuse.sh`, not `./langfuse.sh`.
    writeBundleFile(out, 'langfuse.sh', buildLangfuseCommands(id));
    writeBundleFile(out, 'meilisearch.md', buildMeilisearchQueries(id));
    writeBundleFile(out, 'results/README.md', buildResultsReadme());
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
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.log'))) {
        const lines = fs
          .readFileSync(path.join(dir, f), 'utf8')
          .split('\n')
          .filter((l) => l.includes(String(id)));
        hits.push(...lines.map((l) => ({ file: f, line: l })));
      }
    }
    manifest.sinks.winstonLogs = {
      dir,
      matchingLines: hits.length,
      window: '14-day rotation',
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
  if (args.help || !args.user) {
    console.log(
      'usage: node knauf/scripts/dsar-collect.js --user <mongo-id|email> [--out DIR] [--tenant ID] [--include-logs] [--log-dir DIR]\n' +
        '       ... --out DIR --finalize   # after running the external sinks, ingest results/ and verify totals',
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

  // `--finalize` re-reads an existing bundle; every other run demands a fresh,
  // private directory it created itself.
  if (args.out && !args.finalize) {
    args.out = prepareOutputDir(args.out);
  } else if (args.out) {
    args.out = path.resolve(args.out);
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

  // Agent Knowledge assets are stored under `scope_type: 'agent'` with the AGENT id as
  // `scope_id`, so the subject's own uploads are unreachable without this traversal
  // (PR #349 review round 2). A failure here marks the sink incomplete rather than
  // silently under-reporting: an empty agent list and a broken lookup must not look alike.
  const resolveAgentIds = async () => {
    const rows = await models.Agent.find({ author: { $in: [subject._id, String(subject._id)] } })
      .select('id')
      .lean();
    return rows.map((r) => r.id).filter(Boolean);
  };

  const run = async () => {
    let agentIds = [];
    let agentIdError = null;
    try {
      agentIds = await resolveAgentIds();
    } catch (err) {
      agentIdError = err.message;
    }
    return collect({
      models,
      mongoose,
      subject: { ...subject, _dsarAgentIds: agentIds },
      tenantId: subjectTenant,
      agentIdError,
      out: args.out,
      includeLogs: args.includeLogs,
      logDir: args.logDir,
      log: console.log,
    });
  };

  // Pin every read to the subject's own tenant when they have one; only a genuinely
  // tenant-less (single-tenant) deployment falls back to system scope.
  const manifest =
    subjectTenant && tenantStorage?.run
      ? await tenantStorage.run({ tenantId: subjectTenant }, run)
      : await runAsSystem(run);

  await mongoose.disconnect();

  if (args.out) {
    // Fold in whatever the external sinks have actually produced. Without this step
    // every external sink stays pending and the bundle stays incomplete — which is
    // the point: a fresh collect run can never be "complete" on its own.
    finalizeManifest(manifest, args.out, (f) =>
      fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null,
    );
    const manifestPath = path.join(args.out, 'manifest.json');
    fs.rmSync(manifestPath, { force: true });
    writeBundleFile(args.out, 'manifest.json', JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest.externalSinks, null, 2));
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
  AUDIT_ACTOR_CONTEXT_FIELDS,
  AUDIT_CONTEXT_REDACTED,
  initialExternalSinkState,
  reconcileExternalResult,
  finalizeManifest,
  prepareOutputDir,
  writeBundleFile,
  buildResultsReadme,
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
