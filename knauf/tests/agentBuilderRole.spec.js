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
    updateMany: (_filter, update) => {
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
});
