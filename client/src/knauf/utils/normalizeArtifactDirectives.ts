/**
 * [knauf] KK20-365 — repair near-miss artifact emissions before the parser sees them.
 *
 * ## The failure
 *
 * An artifact reaches the preview panel only if `:::artifact{…}` tokenizes as an mdast
 * `containerDirective` (`remarkDirective` → `artifactPlugin`, wired in
 * `markdownConfig.ts`). When it does not, nothing renders as an artifact: the block
 * degrades to a `code` or `html` node and the source is printed into the conversation.
 * Nothing catches this. `ArtifactRepairButton` keys off `sandpack.error`, and Sandpack
 * never mounts, so there is no error, no repair affordance and no log line — the user
 * simply sees KARL answer with a wall of source.
 *
 * Eight emission shapes were run through this repo's own parser stack (`fromMarkdown`
 * with the same `directive()` / `gfm()` extensions `splitMarkdown.ts` uses). These fail:
 *
 *   - the block indented by four or more spaces, or by a tab (e.g. carried along by a
 *     numbered list the model was writing) — becomes a fenced code block;
 *   - the whole block wrapped in a ``` fence;
 *   - an XML `<artifact …>` tag instead of the directive — becomes an `html` node, which
 *     additionally trips the `requiresWholeMessage` fallback in `splitMarkdown.ts`;
 *   - the opening line split across two lines before its closing brace;
 *   - `::: artifact` with a space after the colons;
 *   - a non-breaking or zero-width space in front of the colons.
 *
 * A ninth shape parses but mis-renders: curly quotes around the attribute values leave
 * `type` as `“application/vnd.react”`, which matches no entry in `artifactFilename`, so
 * the sandbox silently picks the default HTML template for a React artifact.
 *
 * ## Why this is a code fix and not a prompt fix
 *
 * The `&karl_prompt` anchor already spends roughly two pages on artifact rules, several
 * of them added by KK20-252 after five prompt revisions each moved the failure rather
 * than removing it. A rule can be misread; a normalizer cannot. This is the floor under
 * the prompt, not a replacement for it.
 *
 * ## Why it is safe
 *
 * Every rewrite below is conditional on a complete `:::artifact` (or `<artifact`) token
 * already being present, so a completed streaming prefix never changes shape again and
 * the per-block memoization in `MarkdownBlocks.tsx` still holds. Input that already
 * parses is returned byte-identical — verified in the spec against the shapes that were
 * measured as *not* failing (three-space indent, a missing closing `:::`, `::::artifact`,
 * unquoted attribute values, CRLF, trailing spaces, a `}` inside the title, and inner
 * three-backtick fences in a `text/markdown` artifact). Anything unrecognised is passed
 * through untouched: rendering what upstream would have rendered is always recoverable.
 */

/** Spaces, tabs, and the invisible characters models occasionally emit before a directive. */
const NOISE_CLASS = ' \\t\\u00A0\\u2000-\\u200D\\uFEFF';

/** An artifact opening line, however mangled. Captures indent, colon run, and attributes. */
const OPENING_LINE = new RegExp(`^([${NOISE_CLASS}]*)(:{3,})[ \\t]*artifact\\b(.*)$`);
/** A directive-closing line: a bare colon run. */
const CLOSING_LINE = new RegExp(`^[${NOISE_CLASS}]*:{3,}[ \\t]*\\r?$`);
/** A fenced code block delimiter, with an optional info string. */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})[^\r\n`~]*\r?$/;
const BLANK_LINE = /^[ \t]*\r?$/;
const XML_OPEN = /^[ \t]*<artifact\b([^>]*?)\/?>[ \t]*\r?$/;
const XML_CLOSE = /^[ \t]*<\/artifact[ \t]*>[ \t]*\r?$/;

const NOISE_CHARS = new RegExp(`[${NOISE_CLASS}]`);

/** Maximum lines joined when repairing an opening line split before its closing brace. */
const MAX_JOINED_OPENING_LINES = 3;

/** Straight-quote an attribute block so `type` matches the MIME map in `utils/artifacts.ts`. */
const straightenQuotes = (attributes: string): string =>
  attributes.replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'");

/** Remove at most `max` leading whitespace characters — never more than are actually there,
 *  so a body line's own indentation survives and relative indentation is preserved. */
function dedentLine(line: string, max: number): string {
  let index = 0;
  while (index < max && index < line.length && NOISE_CHARS.test(line[index])) {
    index += 1;
  }
  return index === 0 ? line : line.slice(index);
}

/** Index of the next line that is not blank, or -1. */
function nextContentLine(lines: string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    if (!BLANK_LINE.test(lines[index])) {
      return index;
    }
  }
  return -1;
}

/** Index of the previous line that is not blank, or -1. */
function previousContentLine(lines: string[], from: number): number {
  for (let index = from; index >= 0; index -= 1) {
    if (!BLANK_LINE.test(lines[index])) {
      return index;
    }
  }
  return -1;
}

/**
 * Rewrite an XML-style `<artifact …>` / `</artifact>` pair into directive form. The close
 * is only rewritten once an open has been seen, so a stray `</artifact>` in prose is left
 * alone. An unclosed open is still converted — the tokenizer handles an unclosed container
 * gracefully, which is what makes streaming work.
 */
function convertXmlTags(lines: string[]): string[] {
  let isOpen = false;
  let changed = false;
  const result = lines.map((line) => {
    const open = XML_OPEN.exec(line);
    if (open) {
      isOpen = true;
      changed = true;
      return `:::artifact{${straightenQuotes(open[1]).trim()}}`;
    }
    if (isOpen && XML_CLOSE.test(line)) {
      isOpen = false;
      changed = true;
      return ':::';
    }
    return line;
  });
  return changed ? result : lines;
}

/**
 * Drop the pair of fence lines wrapping an entire artifact block. Deliberately removes
 * only the two wrapper lines rather than unwrapping the fenced region wholesale: the
 * artifact's own fence sits inside, and an outer ``` is closed by the first inner ```, so
 * treating the fenced region as one unit would splice the block apart.
 *
 * Requires both ends to match — a fence immediately followed by an artifact opening, and a
 * later fence of at least the same length immediately preceded by the closing `:::`.
 */
function unwrapFenceWrapper(lines: string[]): string[] {
  for (let index = 0; index < lines.length; index += 1) {
    const fence = FENCE_LINE.exec(lines[index]);
    if (!fence) {
      continue;
    }
    const opening = nextContentLine(lines, index + 1);
    if (opening === -1 || !OPENING_LINE.test(lines[opening])) {
      continue;
    }
    for (let end = lines.length - 1; end > opening; end -= 1) {
      const closingFence = FENCE_LINE.exec(lines[end]);
      if (!closingFence || closingFence[1].length < fence[1].length) {
        continue;
      }
      const beforeFence = previousContentLine(lines, end - 1);
      if (beforeFence === -1 || !CLOSING_LINE.test(lines[beforeFence])) {
        continue;
      }
      const result = lines.slice();
      result.splice(end, 1);
      result.splice(index, 1);
      return result;
    }
  }
  return lines;
}

/** Column width of a leading-whitespace run, counting a tab to the next four-column stop —
 *  the same accounting CommonMark uses to decide whether a line is an indented code block. */
function indentWidth(indent: string): number {
  let width = 0;
  for (const character of indent) {
    width = character === '\t' ? width + 4 - (width % 4) : width + 1;
  }
  return width;
}

/** Length of a line's leading whitespace run. */
function noiseLength(line: string): number {
  let index = 0;
  while (index < line.length && NOISE_CHARS.test(line[index])) {
    index += 1;
  }
  return index;
}

/**
 * Canonicalize each artifact block: no space after the colons, straight-quoted attributes,
 * an opening line split before its closing brace rejoined, and — only when the indentation
 * is what breaks the directive — the whole block shifted back to column zero.
 *
 * One to three plain spaces tokenize correctly, so they are left exactly as written; this
 * repairs, it does not format. The colon run length is preserved rather than forced to
 * three, so a `::::artifact` block keeps matching its own `::::` close.
 */
function normalizeBlocks(lines: string[]): string[] {
  const result = lines.slice();
  let changed = false;

  for (let index = 0; index < result.length; index += 1) {
    const opening = OPENING_LINE.exec(result[index]);
    if (!opening) {
      continue;
    }
    const [, indent, colons] = opening;
    let attributes = straightenQuotes(opening[3]);

    /* An opening line split before its closing brace: rejoin, bounded, and only when a
     * brace was actually opened. Mid-stream the continuation may not have arrived yet, in
     * which case nothing is joined and the unclosed container renders as it would anyway. */
    if (attributes.trimEnd().startsWith('{') && !attributes.includes('}')) {
      for (let span = 1; span <= MAX_JOINED_OPENING_LINES; span += 1) {
        const continuation = result[index + span];
        if (continuation == null || BLANK_LINE.test(continuation)) {
          break;
        }
        attributes = `${attributes.trimEnd()} ${straightenQuotes(continuation).trim()}`;
        if (continuation.includes('}')) {
          result.splice(index + 1, span);
          changed = true;
          break;
        }
      }
    }

    /* Indentation is only a defect once it reaches a code-block column, or once it carries a
     * character the tokenizer will not skip past. Anything shorter is left alone. */
    const isHarmfulIndent = indentWidth(indent) >= 4 || /[^ \t]/.test(indent);
    const rewritten = `${isHarmfulIndent ? '' : indent}${colons}artifact${attributes}`;
    if (rewritten !== result[index]) {
      result[index] = rewritten;
      changed = true;
    }
    if (!isHarmfulIndent) {
      continue;
    }

    let blockEnd = result.length - 1;
    for (let body = index + 1; body < result.length; body += 1) {
      if (CLOSING_LINE.test(result[body])) {
        blockEnd = body;
        break;
      }
    }

    /* Shift by the run the whole block actually shares, never by the opening line's own
     * indent: a stray invisible character in front of the colons must not eat a column of
     * the source below it. Blank lines carry no indentation and do not constrain the shift. */
    let shared = indent.length;
    for (let body = index + 1; body <= blockEnd && shared > 0; body += 1) {
      if (!BLANK_LINE.test(result[body])) {
        shared = Math.min(shared, noiseLength(result[body]));
      }
    }
    if (shared === 0) {
      continue;
    }
    for (let body = index + 1; body <= blockEnd; body += 1) {
      const dedented = dedentLine(result[body], shared);
      if (dedented !== result[body]) {
        result[body] = dedented;
        changed = true;
      }
    }
  }

  return changed ? result : lines;
}

/**
 * Repair the emission shapes that stop an artifact directive from tokenizing. Returns the
 * input unchanged when there is nothing to repair.
 */
export function normalizeArtifactDirectives(text: string): string {
  if (!text || !text.includes('artifact')) {
    return text;
  }
  const lines = text.split('\n');
  const normalized = normalizeBlocks(unwrapFenceWrapper(convertXmlTags(lines)));
  return normalized === lines ? text : normalized.join('\n');
}
