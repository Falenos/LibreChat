// @ts-check
//
// seed-agent-builder-role.js
//
// Idempotent mongosh script: creates the AGENT_BUILDER custom role if it does
// not already exist, then ensures all required permissions are set.
//
// AGENT_BUILDER: AI Champions who can create private agents, share prompts and
// public artifact links, and use the approved chat features, but have NO admin panel access
// (access:admin capability is only granted to ADMIN via systemgrants — this
// script does not touch systemgrants).
//
// Usage:
//   # Local dev
//   mongosh "mongodb://localhost:27018/LibreChat" knauf/scripts/seed-agent-builder-role.js
//
//   # Remote (e.g. nonprod via SSH tunnel)
//   mongosh "<connection-string>" knauf/scripts/seed-agent-builder-role.js
//
// Safe to re-run: creates the role if missing; replaces the entire permissions
// block if the role already exists, so every run converges to the target state.

// mongosh globals. `print` is already a known global in the shared eslint env,
// so declaring it here would trip no-redeclare — these two are not.
/* global db, printjson */

'use strict';

const ROLE_NAME = 'AGENT_BUILDER';
const DESCRIPTION =
  'AI Champions — can create private agents and share prompts and artifact links. No agent publishing or admin panel access.';

// Permission set — sourced from admin panel screenshots (2026-06-11).
// Keys match the PermissionTypes / Permissions enums in librechat-data-provider.
// prettier-ignore
const PERMISSIONS = {
  BOOKMARKS:      { USE: true },
  PROMPTS:        { USE: true, CREATE: true, SHARE: true, SHARE_PUBLIC: false },
  MEMORIES:       { USE: false, CREATE: false, UPDATE: false, READ: false, OPT_OUT: false },
  AGENTS:         { USE: true, CREATE: true, SHARE: false, SHARE_PUBLIC: false },
  MULTI_CONVO:    { USE: true },
  TEMPORARY_CHAT: { USE: true },
  // KK20-252 — Run Code is off platform-wide. `interface.runCode: false` in
  // librechat.yaml only re-seeds USER and ADMIN (permissions.ts:125), so leaving
  // this true would have left AI Champions as the one role still holding
  // RUN_CODE.USE — backed by a sandbox that is not deployed on AGK, so the Run
  // button would fail every time. Explicit false rather than deleted: the update
  // below is a full `$set` replace, and the next reader should see the intent.
  RUN_CODE:       { USE: false },
  WEB_SEARCH:     { USE: true },
  PEOPLE_PICKER:  { VIEW_USERS: true, VIEW_GROUPS: false, VIEW_ROLES: false },
  MARKETPLACE:    { USE: true },
  FILE_SEARCH:    { USE: true },
  FILE_CITATIONS: { USE: true },
  SHARED_LINKS:   { CREATE: true, SHARE: true, SHARE_PUBLIC: true },
  MCP_SERVERS:    { USE: false, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  REMOTE_AGENTS:  { USE: false, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  // KK20-243 — AI Champions may USE deployment skills (the `$` popover, the
  // composer chip, the sidebar catalog) but not author them; authoring stays
  // with platform engineering, matching `interface.skills` in librechat.yaml.
  // This must stay explicit: the update below does `$set: { permissions }`, a
  // full replace, and `updateInterfacePermissions` only ever iterates USER and
  // ADMIN — so nothing else writes SKILLS onto AGENT_BUILDER. A missing
  // permission type reads as deny, not as default.
  SKILLS:         { USE: true, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
};

// ---------- main ----------

const roles = db.getCollection('roles');
const filter = { name: ROLE_NAME };
const existing = roles.find(filter).toArray();

if (existing.length === 0) {
  roles.insertOne({
    name: ROLE_NAME,
    description: DESCRIPTION,
    permissions: PERMISSIONS,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  print(`Created role "${ROLE_NAME}".`);
} else {
  // There can be multiple AGENT_BUILDER docs across tenant scopes
  // (same name, different tenantId). Update all of them.
  print(`Found ${existing.length} role document(s) named "${ROLE_NAME}".`);
  print('Before update (tenantId -> PROMPTS.SHARE_PUBLIC):');
  for (const role of existing) {
    const tenant = role.tenantId ?? '<no-tenant>';
    const value = role?.permissions?.PROMPTS?.SHARE_PUBLIC;
    print(`- ${tenant}: ${value}`);
  }

  const result = roles.updateMany(filter, {
    $set: { permissions: PERMISSIONS, description: DESCRIPTION, updatedAt: new Date() },
  });

  print('\nUpdate result:');
  print(`  Matched: ${result.matchedCount}`);
  print(`  Modified: ${result.modifiedCount}`);
}

// Confirm final state for every matching document.
const finalDocs = roles
  .find(filter, { name: 1, tenantId: 1, permissions: 1, description: 1 })
  .toArray();
print('\nFinal role document(s):');
for (const doc of finalDocs) {
  print(`\n_id=${doc._id}, tenantId=${doc.tenantId ?? '<no-tenant>'}`);
  printjson(doc.permissions);
}
