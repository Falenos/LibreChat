/**
 * KARL — "chat history disappears" diagnostic.
 *
 * READ-ONLY. Issues only countDocuments / find / getIndexes / aggregate. Never writes.
 *
 * COST, NOT JUST SAFETY. Read-only does not mean free. Sections [1], [4] and [5] aggregate and
 * $lookup across collections, which on a large production Cosmos cluster is material load. By
 * default this script therefore runs in SAMPLE mode: the heavy stages are capped at SAMPLE_LIMIT
 * documents and every aggregation carries a maxTimeMS ceiling, so a slow cluster aborts the query
 * instead of dragging. Sampled sections say so in their output, and a sampled zero is weaker
 * evidence than a full zero — it bounds the problem, it does not disprove it.
 *
 *   FULL=1        run unsampled. Do NOT do this on prod without a DBA/operator agreeing a window.
 *   SAMPLE=20000  raise the cap (default 5000).
 *   MAXTIME=60000 raise the per-aggregation time ceiling in ms (default 20000).
 *   SHOW_USERS=1  print raw user ids. Off by default — the report is shareable without it.
 *
 * Usage:
 *   mongosh "<MONGO_URI>" --quiet --file diagnose-history-loss.js
 *   mongosh "<MONGO_URI>" --quiet --eval 'FULL=1' --file diagnose-history-loss.js
 *
 * AGK dev/stage/prod Cosmos have publicNetworkAccess=Disabled and the AKS API server is private,
 * so this mongosh form works locally or over VPN only. In-cluster use needs a Node/mongoose port —
 * the application image ships Node + mongoose + MONGO_URI, but not mongosh. See
 * knauf/docs/operations/chat-history-disappearing-investigation.md.
 *
 * Each section prints a VERDICT line naming the hypothesis it confirms or clears.
 */

/* global db */
// `db` is a mongosh runtime global, not a Node one.

const NOW = new Date();
const out = (s) => print(s);
const hr = () => print('-'.repeat(72));

/* eslint-disable no-undef */
const FULL_SCAN = typeof FULL !== 'undefined' && String(FULL) === '1';
const SAMPLE_LIMIT = typeof SAMPLE !== 'undefined' ? Number(SAMPLE) : 5000;
const MAX_TIME_MS = typeof MAXTIME !== 'undefined' ? Number(MAXTIME) : 20000;
const SHOW_IDS = typeof SHOW_USERS !== 'undefined' && String(SHOW_USERS) === '1';
/* eslint-enable no-undef */

/** Caps a pipeline unless FULL=1. Placed before any $lookup so the join never runs unbounded. */
const capped = (pipeline) => (FULL_SCAN ? pipeline : [{ $limit: SAMPLE_LIMIT }].concat(pipeline));

/** Every aggregation gets a time ceiling so a slow cluster aborts rather than drags. */
const aggOpts = { maxTimeMS: MAX_TIME_MS };

const scopeNote = () =>
  FULL_SCAN
    ? 'full scan'
    : `sampled, first ${SAMPLE_LIMIT} docs — a zero here bounds, not disproves`;

/** User ids identify people. Report shape by default, identity only on request. */
const showUser = (id, index) => {
  const s = String(id ?? '');
  return SHOW_IDS ? s : `user#${index + 1} (…${s.slice(-4)})`;
};

function safe(label, fn) {
  try {
    return fn();
  } catch (e) {
    out(`  !! ${label} failed: ${e.message}`);
    return null;
  }
}

out('');
out('='.repeat(72));
out(`KARL chat-history diagnostic — ${NOW.toISOString()}`);
out(`db = ${db.getName()}`);
out(
  FULL_SCAN
    ? 'mode = FULL SCAN (unsampled) — heavy on a large cluster'
    : `mode = SAMPLE (limit ${SAMPLE_LIMIT}, maxTimeMS ${MAX_TIME_MS}) — pass FULL=1 to scan all`,
);
out('='.repeat(72));

/* ---------------------------------------------------------------- totals */
hr();
out('[0] Corpus size');
const convoTotal = safe('convos', () => db.conversations.countDocuments({}));
const msgTotal = safe('messages', () => db.messages.countDocuments({}));
out(`  conversations: ${convoTotal}`);
out(`  messages:      ${msgTotal}`);

/* ------------------------------------------------- C5: TTL / expiredAt */
hr();
out('[1] C5 — MongoDB TTL on expiredAt (permanent deletion)');

const convoIdx = safe('convo idx', () => db.conversations.getIndexes()) || [];
const msgIdx = safe('msg idx', () => db.messages.getIndexes()) || [];
const ttlConvo = convoIdx.filter((i) => i.expireAfterSeconds !== undefined);
const ttlMsg = msgIdx.filter((i) => i.expireAfterSeconds !== undefined);

out(
  `  TTL indexes on conversations: ${ttlConvo.length ? JSON.stringify(ttlConvo.map((i) => i.name + ':' + i.expireAfterSeconds)) : 'NONE'}`,
);
out(
  `  TTL indexes on messages:      ${ttlMsg.length ? JSON.stringify(ttlMsg.map((i) => i.name + ':' + i.expireAfterSeconds)) : 'NONE'}`,
);

const convoExpiring = safe('convo exp', () =>
  db.conversations.countDocuments({ expiredAt: { $ne: null } }),
);
const msgExpiring = safe('msg exp', () => db.messages.countDocuments({ expiredAt: { $ne: null } }));
const convoTemp = safe('convo temp', () => db.conversations.countDocuments({ isTemporary: true }));
const msgTemp = safe('msg temp', () => db.messages.countDocuments({ isTemporary: true }));

out(`  conversations with expiredAt set: ${convoExpiring}`);
out(`  messages      with expiredAt set: ${msgExpiring}`);
out(`  conversations isTemporary=true:   ${convoTemp}`);
out(`  messages      isTemporary=true:   ${msgTemp}`);

// The dangerous shape: a conversation whose expiry is FURTHER OUT than its own
// messages' expiry. saveConvo re-stamps every turn; saveMessage stamps once.
const erosion = safe('erosion', () =>
  db.messages
    .aggregate(
      capped([
        { $match: { expiredAt: { $ne: null } } },
        {
          $group: {
            _id: '$conversationId',
            oldestMsgExpiry: { $min: '$expiredAt' },
            n: { $sum: 1 },
          },
        },
        {
          $lookup: {
            from: 'conversations',
            localField: '_id',
            foreignField: 'conversationId',
            as: 'c',
          },
        },
        { $unwind: '$c' },
        { $match: { $expr: { $lt: ['$oldestMsgExpiry', '$c.expiredAt'] } } },
        { $count: 'convosLosingTheirBeginning' },
      ]),
      aggOpts,
    )
    .toArray(),
);
out(
  `  conversations whose oldest messages expire BEFORE the conversation does: ${
    erosion && erosion.length ? erosion[0].convosLosingTheirBeginning : 0
  }`,
);

if ((convoExpiring || 0) === 0 && (msgExpiring || 0) === 0) {
  out(`  VERDICT: C5 CLEARED — nothing carries a TTL stamp. (${scopeNote()})`);
} else {
  out(
    '  VERDICT: C5 LIVE — rows are scheduled for permanent deletion. Inspect before the date passes.',
  );
}

/* ---------------------------------- C1: project filter hides from sidebar */
hr();
out('[2] C1 — chatProjectId hides chats from the main sidebar list');
const withProject = safe('proj', () =>
  db.conversations.countDocuments({ chatProjectId: { $ne: null } }),
);
const pct = convoTotal ? ((withProject / convoTotal) * 100).toFixed(1) : '0.0';
out(`  conversations with a chatProjectId: ${withProject} (${pct}% of all)`);
out('  These are INVISIBLE in the "Chats" sidebar (it queries projectId=unassigned).');

const perUser = safe('perUser', () =>
  db.conversations
    .aggregate(
      capped([
        { $match: { chatProjectId: { $ne: null } } },
        { $group: { _id: '$user', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 5 },
      ]),
      aggOpts,
    )
    .toArray(),
);
if (perUser && perUser.length) {
  out('  top users by project-scoped chats (these users lose the most from the sidebar):');
  perUser.forEach((u, i) => out(`    ${showUser(u._id, i)}: ${u.n}`));
  if (!SHOW_IDS) {
    out('    (ids redacted — re-run with SHOW_USERS=1 if you need to contact them)');
  }
}
out(
  `  VERDICT: C1 ${withProject > 0 ? 'LIVE' : 'CLEARED'} — ${withProject} chats exist but are absent from the default history view.`,
);

/* ------------------------- retention-filter blind spot (invisible rows) */
hr();
out('[3] Retention-filter blind spot — present in Mongo, invisible everywhere');
// buildRetentionVisibilityFilter has no {isTemporary: null, expiredAt: {$gt: now}} arm.
const blind = safe('blind', () =>
  db.conversations.countDocuments({
    isTemporary: null,
    expiredAt: { $ne: null },
  }),
);
out(`  conversations with isTemporary absent/null AND expiredAt set: ${blind}`);
out(`  VERDICT: ${blind > 0 ? 'LIVE — these rows can never be listed.' : 'CLEARED.'}`);

/* --------------------------------------- C4: cursor pagination tie-skip */
hr();
out('[4] C4 — cursor pagination skips conversations sharing an updatedAt');
// Page size is 25 and the cursor is a strict updatedAt<X. Ties are only lost when
// they straddle a page boundary, but any tie at all is a latent skip.
const ties = safe('ties', () =>
  db.conversations
    .aggregate(
      capped([
        { $group: { _id: { u: '$user', t: '$updatedAt' }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $count: 'tiedGroups' },
      ]),
      aggOpts,
    )
    .toArray(),
);
const tiedGroups = ties && ties.length ? ties[0].tiedGroups : 0;
out(`  (user, updatedAt) groups with more than one conversation: ${tiedGroups}`);
out(
  `  VERDICT: C4 ${tiedGroups > 0 ? 'EXPOSED' : 'CLEARED'} — a tie must straddle a 25-row page boundary to actually drop a row.`,
);

/* ------------------------------------------ orphans: real deletion proof */
hr();
out('[5] Orphans — did rows actually get deleted?');
const orphanMsgs = safe('orphans', () =>
  db.messages
    .aggregate(
      capped([
        { $group: { _id: '$conversationId' } },
        {
          $lookup: {
            from: 'conversations',
            localField: '_id',
            foreignField: 'conversationId',
            as: 'c',
          },
        },
        { $match: { c: { $size: 0 } } },
        { $count: 'orphanedConversationIds' },
      ]),
      aggOpts,
    )
    .toArray(),
);
out(
  `  message groups whose conversation no longer exists: ${
    orphanMsgs && orphanMsgs.length ? orphanMsgs[0].orphanedConversationIds : 0
  }`,
);
out('  (non-zero => conversations were deleted while their messages survived,');
out('   i.e. a convo-only delete path or a TTL race. Zero => no such deletion.)');

const emptyConvos = safe('empty', () =>
  db.conversations
    .aggregate(
      capped([
        {
          $lookup: {
            from: 'messages',
            localField: 'conversationId',
            foreignField: 'conversationId',
            as: 'm',
          },
        },
        { $match: { m: { $size: 0 } } },
        { $count: 'conversationsWithZeroMessages' },
      ]),
      aggOpts,
    )
    .toArray(),
);
out(
  `  conversations with ZERO messages: ${
    emptyConvos && emptyConvos.length ? emptyConvos[0].conversationsWithZeroMessages : 0
  }`,
);
out('  (this is the S2 symptom persisted: chat listed, messages gone.)');
out(`  (${scopeNote()})`);

/* ---------------------------------------------------- R1: tenant landmine */
hr();
out('[6] R1 — tenant isolation landmine');
const tenants = safe('tenants', () => db.users.distinct('tenantId'));
const convoTenants = safe('convoTenants', () => db.conversations.distinct('tenantId'));
out(`  distinct users.tenantId:         ${JSON.stringify(tenants)}`);
out(`  distinct conversations.tenantId: ${JSON.stringify(convoTenants)}`);
const mixed =
  (tenants || []).filter((t) => t != null).length > 0 &&
  (convoTenants || []).some((t) => t == null);
out(
  `  VERDICT: ${mixed ? 'LIVE — mixed tenancy, pre-tenancy rows are unreachable.' : 'DORMANT — tenancy not in use.'}`,
);

/* -------------------------------------------------- archived / isArchived */
hr();
out('[7] Archived chats (hidden from the default list, not deleted)');
const archived = safe('arch', () => db.conversations.countDocuments({ isArchived: true }));
out(`  conversations with isArchived=true: ${archived}`);

hr();
out('Done. Nothing was modified.');
out('');
