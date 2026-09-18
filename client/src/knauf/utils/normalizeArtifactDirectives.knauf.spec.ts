/**
 * [knauf] KK20-365 — seam test for artifact directive normalization.
 *
 * Asserts against the real parser rather than the output string: each case is parsed with
 * the same `directive()` / `gfm()` extensions `splitMarkdown.ts` uses, and the assertion is
 * that a `containerDirective` named `artifact` now exists. A string-shape assertion would
 * pass on output the tokenizer still rejects.
 *
 * Every failing shape is negative-tested first — `expect(hasArtifact(raw)).toBe(false)` —
 * so a case that stops being a failure upstream fails here loudly instead of passing
 * vacuously. The byte-identity block is the other half: shapes measured as *not* failing
 * must come back untouched, which is what keeps this from becoming a formatter.
 */
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { directive } from 'micromark-extension-directive';
import { directiveFromMarkdown } from 'mdast-util-directive';
import { normalizeArtifactDirectives } from './normalizeArtifactDirectives';

type Node = { type: string; name?: string; attributes?: Record<string, string>; children?: Node[] };

const parse = (source: string): Node =>
  fromMarkdown(source, {
    extensions: [gfm(), directive()],
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()],
  }) as unknown as Node;

const isArtifact = (node: Node): boolean =>
  (node.type === 'containerDirective' || node.type === 'leafDirective') && node.name === 'artifact';

const findArtifact = (node: Node): Node | undefined =>
  isArtifact(node) ? node : (node.children ?? []).map(findArtifact).find(Boolean);

const hasArtifact = (source: string): boolean => findArtifact(parse(source)) != null;
const attributesOf = (source: string) => findArtifact(parse(source))?.attributes;

const OPEN = ':::artifact{identifier="demo" type="application/vnd.react" title="Demo"}';
const BODY = [
  '```tsx',
  'export default function App() {',
  '  return <div>Knauf</div>;',
  '}',
  '```',
];
const CLOSE = ':::';
const WELL_FORMED = [OPEN, ...BODY, CLOSE].join('\n');

const indentBy = (prefix: string) =>
  WELL_FORMED.split('\n')
    .map((line) => prefix + line)
    .join('\n');

/** The shapes measured as failing to tokenize, each repaired by exactly one rewrite. */
const FAILING_SHAPES: Record<string, string> = {
  'indented four spaces': indentBy('    '),
  'indented with a tab': indentBy('\t'),
  'wrapped in a bare fence': ['```', WELL_FORMED, '```'].join('\n'),
  'wrapped in a ```markdown fence': ['```markdown', WELL_FORMED, '```'].join('\n'),
  'an XML artifact tag': [
    '<artifact identifier="demo" type="application/vnd.react" title="Demo">',
    ...BODY,
    '</artifact>',
  ].join('\n'),
  'an opening line split across two lines': [
    ':::artifact{identifier="demo" type="application/vnd.react"',
    'title="Demo"}',
    ...BODY,
    CLOSE,
  ].join('\n'),
  'a space between the colons and the name': [
    `::: artifact${OPEN.slice(':::artifact'.length)}`,
    ...BODY,
    CLOSE,
  ].join('\n'),
  'a non-breaking space before the colons': `\u00A0${WELL_FORMED}`,
};

/** Shapes measured as parsing correctly already. The normalizer must not touch them. */
const ALREADY_VALID: Record<string, string> = {
  'a well-formed block': WELL_FORMED,
  'indented three spaces': indentBy('   '),
  'no closing directive (mid-stream)': [OPEN, ...BODY].join('\n'),
  'a four-colon run': [
    '::::artifact{identifier="demo" type="application/vnd.react" title="Demo"}',
    ...BODY,
    '::::',
  ].join('\n'),
  'unquoted attribute values': [
    ':::artifact{identifier=demo type=application/vnd.react title=Demo}',
    ...BODY,
    CLOSE,
  ].join('\n'),
  'a brace inside the title': [
    ':::artifact{identifier="demo" type="application/vnd.react" title="Demo {beta}"}',
    ...BODY,
    CLOSE,
  ].join('\n'),
  'prose immediately before the block': ['Here you go:', WELL_FORMED].join('\n'),
  'CRLF line endings': WELL_FORMED.split('\n').join('\r\n'),
  'trailing spaces on the directive lines': [`${OPEN}  `, ...BODY, `${CLOSE} `].join('\n'),
  'a markdown artifact with an inner fence': [
    ':::artifact{identifier="doc" type="text/markdown" title="Doc"}',
    '````markdown',
    '# Title',
    '',
    '```js',
    'const a = 1;',
    '```',
    '````',
    CLOSE,
  ].join('\n'),
};

describe('[knauf] normalizeArtifactDirectives — shapes that fail to tokenize', () => {
  it.each(Object.entries(FAILING_SHAPES))(
    'does not parse as an artifact today: %s',
    (_name, source) => {
      expect(hasArtifact(source)).toBe(false);
    },
  );

  it.each(Object.entries(FAILING_SHAPES))(
    'renders as an artifact once normalized: %s',
    (_name, source) => {
      expect(hasArtifact(normalizeArtifactDirectives(source))).toBe(true);
    },
  );

  it.each(Object.entries(FAILING_SHAPES))('recovers the attributes intact: %s', (_name, source) => {
    expect(attributesOf(normalizeArtifactDirectives(source))).toEqual({
      identifier: 'demo',
      type: 'application/vnd.react',
      title: 'Demo',
    });
  });
});

describe('[knauf] normalizeArtifactDirectives — shapes that already parse', () => {
  it.each(Object.entries(ALREADY_VALID))('parses as an artifact today: %s', (_name, source) => {
    expect(hasArtifact(source)).toBe(true);
  });

  it.each(Object.entries(ALREADY_VALID))('is returned byte-identical: %s', (_name, source) => {
    expect(normalizeArtifactDirectives(source)).toBe(source);
  });
});

describe('[knauf] normalizeArtifactDirectives — content fidelity', () => {
  it('preserves the body verbatim when de-indenting', () => {
    const nested = [
      '    :::artifact{identifier="demo" type="application/vnd.react" title="Demo"}',
      '    ```tsx',
      '    export default function App() {',
      '      if (true) {',
      '        return <div>Knauf</div>;',
      '      }',
      '    }',
      '    ```',
      '    :::',
    ].join('\n');

    expect(normalizeArtifactDirectives(nested)).toBe(
      [
        ':::artifact{identifier="demo" type="application/vnd.react" title="Demo"}',
        '```tsx',
        'export default function App() {',
        '  if (true) {',
        '    return <div>Knauf</div>;',
        '  }',
        '}',
        '```',
        ':::',
      ].join('\n'),
    );
  });

  it('straightens curly quotes so the MIME type resolves', () => {
    const curly =
      ':::artifact{identifier=\u201Cdemo\u201D type=\u201Capplication/vnd.react\u201D title=\u201CDemo\u201D}';
    const source = [curly, ...BODY, CLOSE].join('\n');

    expect(attributesOf(source)?.type).toBe('\u201Capplication/vnd.react\u201D');
    expect(attributesOf(normalizeArtifactDirectives(source))?.type).toBe('application/vnd.react');
  });

  it('leaves prose that merely mentions the word artifact untouched', () => {
    const prose = 'The artifact panel opens beside the chat.\n\n```tsx\nconst a = 1;\n```';
    expect(normalizeArtifactDirectives(prose)).toBe(prose);
  });

  it('leaves a lone closing XML tag alone when no open tag preceded it', () => {
    const stray = 'We discussed </artifact> as a syntax the panel does not accept.';
    expect(normalizeArtifactDirectives(stray)).toBe(stray);
  });
});

describe('[knauf] normalizeArtifactDirectives — streaming stability', () => {
  it('never rewrites a prefix that has not yet reached the directive name', () => {
    for (const partial of [':::', ':::art', ':::artifac', '    :::artifa']) {
      expect(normalizeArtifactDirectives(partial)).toBe(partial);
    }
  });

  it('keeps every completed prefix of an indented block stable as it grows', () => {
    const source = indentBy('    ');
    let previous = '';
    for (let end = 1; end <= source.length; end += 1) {
      const normalized = normalizeArtifactDirectives(source.slice(0, end));
      /* Once a line has been emitted and normalized, it must not change shape again —
       * that is what keeps the per-block memoization in MarkdownBlocks.tsx effective. */
      const settled = normalized.split('\n').slice(0, -1).join('\n');
      expect(settled.startsWith(previous)).toBe(true);
      previous = settled;
    }
  });
});
