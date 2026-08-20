// @ts-check
//
// seed-agent-builder-role.js
//
// Deprecated read-only diagnostic retained for operators with existing runbooks.
// The application now creates AGENT_BUILDER and adds missing permission fields
// during startup. Permission values and membership remain owned by the Admin Panel.
//
// Usage:
//   mongosh "<connection-string>" knauf/scripts/seed-agent-builder-role.js

/* global db, printjson */

'use strict';

const ROLE_NAME = 'AGENT_BUILDER';
const roles = db.getCollection('roles');
const matches = roles.find({ name: ROLE_NAME }).toArray();

print(`Read-only diagnostic for "${ROLE_NAME}". No database changes will be made.`);

if (matches.length === 0) {
  print('Role not found. Restart the application so startup initialization can create it.');
} else {
  print(`Found ${matches.length} role document(s).`);
  for (const role of matches) {
    const scope = role.tenantId ?? '<base>';
    print(`\n_id=${role._id}, tenantId=${scope}`);
    if (role.tenantId == null && role.permissions?.SKILLS?.USE === undefined) {
      print('WARNING: base role is missing SKILLS.USE; restart the application to reconcile it.');
    }
    printjson(role.permissions ?? {});
  }
}

print('\nUse Admin Panel -> Roles to change permissions or membership.');
