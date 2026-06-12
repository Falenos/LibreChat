// manage-migration-allowlist.js
//
// Run this script directly in IntelliJ IDEA's MongoDB console (or mongosh).
// Edit the two config lines below, then execute the whole script.
//
// ─── CONFIGURE HERE ──────────────────────────────────────────────────────────
const ACTION = 'list';   // 'list' | 'add' | 'remove'
const EMAILS = [
  // 'alice@knauf.com',
  // 'bob@knauf.com',
];
// ─────────────────────────────────────────────────────────────────────────────
//
// EMAILS can be an array (recommended for many users) or a comma-separated string.
//
// Examples:
//   List everyone:   ACTION = 'list'
//   Add users:       ACTION = 'add',    EMAILS = ['alice@knauf.com', 'bob@knauf.com']
//   Remove a user:   ACTION = 'remove', EMAILS = ['alice@knauf.com']
//
// All operations are idempotent and safe to re-run.

const allowlist = db.getCollection('migrationallowlists');

// Ensure the unique index exists
allowlist.createIndex({ emailNormalized: 1 }, { unique: true });

const action = ACTION.toLowerCase();

// ---------- helpers ----------

function normalise(email) {
  return (email || '').toLowerCase().trim();
}

function parseEmails(raw) {
  if (Array.isArray(raw)) {
    return raw.map(normalise).filter(Boolean);
  }
  return (raw || '')
    .split(/[\n,;]+/)
    .map(normalise)
    .filter(Boolean);
}

// ---------- actions ----------

if (action === 'list') {
  const docs = allowlist.find({}, { emailNormalized: 1, addedBy: 1, createdAt: 1 }).toArray();
  if (docs.length === 0) {
    print('ℹ️  Allowlist is empty — no users can access the new platform yet.');
  } else {
    print(`✅  ${docs.length} allowed email(s):\n`);
    docs.forEach((d) =>
      print(`  • ${d.emailNormalized}  (added by: ${d.addedBy || '—'}, at: ${d.createdAt?.toISOString?.() ?? '—'})`),
    );
  }
} else if (action === 'add') {
  const emails = parseEmails(typeof EMAILS !== 'undefined' ? EMAILS : '');
  if (emails.length === 0) {
    print('❌  No emails provided. Set EMAILS="alice@knauf.com,bob@knauf.com".');
  } else {
    let added = 0;
    let skipped = 0;
    emails.forEach((email) => {
      const result = allowlist.updateOne(
        { emailNormalized: email },
        { $setOnInsert: { emailNormalized: email, addedBy: 'script', createdAt: new Date(), updatedAt: new Date() } },
        { upsert: true },
      );
      if (result.upsertedCount > 0) {
        added++;
        print(`  ➕  Added: ${email}`);
      } else {
        skipped++;
        print(`  ⏭️   Already exists: ${email}`);
      }
    });
    print(`\nDone: ${added} added, ${skipped} already existed.`);
  }
} else if (action === 'remove') {
  const emails = parseEmails(typeof EMAILS !== 'undefined' ? EMAILS : '');
  if (emails.length === 0) {
    print('❌  No emails provided. Set EMAILS="alice@knauf.com".');
  } else {
    let removed = 0;
    let missing = 0;
    emails.forEach((email) => {
      const result = allowlist.deleteOne({ emailNormalized: email });
      if (result.deletedCount > 0) {
        removed++;
        print(`  ➖  Removed: ${email}`);
      } else {
        missing++;
        print(`  ⚠️   Not found: ${email}`);
      }
    });
    print(`\nDone: ${removed} removed, ${missing} not found.`);
  }
} else {
  print(`❌  Unknown action "${action}". Use ACTION='list', 'add', or 'remove'.`);
}
