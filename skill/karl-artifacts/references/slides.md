# Slide decks: data only

Use the platform slide renderer. Do not recreate navigation, headers, theming,
layout, page counters, keyboard controls, or export attributes in the artifact.

```tsx
import { KnaufSlideDeck } from '/knauf/slides';

const SLIDES = [
  {
    type: 'title',
    eyebrow: 'Technology briefing',
    title: 'Retrieval-Augmented Generation',
    subtitle: 'Grounding generative AI in trusted, current knowledge',
  },
  {
    type: 'process',
    title: 'How RAG works',
    steps: [
      { title: 'Retrieve', text: 'Find passages relevant to the user question.' },
      { title: 'Augment', text: 'Add the passages to the model context.' },
      { title: 'Generate', text: 'Answer from the supplied evidence.' },
    ],
  },
  {
    type: 'columns',
    title: 'Why teams use RAG',
    columns: [
      { title: 'Benefits', items: ['Current information', 'Traceable sources', 'Domain relevance'] },
      { title: 'Controls', items: ['Access filtering', 'Retrieval evaluation', 'Citation checks'] },
    ],
    sources: [
      { text: 'AWS: What is RAG?', href: 'https://aws.amazon.com/what-is/retrieval-augmented-generation/' },
    ],
  },
];

export default function Presentation() {
  return <KnaufSlideDeck slides={SLIDES} deckLabel="RAG briefing" />;
}
```

## Supported layouts

| `type` | Data |
|---|---|
| `title` | `title`, optional `subtitle`, optional `eyebrow` |
| `section` | `title`, optional `subtitle` |
| `bullets` | `title`, `items` |
| `columns` | `title`, `columns: [{ title, items }]` |
| `process` | `title`, `steps: [{ title, text }]` |
| `chart` | `title`, `data`, `categoryKey`, `series: [{ key, label }]`, optional `subtitle` |

`items` can contain plain strings or `{ text, href }` link objects. Any non-title
slide can also carry `sources: [{ text, href }]`.

## Required postconditions

- The `SLIDES` array length equals the requested page count exactly.
- Every requested page is one entry in that array. Never hide pages with
  `display: none`.
- The root has no required props. Pass all content into `KnaufSlideDeck`.
- Links are `{ text, href }` objects. Never put Markdown `[label](url)` syntax in
  TSX strings or JSX text.
- Keep slide copy concise: one idea per page, short headings, at most five bullets,
  and no paragraph-shaped bullets.
- Do not import cards, brand primitives, navigation icons, or chart components for
  a standard deck. `/knauf/slides` already owns them.
- Do not add or rename export attributes. `/knauf/slides` owns PDF/PNG pagination.
- If the user asks for a genuinely custom interaction that the layouts cannot
  express, keep `KnaufSlideDeck` for the deck and simplify the content. A fully
  custom renderer is the last resort, not the default.
