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
 * never mounts, so there is no error, no repair affordance and no log line.
 *
 * Shapes measured against this repo's own parser stack (`fromMarkdown` with the same
 * `directive()` / `gfm()` extensions `splitMarkdown.ts` uses) that fail to tokenize:
 *
 *   - the block indented by four or more columns, or by a tab;
 *   - the whole block wrapped in a ``` fence;
 *   - an XML `<artifact …>` tag instead of the directive;
 *   - the opening line split across two lines before its closing brace;
 *   - `::: artifact` with a space after the colons;
 *   - a non-breaking or zero-width space in front of the colons.
 *
 * A seventh parses but mis-renders: curly quotes around the attribute values leave `type`
 * as `“application/vnd.react”`, which matches no entry in `artifactFilename`, so the
 * sandbox silently picks the default HTML template for a React artifact.
 *
 * An eighth is a different defect with the same symptom: the container is closed before
 * the file is finished, so the artifact keeps only the first chunk and the rest renders
 * into the chat as loose source. See `findSpliceCandidate`.
 *
 * ## Why this is a code fix and not a prompt fix
 *
 * The `&karl_prompt` anchor already spends roughly two pages on artifact rules, several
 * added by KK20-252 after five prompt revisions each moved the failure rather than
 * removing it. A rule can be misread; a normalizer cannot. This is the floor under the
 * prompt, not a replacement for it.
 *
 * ## What keeps it off valid content
 *
 * This runs over every assistant Markdown message, so each repair is conditional on
 * evidence that the emission is actually broken, and anything ambiguous is preserved:
 *
 *   - **Nothing inside a fenced block is ever rewritten.** An artifact's source is code:
 *     a React file containing `<artifact data-kind="card">` on its own line, or a fenced
 *     example of the XML shape, must survive untouched.
 *   - **An XML tag is only converted when it carries `identifier`, `type` or `title`** and
 *     sits outside any fence and outside an existing directive — that is, only when it is
 *     the artifact wrapper itself rather than an element in someone's markup.
 *   - **A split opening line is only rejoined from lines that still lex as attributes**,
 *     stopping at a fence or body boundary, and only when the closing brace is actually
 *     found. A partial join is discarded rather than committed.
 *   - **An early close is only spliced with positive evidence the first file was
 *     incomplete** — see `spliceEvidence`. An intentional code block after a complete
 *     artifact is left in the chat where the model put it.
 *   - Every rewrite waits for a complete `:::artifact` or `<artifact` token, so a completed
 *     streaming prefix never changes shape again and the per-block memoization in
 *     `MarkdownBlocks.tsx` still holds.
 *
 * Input that already parses is returned byte-identical, which the spec pins for every
 * shape measured as *not* failing. Anything unrecognised is passed through untouched:
 * rendering what upstream would have rendered is always recoverable.
 */
import { SINGLE_FILE_ARTIFACT_TYPES } from './artifactTypes';

/** Spaces, tabs, and the invisible characters models occasionally emit before a directive. */
const NOISE_CLASS = ' \\t\\u00A0\\u2000-\\u200D\\uFEFF';

/** An artifact opening line, however mangled. Captures indent, colon run, and attributes. */
const OPENING_LINE = new RegExp(`^([${NOISE_CLASS}]*)(:{3,})[ \\t]*artifact\\b(.*)$`);
/** A directive-closing line: a bare colon run. */
const CLOSING_LINE = new RegExp(`^[${NOISE_CLASS}]*:{3,}[ \\t]*\\r?$`);
/** A fenced code block delimiter, with an optional info string. */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})[^\r\n`~]*\r?$/;
/** The same, capturing the delimiter run and the first word of the info string. */
const FENCE_PARTS = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\s`~]*)/;
/** The `type` attribute of an artifact opening line, quoted or bare. */
const TYPE_ATTRIBUTE = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/;
/**
 * An attribute that marks an `<artifact>` tag as the wrapper rather than an element in the
 * source. Anchored to a boundary so `data-type=` on a custom element does not qualify.
 */
const WRAPPER_ATTRIBUTE = /(?:^|\s)(?:identifier|type|title)\s*=/;
/** A line that continues an attribute block: another `name=` pair, or the closing brace. */
const ATTRIBUTE_CONTINUATION = /^[ \t]*(?:\}|[A-Za-z_][\w:.-]*\s*=)/;
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

/** The delimiter run and language of a fence line, or null when the line is not a fence. */
function fenceParts(line: string): { marker: string; lang: string } | null {
  const match = FENCE_PARTS.exec(line);
  return match ? { marker: match[1], lang: match[2] } : null;
}

/** Whether `candidate` closes a fence opened with `marker`. */
function closesFence(candidate: { marker: string; lang: string }, marker: string): boolean {
  return (
    candidate.lang === '' &&
    candidate.marker[0] === marker[0] &&
    candidate.marker.length >= marker.length
  );
}

/** Index of the fence that closes the fence opened at `openIndex`, or -1. */
function fenceCloseIndex(lines: string[], openIndex: number, marker: string): number {
  for (let index = openIndex + 1; index < lines.length; index += 1) {
    const fence = fenceParts(lines[index]);
    if (fence && closesFence(fence, marker)) {
      return index;
    }
  }
  return -1;
}

/** The `type` attribute of an artifact opening line, or an empty string. */
function artifactType(line: string): string {
  const match = TYPE_ATTRIBUTE.exec(line);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

/**
 * Rewrite an XML-style `<artifact …>` / `</artifact>` wrapper into directive form.
 *
 * Deliberately context-aware. An artifact's own source routinely contains angle-bracket
 * markup, and a React or HTML file with an `<artifact …>` element on its own line used to
 * be rewritten into nested directive text, corrupting a file that rendered correctly. So
 * the scan tracks fenced blocks and open directives and rewrites neither, and requires the
 * tag to carry `identifier`, `type` or `title` before treating it as the wrapper at all.
 *
 * The close is only rewritten once a converted open has been seen, so a stray
 * `</artifact>` in prose is left alone. An unclosed open is still converted — the
 * tokenizer handles an unclosed container gracefully, which is what makes streaming work.
 */
function convertXmlTags(lines: string[]): string[] {
  let isWrapperOpen = false;
  let changed = false;
  let openFence: string | null = null;
  let inDirective = false;

  const result = lines.map((line) => {
    const fence = fenceParts(line);
    if (fence) {
      if (openFence == null) {
        openFence = fence.marker;
      } else if (closesFence(fence, openFence)) {
        openFence = null;
      }
      return line;
    }
    /* Inside a fence the line is source, and inside a directive it is the artifact's own
     * content. Neither is markup this function has any business rewriting. */
    if (openFence != null) {
      return line;
    }
    if (OPENING_LINE.test(line)) {
      inDirective = true;
      return line;
    }
    if (inDirective) {
      inDirective = !CLOSING_LINE.test(line);
      return line;
    }

    const open = XML_OPEN.exec(line);
    if (open && WRAPPER_ATTRIBUTE.test(open[1])) {
      isWrapperOpen = true;
      changed = true;
      return `:::artifact{${straightenQuotes(open[1]).trim()}}`;
    }
    if (isWrapperOpen && XML_CLOSE.test(line)) {
      isWrapperOpen = false;
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
    const end = wrapperCloseIndex(lines, opening, fence[1]);
    if (end === -1) {
      continue;
    }
    const result = lines.slice();
    result.splice(end, 1);
    result.splice(index, 1);
    return result;
  }
  return lines;
}

/** The trailing fence of a wrapper: the last one preceded by the directive's own close. */
function wrapperCloseIndex(lines: string[], opening: number, marker: string): number {
  for (let end = lines.length - 1; end > opening; end -= 1) {
    const fence = FENCE_LINE.exec(lines[end]);
    if (!fence || fence[1].length < marker.length) {
      continue;
    }
    const before = previousContentLine(lines, end - 1);
    if (before !== -1 && CLOSING_LINE.test(lines[before])) {
      return end;
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
 * Rejoin an opening line split before its closing brace.
 *
 * Only lines that still lex as attribute continuations are absorbed, and the scan stops at
 * a fence, a directive line or anything else that begins the body. Without that, a model
 * that simply omits the closing brace and starts the file normally would have its fence and
 * first source line swallowed into the opening line — the same thing happens transiently
 * while the opening line is still streaming.
 *
 * The join is committed only once the closing brace is actually found; a partial join is
 * discarded, leaving the line exactly as the model wrote it.
 */
function joinSplitOpeningLine(
  lines: string[],
  index: number,
  attributes: string,
): { attributes: string; consumed: number } {
  const unchanged = { attributes, consumed: 0 };
  if (!attributes.trimEnd().startsWith('{') || attributes.includes('}')) {
    return unchanged;
  }

  let joined = attributes;
  for (let span = 1; span <= MAX_JOINED_OPENING_LINES; span += 1) {
    const continuation = lines[index + span];
    if (continuation == null || BLANK_LINE.test(continuation)) {
      return unchanged;
    }
    if (FENCE_LINE.test(continuation) || CLOSING_LINE.test(continuation)) {
      return unchanged;
    }
    if (!ATTRIBUTE_CONTINUATION.test(continuation)) {
      return unchanged;
    }
    joined = `${joined.trimEnd()} ${straightenQuotes(continuation).trim()}`;
    if (continuation.includes('}')) {
      return { attributes: joined, consumed: span };
    }
  }
  return unchanged;
}

/** Index of the line closing this block, or the last line when it never closes. */
function blockEndIndex(lines: string[], from: number): number {
  for (let index = from; index < lines.length; index += 1) {
    if (CLOSING_LINE.test(lines[index])) {
      return index;
    }
  }
  return lines.length - 1;
}

/**
 * The leading-whitespace run the whole block shares, capped at the opening line's own
 * indent. Shifting by the shared run rather than the opening indent keeps a stray invisible
 * character in front of the colons from eating a column of the source below it. Blank lines
 * carry no indentation and do not constrain the shift.
 */
function sharedIndent(lines: string[], from: number, to: number, max: number): number {
  let shared = max;
  for (let index = from; index <= to && shared > 0; index += 1) {
    if (!BLANK_LINE.test(lines[index])) {
      shared = Math.min(shared, noiseLength(lines[index]));
    }
  }
  return shared;
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
    if (opening) {
      changed = normalizeOneBlock(result, index, opening) || changed;
    }
  }

  return changed ? result : lines;
}

/** Canonicalize the block opening at `index`, in place. Returns whether anything changed. */
function normalizeOneBlock(lines: string[], index: number, opening: RegExpExecArray): boolean {
  const [, indent, colons] = opening;
  let changed = false;

  const joined = joinSplitOpeningLine(lines, index, straightenQuotes(opening[3]));
  if (joined.consumed > 0) {
    lines.splice(index + 1, joined.consumed);
    changed = true;
  }

  /* Indentation is only a defect once it reaches a code-block column, or once it carries a
   * character the tokenizer will not skip past. Anything shorter is left alone. */
  const isHarmfulIndent = indentWidth(indent) >= 4 || /[^ \t]/.test(indent);
  const rewritten = `${isHarmfulIndent ? '' : indent}${colons}artifact${joined.attributes}`;
  if (rewritten !== lines[index]) {
    lines[index] = rewritten;
    changed = true;
  }
  if (!isHarmfulIndent) {
    return changed;
  }

  const blockEnd = blockEndIndex(lines, index + 1);
  const shared = sharedIndent(lines, index + 1, blockEnd, indent.length);
  return dedentBlock(lines, index + 1, blockEnd, shared) || changed;
}

/** Shift every line of a block left by `shared` columns, in place. */
function dedentBlock(lines: string[], from: number, to: number, shared: number): boolean {
  let changed = false;
  for (let index = from; shared > 0 && index <= to; index += 1) {
    const dedented = dedentLine(lines[index], shared);
    if (dedented !== lines[index]) {
      lines[index] = dedented;
      changed = true;
    }
  }
  return changed;
}

const BRACKET_PAIRS: Array<[string, string]> = [
  ['{', '}'],
  ['(', ')'],
  ['[', ']'],
];
const QUOTES = new Set(['"', "'", '`']);

/** Index just past the run beginning at `start` and ending with `terminator`. */
function endOfRun(source: string, start: number, terminator: string): number {
  const at = source.indexOf(terminator, start);
  return at === -1 ? source.length : at + terminator.length;
}

/** Index just past a quoted run starting at `start`, honouring backslash escapes. */
function endOfQuoted(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    index += source[index] === '\\' ? 2 : 1;
  }
  return index + 1;
}

/**
 * Drop string literals, template literals and comments, so a delimiter written *about* code
 * is not mistaken for one written *in* it.
 *
 * Without this, a complete file containing `return <pre>{"{"}</pre>;` reads as having an
 * unclosed brace, and a separate complete block containing `console.log("}");` reads as
 * closing it — so two valid, unrelated chunks look exactly like one file cut in half. A
 * template literal is dropped whole, interpolations included, which keeps `${…}` from
 * contributing a brace at either end.
 */
function stripLiterals(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      index = endOfRun(source, index, '\n');
    } else if (source.startsWith('/*', index)) {
      index = endOfRun(source, index + 2, '*/');
    } else if (source.startsWith('<!--', index)) {
      index = endOfRun(source, index + 4, '-->');
    } else if (QUOTES.has(source[index])) {
      index = endOfQuoted(source, index);
    } else {
      out += source[index];
      index += 1;
    }
  }
  return out;
}

/**
 * How a source chunk sits with respect to its delimiters, ignoring literals and comments.
 *
 * `unclosed` counts delimiters left open; `balance` is signed, so a fragment that closes
 * more than it opens reads negative. Tags are counted alongside brackets because an
 * `image/svg+xml` or `text/html` file may contain no braces at all.
 *
 * Still a heuristic, not a parser — a regex literal containing an unmatched brace would
 * miscount. That is why the caller never relies on this alone: see `findSpliceCandidate`.
 */
function countDelimiters(source: string): { unclosed: number; balance: number } {
  const stripped = stripLiterals(source);
  let unclosed = 0;
  let balance = 0;

  for (const [open, close] of BRACKET_PAIRS) {
    const opened = stripped.split(open).length - 1;
    const closed = stripped.split(close).length - 1;
    unclosed += Math.max(0, opened - closed);
    balance += opened - closed;
  }

  const openTags = (stripped.match(/<[A-Za-z][^>]*>/g) ?? []).filter(
    (tag) => !tag.endsWith('/>'),
  ).length;
  const closeTags = (stripped.match(/<\/[A-Za-z][^>]*>/g) ?? []).length;
  unclosed += Math.max(0, openTags - closeTags);
  balance += openTags - closeTags;

  return { unclosed, balance };
}

/** The source a fence holds, between its delimiters. */
function fenceBody(lines: string[], open: number, close: number): string {
  return lines.slice(open + 1, close).join('\n');
}

/**
 * The rest of the file as the model chunked it: the source of the spilled fence and of every
 * further same-language fence reachable across nothing but `:::` and blank lines.
 *
 * Evidence is weighed against the whole remainder rather than the next chunk alone, because
 * a file broken into three pieces has a middle chunk that closes nothing on its own. The
 * walk stops at the first line that is not part of that chain, so an unrelated code block
 * further down the message never counts towards the evidence.
 */
function remainderBody(lines: string[], spill: number, lang: string): string {
  const chunks: string[] = [];
  let index = spill;

  while (index !== -1 && index < lines.length) {
    const fence = fenceParts(lines[index]);
    if (!fence || fence.lang !== lang) {
      break;
    }
    const close = fenceCloseIndex(lines, index, fence.marker);
    chunks.push(fenceBody(lines, index, close === -1 ? lines.length : close));
    if (close === -1) {
      break;
    }
    let next = nextContentLine(lines, close + 1);
    if (next !== -1 && CLOSING_LINE.test(lines[next])) {
      next = nextContentLine(lines, next + 1);
    }
    index = next;
  }
  return chunks.join('\n');
}

type SpliceCandidate = {
  bodyClose: number;
  spill: number;
  marker: string;
};

/**
 * Locate an artifact whose container was closed before the file was finished.
 *
 * The model closes its fence and writes `:::`, then carries on with the rest of the same
 * file in a second fence. The tokenizer does exactly as it is told: the container ends at
 * that `:::`, the artifact keeps only the first chunk, and everything after it becomes a
 * sibling code block rendered into the chat. This survives a page reload, because the
 * defect is in the stored text rather than in how it is assembled while streaming.
 *
 * Adjacency and a matching fence language are not enough to identify it: a complete
 * artifact followed by a deliberate usage example in the same language looks identical from
 * the outside, and absorbing that would destroy valid output — including in historical
 * messages and in responses from models that never saw the current prompt. So this also
 * requires positive evidence that the first chunk was incomplete and that joining the
 * second one helps. Anything short of that is left exactly as the model wrote it.
 */
function findSpliceCandidate(lines: string[], index: number): SpliceCandidate | null {
  if (!SINGLE_FILE_ARTIFACT_TYPES.has(artifactType(lines[index]))) {
    return null;
  }
  const bodyFence = nextContentLine(lines, index + 1);
  const fence = bodyFence === -1 ? null : fenceParts(lines[bodyFence]);
  if (!fence || fence.lang === '') {
    return null;
  }
  const bodyClose = fenceCloseIndex(lines, bodyFence, fence.marker);
  if (bodyClose === -1) {
    return null;
  }

  /* The container close has to sit immediately after the fence close for this to be the
   * early-close shape; prose in between means the model moved on deliberately. */
  const containerClose = nextContentLine(lines, bodyClose + 1);
  if (containerClose === -1 || !CLOSING_LINE.test(lines[containerClose])) {
    return null;
  }

  const spill = nextContentLine(lines, containerClose + 1);
  const spillFence = spill === -1 ? null : fenceParts(lines[spill]);
  if (!spillFence || spillFence.lang !== fence.lang) {
    return null;
  }
  return spliceEvidence(lines, { bodyFence, bodyClose, spill, fence });
}

/**
 * Decide whether these two chunks are one file cut in half, and refuse anything short of it.
 *
 * Three independent things must hold, because no single one of them is safe on its own:
 *
 *  1. **The first chunk must be unfinished.** A completed artifact has its delimiters
 *     closed, so a deliberate example block after it is never a candidate.
 *  2. **The remainder must be a fragment, not a unit.** A continuation closes more than it
 *     opens, so its balance is negative. A self-contained block is balanced or positive,
 *     whatever its contents — which is what makes this hold even when (1) miscounts.
 *  3. **Joining must strictly help.** The rejoined file must have fewer delimiters left
 *     open than the first chunk did.
 *
 * (2) is what closes the gap literal-stripping alone would leave. `countDelimiters` is a
 * heuristic and can still be fooled — by a regex literal carrying an unmatched brace, say —
 * so the shape is only repaired when the second chunk independently reads as a continuation.
 * Ambiguity is resolved by leaving the message exactly as the model wrote it.
 */
function spliceEvidence(
  lines: string[],
  found: {
    bodyFence: number;
    bodyClose: number;
    spill: number;
    fence: { marker: string; lang: string };
  },
): SpliceCandidate | null {
  const { bodyFence, bodyClose, spill, fence } = found;

  const head = countDelimiters(fenceBody(lines, bodyFence, bodyClose));
  if (head.unclosed === 0) {
    return null;
  }
  const remainder = remainderBody(lines, spill, fence.lang);
  if (countDelimiters(remainder).balance >= 0) {
    return null;
  }
  const rejoined = countDelimiters(`${fenceBody(lines, bodyFence, bodyClose)}\n${remainder}`);
  if (rejoined.unclosed >= head.unclosed) {
    return null;
  }
  return { bodyClose, spill, marker: fence.marker };
}

/**
 * Drop everything from the first fence's close through the spilled fence's open, joining
 * the two code bodies, then close the container after the rejoined block.
 *
 * One fence rather than two matters: `extractArtifactBody` keeps the first fenced block of
 * a compiled artifact, so a repair that left two would still drop the tail.
 */
function applySplice(lines: string[], candidate: SpliceCandidate): string[] {
  const { bodyClose, spill, marker } = candidate;
  const result = [...lines.slice(0, bodyClose), ...lines.slice(spill + 1)];
  const rejoinedClose = fenceCloseIndex(result, bodyClose - 1, marker);
  if (rejoinedClose === -1) {
    /* The spilled block never closed — truncated mid-file. Leaving the container open is
     * what the tokenizer already handles gracefully, so stop here rather than guess. */
    return result;
  }

  /* A file broken into three pieces already has a `:::` after the second one. Reusing it
   * rather than adding another matters: two consecutive closes would leave the second
   * sitting where the next pass looks for the spilled fence, stopping the repair halfway. */
  const following = nextContentLine(result, rejoinedClose + 1);
  if (following !== -1 && CLOSING_LINE.test(result[following])) {
    return result;
  }
  return [...result.slice(0, rejoinedClose + 1), ':::', ...result.slice(rejoinedClose + 1)];
}

function spliceOnce(lines: string[]): string[] {
  for (let index = 0; index < lines.length; index += 1) {
    if (!OPENING_LINE.test(lines[index])) {
      continue;
    }
    const candidate = findSpliceCandidate(lines, index);
    if (candidate) {
      return applySplice(lines, candidate);
    }
  }
  return lines;
}

/** Rejoin every artifact whose container was closed before the file was finished. */
function spliceEarlyClose(lines: string[]): string[] {
  let result = lines;
  /* Each pass absorbs one spilled block; a file broken into three comes back whole on the
   * second. Bounded by the line count, which shrinks with every splice. */
  for (let pass = 0; pass < result.length; pass += 1) {
    const spliced = spliceOnce(result);
    if (spliced === result) {
      return result;
    }
    result = spliced;
  }
  return result;
}

/**
 * Repair the emission shapes that stop an artifact directive from tokenizing, and rejoin an
 * artifact whose container was closed before the file was finished. Returns the input
 * unchanged when there is nothing to repair.
 */
export function normalizeArtifactDirectives(text: string): string {
  if (!text || !text.includes('artifact')) {
    return text;
  }
  const lines = text.split('\n');
  const normalized = spliceEarlyClose(normalizeBlocks(unwrapFenceWrapper(convertXmlTags(lines))));
  return normalized === lines ? text : normalized.join('\n');
}
