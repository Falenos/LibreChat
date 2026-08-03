const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('production images provide a sandboxed Chromium artifact renderer', () => {
  assert.match(read('Dockerfile'), /apk add --no-cache jemalloc chromium/);
  assert.match(read('Dockerfile.multi'), /apk add --no-cache jemalloc chromium su-exec/);
  assert.match(read('Dockerfile.multi'), /COPY knauf\/docker\/chromium-wrapper\.sh/);
  assert.equal(
    require('../../packages/knauf/package.json').dependencies['playwright-core'],
    '1.56.1',
  );

  const wrapper = read('knauf/docker/chromium-wrapper.sh');
  assert.match(wrapper, /exec su-exec node/);
  assert.doesNotMatch(wrapper, /--no-sandbox/);
});

test('the slide template exposes a language-independent export contract', () => {
  const skill = read('skill/karl-artifacts/SKILL.md');
  const slides = read('skill/karl-artifacts/references/slides.md');
  assert.match(skill, /data-knauf-export-pages/);
  assert.match(skill, /data-knauf-export-next/);
  assert.match(slides, /data-knauf-export-pages=/);
  assert.match(slides, /data-knauf-export-next/);
});
