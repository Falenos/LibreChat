const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  getFinalWebSearchResponseText,
  replaceLastTextPart,
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
    { type: 'text', text: 'First draft with broken citation.' },
    { type: 'text', text: 'The final answer with one citation.' },
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

test('Karl instructions require valid Markdown section headings', () => {
  const config = fs.readFileSync(path.resolve(__dirname, '../../librechat.yaml'), 'utf8');

  assert.match(config, /valid GitHub-Flavored Markdown/);
  assert.match(config, /use `###` headings/);
});

test('Karl bounds routed output without provider-specific verbosity', () => {
  const config = fs.readFileSync(path.resolve(__dirname, '../../librechat.yaml'), 'utf8');

  assert.match(config, /maxTokens: 8192/);
  assert.doesNotMatch(config, /^\s*verbosity:/m);
});

test('Karl searches only when needed and suppresses pre-search drafts', () => {
  const config = fs.readFileSync(path.resolve(__dirname, '../../librechat.yaml'), 'utf8');

  assert.match(config, /Do not use web search for stable facts, definitions, or explanations/i);
  assert.match(config, /Web search does not increase the response-length budget/i);
  assert.match(config, /complete all search calls before emitting any user-visible text/i);
});
