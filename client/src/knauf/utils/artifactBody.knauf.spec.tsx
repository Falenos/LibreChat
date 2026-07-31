/**
 * [knauf] KK20-252 — seam test for single-file artifact body extraction.
 *
 * The two failures this exists to stop, both reproduced below verbatim from the
 * Sandpack overlays:
 *
 *     <!-- Tabs and Cards come from shadcn/ui; no external fetch, all UI static -->
 *     <!-- Optional: include this in your page if you're hosting standalone -->
 *     <style> ... </style>
 *
 * Each was appended after the component's closing brace, concatenated into App.tsx
 * by `extractContent`, and threw `Unexpected token` at the line where it started.
 *
 * The children shapes here mirror what react-markdown hands the `artifact`
 * component: a fenced code block is `<pre><code>…</code></pre>` (there is no `pre`
 * entry in `getMarkdownComponents()`, so it stays an intrinsic tag), and trailing
 * raw HTML arrives as sibling strings.
 */
import React from 'react';
import { extractArtifactBody, extractSharedArtifactBody } from './artifactBody';

const CODE = 'export default function App() {\n  return <div>Knauf</div>;\n}';

/** A fenced code block as react-markdown renders it. */
const codeBlock = (code = CODE) =>
  React.createElement('pre', { key: 'c' }, React.createElement('code', {}, code));

describe('[knauf] extractArtifactBody', () => {
  it('drops an HTML comment and style block appended after the component', () => {
    const children = [
      codeBlock(),
      "<!-- Optional: include this in your page if you're hosting standalone -->",
      '<style>\n  /* Add any additional styles here */\n</style>',
    ];
    expect(extractArtifactBody(children, 'application/vnd.react')).toBe(CODE);
  });

  it('drops the shadcn disclosure comment from the first reported failure', () => {
    const children = [
      codeBlock(),
      '<!-- Tabs and Cards come from shadcn/ui; no external fetch, all UI static -->',
      'Note: This is a simplified **dummy presentation**.',
    ];
    const out = extractArtifactBody(children, 'application/vnd.react');
    expect(out).toBe(CODE);
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('Note:');
  });

  it('is a no-op on a well-formed artifact', () => {
    // The common case: exactly one fenced block. Must return byte-identical
    // content to the upstream concatenation, or this changes working artifacts.
    expect(extractArtifactBody([codeBlock()], 'application/vnd.react')).toBe(CODE);
    expect(extractArtifactBody(codeBlock(), 'application/vnd.react')).toBe(CODE);
  });

  it('keeps prose and every code sample in a markdown artifact', () => {
    // A markdown artifact is a document. Filtering to the first code block here
    // would silently delete most of it.
    const children = [
      React.createElement('p', { key: 'a' }, '# Q3 review'),
      codeBlock('const a = 1;'),
      React.createElement('p', { key: 'b' }, 'Then the second step.'),
      codeBlock('const b = 2;'),
    ];
    const out = extractArtifactBody(children, 'text/markdown');
    expect(out).toContain('# Q3 review');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('Then the second step.');
    expect(out).toContain('const b = 2;');
  });

  it('falls open when there is no code block yet', () => {
    // Mid-stream, before the fence opens: return what upstream would have.
    const children = ['Here is the deck.'];
    expect(extractArtifactBody(children, 'application/vnd.react')).toBe('Here is the deck.');
  });

  it('falls open for an unknown or missing type', () => {
    expect(extractArtifactBody([codeBlock(), 'trailing'], 'unknown')).toBe(CODE + 'trailing');
    expect(extractArtifactBody([codeBlock(), 'trailing'], undefined)).toBe(CODE + 'trailing');
  });

  it('applies to every compiled type, not just react', () => {
    for (const type of ['text/html', 'image/svg+xml', 'application/vnd.mermaid']) {
      expect(extractArtifactBody([codeBlock(), '<!-- note -->'], type)).toBe(CODE);
    }
  });

  it('takes the first code block when the model emits two', () => {
    // Upstream and the KARL prompt both define an artifact as exactly one fence.
    const children = [codeBlock(), codeBlock('const stray = true;')];
    expect(extractArtifactBody(children, 'application/vnd.react')).toBe(CODE);
  });
});

describe('[knauf] extractSharedArtifactBody', () => {
  it('returns only source from a persisted fenced React snapshot', () => {
    const persisted = `\`\`\`tsx
${CODE}
\`\`\`
A clean, branded summary with citations that must not compile.`;

    expect(extractSharedArtifactBody(persisted, 'application/vnd.react')).toBe(CODE);
  });
});
