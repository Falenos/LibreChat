# Building a deck

Depth for `karl-pptx`. Every example runs inside one `execute_code` call that
starts with:

```python
import sys; sys.path.insert(0, '/mnt/data/karl-pptx/scripts')
from karl_pptx import KnaufDeck
deck = KnaufDeck('Deck title', footer_label='Team · Internal')
```

`footer_label` appears bottom-left on every content slide; it defaults to the title.

## Slide types

| Method | Use for | Limits |
|---|---|---|
| `title_slide(title, subtitle=None)` | The opening slide: blue field, white wordmark | Title up to ~6 words |
| `section_slide(title, kicker=None)` | Dividers between parts; `kicker` is a small line above ("Part 2") | One per part |
| `bullets_slide(heading, bullets, size=20)` | A short list. `bullets` are strings or `(text, 1)` for one nested level | ≤ 6 bullets, one line each |
| `two_column_slide(heading, left, right)` | Comparison or text beside a picture. Each side is a list of bullets or an image path | ≤ 4 bullets a side |
| `kpi_slide(heading, kpis)` | Headline numbers. `kpis` = up to four `(value, label)` pairs | Value ≤ 7 characters |
| `chart_slide(heading, categories, series, kind='column', number_format='General', legend=None)` | A native chart (below) | ≤ 12 categories, ≤ 5 series |
| `table_slide(heading, rows, col_widths_in=None)` | A small table; first row is the header | ≤ 7 rows × 5 columns |
| `image_slide(heading, path, caption=None)` | A picture or matplotlib figure, fitted without stretching | PNG/JPEG |
| `statement_slide(statement, attribution=None)` | One sentence that should land: a quote, a decision | ≤ 20 words |
| `closing_slide(message='Thank you', contact=None)` | The last slide | — |

Every method takes `notes='…'` for speaker notes: put the explanation there and keep
the slide short. Anything larger than the limits belongs on two slides, or in an
appendix section after the closing slide.

Content slides are 13.33 × 7.5 in (16:9). The heading sits at the top, the body area
runs from 1.6 in to about 6.6 in, and the footer row is reserved. For a custom shape,
work on `deck.prs` (the python-pptx `Presentation`) and keep inside that body area;
`deck.prs.slides[-1]` is the slide just added.

## Charts

`series` is an ordered dict of name → values, one value per category:

```python
deck.chart_slide('Revenue by region (EUR m)', ['DACH', 'Nordics', 'Iberia'],
                 {'2025': [12.4, 4.1, 3.0], '2026': [13.8, 4.6, 3.1]},
                 kind='column', number_format='0.0')
```

- `kind`: `column` (default), `bar` (long category names), `line` (time), `pie`
  (shares of one whole, ≤ 5 slices), `stacked` (parts of a total).
- Series colours follow the Knauf categorical order; values are labelled on the bars;
  the legend appears when there is more than one series. `number_format` is an Excel
  format: `'0%'` for fractions shown as percent, `'#,##0'` for thousands.
- Put the unit in the heading or the category, since the chart has no title of its own.
- The chart is editable in PowerPoint (right-click → Edit Data). Prefer it to a
  picture of a chart. Use `image_slide` with a matplotlib PNG only for chart types
  PowerPoint lacks (heatmaps, maps); brand the figure per
  `skills/karl-brand/references/charts.md`.

## Writing the slides

- The heading carries the message: "Scrap fell 0.6 points after the L2 retool", not
  "Scrap".
- Parallel bullets: same grammatical form, no full stops, no sub-bullets unless
  essential.
- One chart or one table per slide; never both.
- Ten to fifteen slides for a 20-minute talk. Title, agenda (optional), sections,
  a summary slide with the decisions or asks, closing.

## Fonts

Knauf Screen Head for headings and Knauf Screen for text when karl-brand's fonts are
installed. A `.pptx` names its fonts but cannot carry them, so a recipient without
them sees a substitute and long headings may wrap. When the look must be exact
(sending outside Knauf, printing), deliver `to-pdf` as well.
