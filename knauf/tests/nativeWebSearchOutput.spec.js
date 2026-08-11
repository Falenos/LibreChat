const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  getFinalWebSearchResponseText,
  hasNativeWebSearchTool,
  replaceLastTextPart,
  shouldStreamNativeWebSearchDelta,
} = require('../../api/server/knauf/nativeWebSearchOutput');

test('persists only the authoritative final-answer phase after native web search', () => {
  const responseOutput = [
    { type: 'web_search_call', id: 'ws_1', status: 'completed' },
    {
      type: 'message',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'First draft with broken citation.' }],
    },
    {
      type: 'message',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'The final answer with one citation.' }],
    },
  ];
  const streamedParts = [
    { type: 'think', think: 'Searching official sources.' },
    {
      type: 'text',
      text: 'First draft with broken citation.The final answer with one citation.',
    },
  ];

  const finalText = getFinalWebSearchResponseText(responseOutput);

  assert.equal(finalText, 'The final answer with one citation.');
  assert.deepEqual(replaceLastTextPart(streamedParts, finalText), [
    streamedParts[0],
    { type: 'text', text: 'The final answer with one citation.' },
  ]);
});

test('does not rewrite ordinary Responses output', () => {
  assert.equal(
    getFinalWebSearchResponseText([
      {
        type: 'message',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Ordinary answer.' }],
      },
    ]),
    '',
  );
});

test('defers visible deltas only when a native web-search tool is configured', () => {
  assert.equal(
    hasNativeWebSearchTool([
      { tools: [{ type: 'function' }] },
      { tools: [{ type: 'web_search', user_location: { timezone: 'Europe/Berlin' } }] },
    ]),
    true,
  );
  assert.equal(hasNativeWebSearchTool([{ tools: [{ type: 'function' }] }]), false);
  assert.equal(shouldStreamNativeWebSearchDelta({ deferDeltas: true }), false);
  assert.equal(shouldStreamNativeWebSearchDelta({ deferDeltas: false }), true);
});

test('Karl instructions require valid Markdown section headings', () => {
  const config = fs.readFileSync(path.resolve(__dirname, '../../librechat.yaml'), 'utf8');

  assert.match(config, /valid GitHub-Flavored Markdown/);
  assert.match(config, /use `###` headings/);
});
