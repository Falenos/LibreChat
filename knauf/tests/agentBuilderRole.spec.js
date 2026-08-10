const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('the Agent Builder role can create public artifact links', () => {
  let role = { name: 'AGENT_BUILDER', permissions: {} };
  const roles = {
    find: () => ({ toArray: () => [role] }),
    insertOne: () => {
      throw new Error('Expected the existing role to be updated');
    },
    updateOne: (_filter, update) => {
      role = { ...role, ...update.$set };
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../scripts/seed-agent-builder-role.js'), 'utf8'),
    {
      db: { getCollection: () => roles },
      print: () => undefined,
      printjson: () => undefined,
    },
  );

  assert.equal(role.permissions.SHARED_LINKS.CREATE, true);
  assert.equal(role.permissions.SHARED_LINKS.SHARE, true);
  assert.equal(role.permissions.SHARED_LINKS.SHARE_PUBLIC, true);
  assert.equal(role.permissions.PROMPTS, undefined);
  assert.equal(role.permissions.PEOPLE_PICKER, undefined);
});

test('the Agent Builder seeder preserves Admin-managed prompt sharing permissions', () => {
  let role = {
    _id: 'agent-builder-role',
    name: 'AGENT_BUILDER',
    permissions: {
      PROMPTS: { USE: false, CREATE: false, SHARE: false, SHARE_PUBLIC: true },
      PEOPLE_PICKER: { VIEW_USERS: false, VIEW_GROUPS: true, VIEW_ROLES: true },
    },
  };
  const roles = {
    find: () => ({ toArray: () => [role] }),
    insertOne: () => {
      throw new Error('Expected the existing role to be updated');
    },
    updateOne: (_filter, update) => {
      role = { ...role, ...update.$set };
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../scripts/seed-agent-builder-role.js'), 'utf8'),
    {
      db: { getCollection: () => roles },
      print: () => undefined,
      printjson: () => undefined,
    },
  );

  assert.deepEqual(role.permissions.PROMPTS, {
    USE: false,
    CREATE: false,
    SHARE: false,
    SHARE_PUBLIC: true,
  });
  assert.deepEqual(role.permissions.PEOPLE_PICKER, {
    VIEW_USERS: false,
    VIEW_GROUPS: true,
    VIEW_ROLES: true,
  });
});
