const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('the deprecated Agent Builder script is read-only', () => {
  const output = [];
  const role = { _id: 'role-1', name: 'AGENT_BUILDER', permissions: {} };
  const roles = {
    find: () => ({ toArray: () => [role] }),
    insertOne: () => assert.fail('Diagnostic must not insert roles'),
    updateOne: () => assert.fail('Diagnostic must not update roles'),
  };
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../scripts/seed-agent-builder-role.js'), 'utf8'),
    {
      db: { getCollection: () => roles },
      print: (message) => output.push(message),
      printjson: () => undefined,
    },
  );

  assert.match(output.join('\n'), /Read-only diagnostic/);
  assert.match(output.join('\n'), /missing SKILLS\.USE/);
  assert.match(output.join('\n'), /restart the application/);
});

test('the diagnostic directs operators to startup when the role is absent', () => {
  const output = [];
  const roles = {
    find: () => ({ toArray: () => [] }),
  };
  vm.runInNewContext(
    fs.readFileSync(path.resolve(__dirname, '../scripts/seed-agent-builder-role.js'), 'utf8'),
    {
      db: { getCollection: () => roles },
      print: (message) => output.push(message),
      printjson: () => undefined,
    },
  );

  assert.match(output.join('\n'), /Role not found/);
  assert.match(output.join('\n'), /startup initialization can create it/);
});
