# IDML round-trip reference

IDML is a ZIP package. User-visible story text is primarily stored in
`Stories/Story_*.xml` `<Content>` nodes. `designmap.xml`, styles, resources,
links, spreads, and other package entries carry structure and layout.

KARL's IDML tools validate the package before use: required uncompressed
`mimetype` first entry, safe paths, bounded entry and expanded sizes, valid XML,
no DTD/entities, and bounded story/segment counts.

## Safe text operations

- Inspection returns IDs shaped like `s0-c12`, or `s0-c12-p1` when an Adobe
  inline control divides one `<Content>` node into structural text parts. They
  identify text in the currently parsed file, not permanent InDesign IDs.
- Exact replacement is case-sensitive and can change a substring inside one
  segment. Multiple matches require explicit `replace_all`.
- Segment editing replaces the entire visible segment. Empty text removes it.
- XML-special characters are escaped during rebuild.
- Export verifies every non-story entry against its source hash and parses every
  rebuilt story XML file before returning the result.

## Human acceptance

Open each output in Adobe InDesign and confirm:

1. The IDML opens without a repair warning.
2. Requested text is correct and no unintended occurrence changed.
3. Fonts and styles resolve as expected.
4. No text frame shows overset text.
5. Tables, callouts, anchored objects, links, and page breaks remain acceptable.
6. Save an INDD copy only after the review passes.

No visual preview or automatic layout validation is provided by KARL.
