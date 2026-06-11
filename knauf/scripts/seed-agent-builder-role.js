// @ts-check
//
// seed-agent-builder-role.js
//
// Idempotent mongosh script: creates the AGENT_BUILDER custom role if it does
// not already exist, then ensures all required permissions are set.
//
// AGENT_BUILDER: AI Champions who can create/share agents and use all chat
// features, but have NO admin panel access (access:admin capability is only
// granted to ADMIN via systemgrants — this script does not touch systemgrants).
//
// Usage:
//   # Local dev
//   mongosh "mongodb://localhost:27018/LibreChat" knauf/scripts/seed-agent-builder-role.js
//
//   # Remote (e.g. nonprod via SSH tunnel)
//   mongosh "<connection-string>" knauf/scripts/seed-agent-builder-role.js
//
// Safe to re-run: uses updateOne with $setOnInsert for the role document and
// $set only for any permissions that are missing/false.

'use strict';

const ROLE_NAME = 'AGENT_BUILDER';
const DESCRIPTION = 'AI Champions — can create and share agents/prompts. No admin panel access.';

// Full permission set — identical to ADMIN chat permissions.
// Keys match the PermissionTypes / Permissions enums in librechat-data-provider.
const PERMISSIONS = {
  BOOKMARKS:      { USE: true },
  PROMPTS:        { USE: true, CREATE: true, SHARE: true, SHARE_PUBLIC: true },
  MEMORIES:       { USE: true, CREATE: true, UPDATE: true, READ: true, OPT_OUT: true },
  AGENTS:         { USE: true, CREATE: true, SHARE: true, SHARE_PUBLIC: true },
  MULTI_CONVO:    { USE: true },
  TEMPORARY_CHAT: { USE: true },
  RUN_CODE:       { USE: true },
  WEB_SEARCH:     { USE: true },
  PEOPLE_PICKER:  { VIEW_USERS: true, VIEW_GROUPS: true, VIEW_ROLES: true },
  MARKETPLACE:    { USE: true },
  FILE_SEARCH:    { USE: true },
  FILE_CITATIONS: { USE: true },
  MCP_SERVERS:    { USE: true, CREATE: true, SHARE: true, SHARE_PUBLIC: true },
  REMOTE_AGENTS:  { USE: true, CREATE: true, SHARE: true, SHARE_PUBLIC: true },
};

// ---------- helpers ----------

function flattenPermissions(perms, prefix) {
  const out = {};
  for (const [type, bits] of Object.entries(perms)) {
    for (const [bit, val] of Object.entries(bits)) {
      out[`${prefix}.${type}.${bit}`] = val;
    }
  }
  return out;
}

// ---------- main ----------

const roles = db.getCollection('roles');
const existing = roles.findOne({ name: ROLE_NAME });

if (!existing) {
  roles.insertOne({
    name: ROLE_NAME,
    description: DESCRIPTION,
    permissions: PERMISSIONS,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  print(`✅  Created role "${ROLE_NAME}" with full agent/chat permissions.`);
} else {
  // Role exists — patch any missing or false permission bits.
  const missingBits = flattenPermissions(PERMISSIONS, 'permissions');

  // Keep only bits that are currently missing or false.
  const toSet = {};
  for (const [path, val] of Object.entries(missingBits)) {
    const parts = path.split('.');          // ['permissions', 'AGENTS', 'CREATE']
    let cursor = existing;
    for (const p of parts) cursor = cursor?.[p];
    if (cursor !== true) {
      toSet[path] = val;
    }
  }

  if (Object.keys(toSet).length === 0) {
    print(`ℹ️   Role "${ROLE_NAME}" already exists with all permissions set — nothing to do.`);
  } else {
    roles.updateOne(
      { name: ROLE_NAME },
      { $set: { ...toSet, updatedAt: new Date() } },
    );
    print(`🔧  Role "${ROLE_NAME}" existed but was missing permissions. Patched: ${Object.keys(toSet).join(', ')}`);
  }
}

// Confirm final state
const final = roles.findOne({ name: ROLE_NAME }, { permissions: 1, description: 1 });
print('\nFinal role document:');
printjson(final);
