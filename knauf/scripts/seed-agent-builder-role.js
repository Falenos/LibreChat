// @ts-check
//
// seed-agent-builder-role.js
//
// Idempotent mongosh script: creates the AGENT_BUILDER custom role if it does
// not already exist, then ensures all non-admin-managed permissions are set.
//
// AGENT_BUILDER: AI Champions who can create private agents, create public
// artifact links, and use the approved chat features, but have NO admin panel access
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
// Safe to re-run: creates the role if missing; preserves PROMPTS and PEOPLE_PICKER
// on existing roles because those permissions are owned by the Admin UI.

// mongosh globals. `print` is already a known global in the shared eslint env,
// so declaring it here would trip no-redeclare — these two are not.
/* global db, printjson */

'use strict';

const ROLE_NAME = 'AGENT_BUILDER';
const DESCRIPTION =
  'AI Champions — can create private agents and artifact links. No agent publishing or admin panel access.';
const ADMIN_MANAGED_PERMISSION_TYPES = ['PROMPTS', 'PEOPLE_PICKER'];

// Permission set — sourced from admin panel screenshots (2026-06-11).
// Keys match the PermissionTypes / Permissions enums in librechat-data-provider.
// prettier-ignore
const PERMISSIONS = {
  BOOKMARKS:      { USE: true },
  MEMORIES:       { USE: false, CREATE: false, UPDATE: false, READ: false, OPT_OUT: false },
  AGENTS:         { USE: true, CREATE: true, SHARE: false, SHARE_PUBLIC: false },
  MULTI_CONVO:    { USE: true },
  TEMPORARY_CHAT: { USE: true },
  // KK20-252 / KK20-257 — stays false, and it no longer matters much: do not "fix" this.
  // `interface.runCode` is now `true` in librechat.yaml, but permissions.ts:125 re-seeds
  // only USER and ADMIN from that file, so this role is set here or nowhere.
  //
  // It is deliberately not granted, and granting it would add nothing: RUN_CODE.USE
  // reaches only the manual execution surfaces (composer chip, tools-menu row,
  // per-code-block Run button), and all three are hidden in the client by the
  // KNAUF_HIDE_CODE_* flags, so no UI calls the endpoint it protects. Code execution
  // itself has never come from this permission — it comes from the `execute_code`
  // capability plus the per-spec `executeCode` flag. AI Champions therefore get code
  // execution exactly like everyone else, automatically, with no toggle to find.
  // Explicit false rather than deleted: the update below is a full `$set` replace, and
  // the next reader should see the intent.
  RUN_CODE:       { USE: false },
  WEB_SEARCH:     { USE: true },
  MARKETPLACE:    { USE: true },
  FILE_SEARCH:    { USE: true },
  FILE_CITATIONS: { USE: true },
  SHARED_LINKS:   { CREATE: true, SHARE: true, SHARE_PUBLIC: true },
  MCP_SERVERS:    { USE: false, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  REMOTE_AGENTS:  { USE: false, CREATE: false, SHARE: false, SHARE_PUBLIC: false },
  // KK20-243 — AI Champions may USE deployment skills (the `$` popover, the
  // composer chip, the sidebar catalog) but not author them; authoring stays
  // with platform engineering, matching `interface.skills` in librechat.yaml.
  // This must stay explicit because `updateInterfacePermissions` only iterates
  // USER and ADMIN, so nothing else writes SKILLS onto AGENT_BUILDER.
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
  print('Preserving Admin-managed PROMPTS and PEOPLE_PICKER permissions.');
  let modifiedCount = 0;
  for (const role of existing) {
    const adminManagedPermissions = Object.fromEntries(
      ADMIN_MANAGED_PERMISSION_TYPES.filter(
        (permissionType) => role.permissions?.[permissionType] !== undefined,
      ).map((permissionType) => [permissionType, role.permissions[permissionType]]),
    );
    const result = roles.updateOne(
      { _id: role._id },
      {
        $set: {
          permissions: { ...PERMISSIONS, ...adminManagedPermissions },
          description: DESCRIPTION,
          updatedAt: new Date(),
        },
      },
    );
    modifiedCount += result.modifiedCount;
  }

  print('\nUpdate result:');
  print(`  Matched: ${existing.length}`);
  print(`  Modified: ${modifiedCount}`);
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
