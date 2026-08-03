const assert = require('node:assert/strict');
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
