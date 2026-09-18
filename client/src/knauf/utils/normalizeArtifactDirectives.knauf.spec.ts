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

type Node = {
  type: string;
  name?: string;
  value?: string;
  attributes?: Record<string, string>;
  children?: Node[];
};

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

/** Fenced blocks rendered into the chat — siblings of the artifact, not its children. */
const chatCodeBlocks = (source: string): number =>
  (parse(source).children ?? []).filter((node) => node.type === 'code').length;

/** The fenced blocks the artifact actually holds, in order. */
const artifactFences = (source: string): string[] =>
  (findArtifact(parse(source))?.children ?? [])
    .filter((node) => node.type === 'code')
    .map((node) => node.value ?? '');

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

describe('[knauf] normalizeArtifactDirectives — container closed before the file ended', () => {
  /* Realistic halves: the first chunk leaves the component open, the second closes it. That
   * is the evidence the splice requires — see the guards below for why adjacency alone is
   * deliberately not enough. */
  const HEAD = ['```tsx', 'export default function App() {', '  const rows = [1, 2, 3];', '```'];
  const TAIL = ['```tsx', '  return <div>{rows.length}</div>;', '}', '```'];
  const SPLIT = [OPEN, ...HEAD, CLOSE, ...TAIL].join('\n');

  it('loses the tail to the chat before repair', () => {
    expect(hasArtifact(SPLIT)).toBe(true);
    expect(artifactFences(SPLIT)).toEqual([
      'export default function App() {\n  const rows = [1, 2, 3];',
    ]);
    expect(chatCodeBlocks(SPLIT)).toBe(1);
  });

  it('rejoins the halves into one fenced body', () => {
    const repaired = normalizeArtifactDirectives(SPLIT);

    expect(artifactFences(repaired)).toEqual([
      'export default function App() {\n  const rows = [1, 2, 3];\n  return <div>{rows.length}</div>;\n}',
    ]);
    expect(chatCodeBlocks(repaired)).toBe(0);
  });

  it('rejoins a file broken into three pieces', () => {
    const thrice = [
      OPEN,
      '```tsx',
      'export default function App() {',
      '```',
      CLOSE,
      '```tsx',
      '  const rows = [1, 2, 3];',
      '```',
      CLOSE,
      '```tsx',
      '  return <div>{rows.length}</div>;',
      '}',
      '```',
    ].join('\n');
    const repaired = normalizeArtifactDirectives(thrice);

    expect(artifactFences(repaired)).toEqual([
      'export default function App() {\n  const rows = [1, 2, 3];\n  return <div>{rows.length}</div>;\n}',
    ]);
    expect(chatCodeBlocks(repaired)).toBe(0);
  });

  it('leaves the container open when the spilled half was truncated', () => {
    const truncated = [OPEN, ...HEAD, CLOSE, '```tsx', '  return <div />;', '}'].join('\n');
    const repaired = normalizeArtifactDirectives(truncated);

    expect(hasArtifact(repaired)).toBe(true);
    expect(chatCodeBlocks(repaired)).toBe(0);
  });

  describe('guards', () => {
    /* The review case: a complete artifact followed immediately by a deliberate example in
     * the same language is indistinguishable from a spill by adjacency alone. A finished
     * file has balanced delimiters, which is what tells the two apart. */
    it('leaves an intentional adjacent same-language block in the chat', () => {
      const example = [
        OPEN,
        '```tsx',
        'export default function App() { return null; }',
        '```',
        CLOSE,
        '```tsx',
        '<App />',
        '```',
      ].join('\n');

      expect(normalizeArtifactDirectives(example)).toBe(example);
      expect(chatCodeBlocks(example)).toBe(1);
    });

    it('leaves an adjacent block alone even when the artifact itself was complete', () => {
      const usage = [OPEN, ...BODY, CLOSE, '```tsx', 'render(<App />);', '```'].join('\n');

      expect(normalizeArtifactDirectives(usage)).toBe(usage);
    });

    it('leaves a code block introduced by prose in the chat', () => {
      const explained = [OPEN, ...HEAD, CLOSE, '', 'And a separate helper:', '', ...TAIL].join(
        '\n',
      );

      expect(normalizeArtifactDirectives(explained)).toBe(explained);
      expect(chatCodeBlocks(explained)).toBe(1);
    });

    it('leaves a code block in another language alone', () => {
      const other = [OPEN, ...HEAD, CLOSE, '```css', '.a { color: red; }', '```'].join('\n');

      expect(normalizeArtifactDirectives(other)).toBe(other);
    });

    it('leaves a markdown artifact alone, where a following fence is real content', () => {
      const markdown = [
        ':::artifact{identifier="doc" type="text/markdown" title="Doc"}',
        '```markdown',
        '# Title',
        '```',
        CLOSE,
        '```markdown',
        '## Appendix',
        '```',
      ].join('\n');

      expect(normalizeArtifactDirectives(markdown)).toBe(markdown);
    });

    it('leaves a well-formed artifact followed by nothing untouched', () => {
      expect(normalizeArtifactDirectives(WELL_FORMED)).toBe(WELL_FORMED);
    });

    it('leaves a second, complete artifact alone', () => {
      const two = [
        OPEN,
        ...HEAD,
        CLOSE,
        '',
        ':::artifact{identifier="second" type="application/vnd.react" title="Second"}',
        ...TAIL,
        CLOSE,
      ].join('\n');

      expect(normalizeArtifactDirectives(two)).toBe(two);
    });
  });
});

describe("[knauf] normalizeArtifactDirectives — never rewrites an artifact's own source", () => {
  /* The review case: XML conversion used to be context-blind, so a valid React or HTML file
   * containing an `<artifact>` element on its own line was rewritten into nested directive
   * text — corrupting a file that had rendered correctly. */
  it('leaves an <artifact> element inside a compiled artifact byte-identical', () => {
    const withElement = [
      OPEN,
      '```tsx',
      'export default function App() {',
      '  return (',
      '    <artifact data-kind="card">',
      '      <span>Knauf</span>',
      '    </artifact>',
      '  );',
      '}',
      '```',
      CLOSE,
    ].join('\n');

    expect(normalizeArtifactDirectives(withElement)).toBe(withElement);
    expect(artifactFences(withElement)).toHaveLength(1);
    expect(artifactFences(normalizeArtifactDirectives(withElement))).toHaveLength(1);
  });

  it('leaves an <artifact> element carrying wrapper-like attributes alone inside a fence', () => {
    const quoted = [
      OPEN,
      '```tsx',
      'const sample = `<artifact identifier="x" type="text/html" title="X">`;',
      '```',
      CLOSE,
    ].join('\n');

    expect(normalizeArtifactDirectives(quoted)).toBe(quoted);
  });

  it('leaves a fenced XML example in the chat alone', () => {
    const documented = [
      'The shape the panel does not accept:',
      '',
      '```xml',
      '<artifact identifier="x" type="text/html" title="X">',
      '</artifact>',
      '```',
    ].join('\n');

    expect(normalizeArtifactDirectives(documented)).toBe(documented);
  });

  it('still converts a real XML wrapper at the top level', () => {
    const wrapper = [
      '<artifact identifier="demo" type="application/vnd.react" title="Demo">',
      ...BODY,
      '</artifact>',
    ].join('\n');

    expect(hasArtifact(normalizeArtifactDirectives(wrapper))).toBe(true);
  });

  it('does not convert a custom element that merely shares the name', () => {
    const custom = ['<artifact data-kind="card">', 'content', '</artifact>'].join('\n');

    expect(normalizeArtifactDirectives(custom)).toBe(custom);
  });
});

describe('[knauf] normalizeArtifactDirectives — opening line missing its closing brace', () => {
  /* The review case: joining any line containing `}` swallowed the fence and the first
   * source line into the opening line when the model simply omitted the brace. */
  const MISSING_BRACE = [
    ':::artifact{identifier="demo" type="application/vnd.react"',
    '```tsx',
    'export default function App() {}',
    '```',
    CLOSE,
  ].join('\n');

  it('leaves the fence and the source line intact', () => {
    const result = normalizeArtifactDirectives(MISSING_BRACE);

    expect(result).toBe(MISSING_BRACE);
    expect(result.split('\n')).toContain('```tsx');
    expect(result.split('\n')).toContain('export default function App() {}');
  });

  it('never merges the fence into the opening line at any streaming prefix', () => {
    for (let end = 1; end <= MISSING_BRACE.length; end += 1) {
      const normalized = normalizeArtifactDirectives(MISSING_BRACE.slice(0, end));
      const openingLine = normalized.split('\n')[0];

      expect(openingLine).not.toContain('```');
      expect(openingLine).not.toContain('export default');
    }
  });

  it('still joins a genuine attribute continuation', () => {
    const split = [
      ':::artifact{identifier="demo" type="application/vnd.react"',
      'title="Demo"}',
      ...BODY,
      CLOSE,
    ].join('\n');

    expect(attributesOf(normalizeArtifactDirectives(split))).toEqual({
      identifier: 'demo',
      type: 'application/vnd.react',
      title: 'Demo',
    });
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
