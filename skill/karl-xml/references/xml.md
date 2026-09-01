# XML round-trip reference

KARL parses XML as a document tree and exposes bounded element paths, read-only
attributes, and text nodes containing letters. IDs shaped like `x0` are
temporary identifiers for one parsed file. Paths such as
`/catalog[1]/item[2]/text()[1]` identify their location.

## Safety and fidelity

- Input is limited to 25 MB for structure-aware translation.
- Parsing is bounded to 100,000 nodes, 10,000 editable text segments, and
  500,000 translatable characters.
- Attribute inspection is bounded to 10,000 attributes and 500,000 attribute
  name/value characters.
- DTD and entity declarations are rejected to prevent entity expansion and
  external entity behavior.
- Malformed XML is rejected before inspection or editing.
- Exact replacement is case-sensitive; multiple matches require explicit
  `replace_all`.
- XML-special characters are escaped during serialization.
- Attributes are intentionally excluded because they commonly hold IDs,
  references, language codes, schema values, or executable configuration.

Serialization preserves XML structure and meaning but may normalize equivalent
surface syntax, such as quote style, empty-element syntax, or declaration
formatting. Do not promise byte-identical output.

## Human acceptance

1. Parse the output with the consuming application or schema validator.
2. Confirm requested text and locale are correct.
3. Confirm element and attribute counts and namespace URIs remain expected.
4. Confirm IDs, references, links, and machine-readable values still resolve.
5. Confirm no unintended repeated text was changed.

KARL does not infer or enforce an unknown XML vocabulary's business rules.
