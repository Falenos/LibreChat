/**
 * [knauf] KK20-365 — seam test for the normalizer mount in `Markdown.tsx`.
 *
 * `normalizeArtifactDirectives.knauf.spec.ts` proves the repair; this proves it is wired
 * in. Without a test at this level the seam is decorative: deleting the call from
 * `Markdown.tsx` leaves the util's own suite green while every one of these shapes goes
 * back to printing its source into the conversation.
 *
 * Renders the real `Markdown` component and stubs only `ArtifactButton`, so an assertion
 * here means the directive actually tokenized and `<Artifact>` mounted — the same harness
 * `MarkdownBlocks.artifacts.test.tsx` uses.
 *
 * `CodeBlock` is stubbed the way upstream's own `MarkdownBlocks.test.tsx` stubs it — the
 * real one does not terminate under jsdom here. An artifact's own fence never reaches it
 * (`Artifact` renders `ArtifactButton` and never renders its children), but the negative
 * case below deliberately does render ordinary fenced code, which is the whole point of it.
 */
import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { MessageContext } from '~/Providers';

jest.mock('~/components/Messages/Content/CodeBlock', () => ({
  __esModule: true,
  default: ({ lang }: { lang?: string }) => <div data-testid="cb" data-lang={String(lang)} />,
}));

jest.mock('~/components/Artifacts/ArtifactButton', () => ({
  __esModule: true,
  default: ({ artifact }: { artifact?: { identifier?: string; type?: string } }) => (
    <div
      data-testid="art"
      data-id={String(artifact?.identifier)}
      data-type={String(artifact?.type)}
    />
  ),
}));

const OPEN = ':::artifact{identifier="demo" type="application/vnd.react" title="Demo"}';
const BODY = [
  '```tsx',
  'export default function App() {',
  '  return <div>Knauf</div>;',
  '}',
  '```',
];
const WELL_FORMED = [OPEN, ...BODY, ':::'].join('\n');

const indentBy = (prefix: string) =>
  WELL_FORMED.split('\n')
    .map((line) => prefix + line)
    .join('\n');

/** The emission shapes that do not tokenize without the mounted normalizer. */
const SHAPES: Record<string, string> = {
  'indented four spaces': indentBy('    '),
  'indented with a tab': indentBy('\t'),
  'wrapped in a fence': ['```', WELL_FORMED, '```'].join('\n'),
  'an XML artifact tag': [
    '<artifact identifier="demo" type="application/vnd.react" title="Demo">',
    ...BODY,
    '</artifact>',
  ].join('\n'),
  'an opening line split across two lines': [
    ':::artifact{identifier="demo" type="application/vnd.react"',
    'title="Demo"}',
    ...BODY,
    ':::',
  ].join('\n'),
  'a space after the colons': [
    `::: artifact${OPEN.slice(':::artifact'.length)}`,
    ...BODY,
    ':::',
  ].join('\n'),
  'a non-breaking space before the colons': `\u00A0${WELL_FORMED}`,
};

const wrap = (ui: React.ReactNode) => (
  <MemoryRouter>
    <RecoilRoot>
      <MessageContext.Provider value={{ messageId: 'm1', isExpanded: true }}>
        {ui}
      </MessageContext.Provider>
    </RecoilRoot>
  </MemoryRouter>
);

const renderMarkdown = (content: string) =>
  render(wrap(<Markdown content={content} isLatestMessage={false} />));

describe('[knauf] Markdown — artifact directive normalization is mounted', () => {
  it.each(Object.entries(SHAPES))('mounts an artifact for %s', async (_name, content) => {
    renderMarkdown(content);

    const rendered = await screen.findAllByTestId('art');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toHaveAttribute('data-id', 'demo');
    expect(rendered[0]).toHaveAttribute('data-type', 'application/vnd.react');
  });

  it('resolves the MIME type when the model used curly quotes', async () => {
    const curly =
      ':::artifact{identifier=\u201Cdemo\u201D type=\u201Capplication/vnd.react\u201D title=\u201CDemo\u201D}';
    renderMarkdown([curly, ...BODY, ':::'].join('\n'));

    expect(await screen.findByTestId('art')).toHaveAttribute('data-type', 'application/vnd.react');
  });

  it('still mounts a well-formed artifact unchanged', async () => {
    renderMarkdown(WELL_FORMED);

    expect(await screen.findByTestId('art')).toHaveAttribute('data-id', 'demo');
  });

  it('does not invent an artifact from prose that merely names one', () => {
    renderMarkdown('The artifact opens in the preview panel beside the chat.');

    expect(screen.queryByTestId('art')).not.toBeInTheDocument();
  });

  it('leaves ordinary fenced code as a code block', async () => {
    renderMarkdown('Here is the helper:\n\n```tsx\nconst a = 1;\n```');

    expect(await screen.findByTestId('cb')).toHaveAttribute('data-lang', 'tsx');
    expect(screen.queryByTestId('art')).not.toBeInTheDocument();
  });

  it('rejoins an artifact whose container closed before the file ended', async () => {
    renderMarkdown(
      [
        OPEN,
        '```tsx',
        'export default function App() {',
        '```',
        ':::',
        '```tsx',
        '  return <div />;',
        '}',
        '```',
      ].join('\n'),
    );

    expect(await screen.findByTestId('art')).toHaveAttribute('data-id', 'demo');
    /* The tail used to render here as a chat code block, which is what the user sees as
     * "the panel fills partway and the rest continues in the conversation". */
    expect(screen.queryByTestId('cb')).not.toBeInTheDocument();
  });

  it('still shows a code block the model introduced with prose', async () => {
    renderMarkdown(
      [
        OPEN,
        '```tsx',
        'export default function App() {',
        '```',
        ':::',
        '',
        'And a helper:',
        '',
        '```tsx',
        '  return <div />;',
        '}',
        '```',
      ].join('\n'),
    );

    expect(await screen.findByTestId('art')).toHaveAttribute('data-id', 'demo');
    expect(await screen.findByTestId('cb')).toHaveAttribute('data-lang', 'tsx');
  });

  it('still shows an intentional example block after a complete artifact', async () => {
    renderMarkdown(
      [
        OPEN,
        '```tsx',
        'export default function App() { return null; }',
        '```',
        ':::',
        '```tsx',
        '<App />',
        '```',
      ].join('\n'),
    );

    expect(await screen.findByTestId('art')).toHaveAttribute('data-id', 'demo');
    expect(await screen.findByTestId('cb')).toHaveAttribute('data-lang', 'tsx');
  });

  it('leaves an <artifact> element in the artifact source untouched', async () => {
    renderMarkdown(
      [
        OPEN,
        '```tsx',
        'export default function App() {',
        '  return <artifact data-kind="card">Knauf</artifact>;',
        '}',
        '```',
        ':::',
      ].join('\n'),
    );

    const rendered = await screen.findAllByTestId('art');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toHaveAttribute('data-type', 'application/vnd.react');
  });

  it('does not mount an artifact for a differently-named container directive', () => {
    renderMarkdown([':::note{title="Heads up"}', 'Not an artifact.', ':::'].join('\n'));

    expect(screen.queryByTestId('art')).not.toBeInTheDocument();
  });
});
