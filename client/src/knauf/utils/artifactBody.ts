/**
 * [knauf] KK20-252 — take the artifact's code block, not everything in the directive.
 *
 * ## The failure
 *
 * `Artifact.tsx` builds an artifact's content with `extractContent(props.children)`,
 * which is `children.map(extractContent).join('')` — every child of the `:::artifact`
 * container, concatenated with no separator. For a well-formed artifact that is
 * exactly one fenced code block, so the concatenation is a no-op and nobody noticed.
 *
 * When the model appends anything after the fence, all of it lands in `App.tsx`.
 * Observed twice on KK20-252, both times fatal:
 *
 *     138 | }
 *     139 | <!-- Optional: include this in your page if you're hosting standalone -->
 *     140 | <style>
 *
 * Sandpack compiles that as TSX and throws `Unexpected token`. The artifact renders
 * an error overlay instead of the deck. Parsed shape, verified against this repo's
 * own mdast/hast stack:
 *
 *     mdast children : code(lang=tsx), html, html
 *     hast  children : element(pre),   raw,  raw
 *
 * The parser already knows the trailing nodes are not code. It hands them over anyway.
 *
 * ## Why this is a code fix and not a prompt fix
 *
 * Five prompt revisions on this ticket each moved the failure rather than removing it:
 * the model wrote an XML tag, then a comment naming a library, then a `<style>` block.
 * A rule can be misread; a filter cannot. This is the floor under the prompt, not a
 * replacement for it — the prompt still tells the model to emit one fence, and this
 * makes it not matter when it doesn't.
 *
 * ## Why it is safe
 *
 * Both prompts define an artifact as exactly one fenced block
 * (`packages/api/src/prompts/artifacts/index.ts`, and the `&karl_prompt` anchor), so
 * on a well-formed artifact this returns precisely what `extractContent` returns
 * today. It only diverges where the old behaviour was already producing a broken file.
 *
 * Two deliberate limits:
 *
 *  - **Compiled types only.** A `text/markdown` artifact is a document: prose between
 *    two code samples is real content and must survive, so markdown keeps the
 *    concatenation. The set below is the types whose content is fed to a compiler.
 *  - **Fails open.** No `pre` child — mid-stream before the fence opens, or an
 *    emission shape we have not seen — returns the input unchanged. Rendering what
 *    upstream would have rendered is always recoverable; returning empty is not.
 */
import React from 'react';
import { extractContent } from '~/utils';

/**
 * Artifact types whose body is handed to a compiler or parser, so a single source
 * file is the only valid content. Deliberately excludes `text/markdown` / `text/md`
 * (prose and multiple code samples are legitimate) and the tool-produced buckets,
 * which never come from a `:::artifact` directive.
 */
const SINGLE_FILE_ARTIFACT_TYPES = new Set([
  'application/vnd.react',
  'application/vnd.ant.react',
  'text/html',
  'application/vnd.code-html',
  'image/svg+xml',
  'application/vnd.mermaid',
]);
const FENCED_SOURCE_PATTERN =
  /(?:^|\r?\n)[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/;

/** A fenced code block renders as `<pre><code>`; `pre` has no custom component in
 *  `getMarkdownComponents()`, so it stays the intrinsic string tag. */
const isPreElement = (child: React.ReactNode): boolean =>
  React.isValidElement(child) && child.type === 'pre';

/**
 * Content for an artifact whose body must be a single source file.
 *
 * Returns the first fenced code block when the type is compiled and one is present;
 * otherwise the caller's existing concatenation, unchanged.
 */
export function extractArtifactBody(
  children: React.ReactNode | { props: { children: React.ReactNode } },
  type: string | undefined,
): string {
  if (type == null || !SINGLE_FILE_ARTIFACT_TYPES.has(type)) {
    return extractContent(children);
  }
  const nodes = Array.isArray(children) ? children : [children];
  const codeBlock = nodes.find(isPreElement);
  if (codeBlock == null) {
    return extractContent(children);
  }
  return extractContent(codeBlock);
}

/** Cleans snapshots created before shared links normalized compiled directive bodies. */
export function extractSharedArtifactBody(content: string, type: string | undefined): string {
  if (type == null || !SINGLE_FILE_ARTIFACT_TYPES.has(type)) {
    return content;
  }
  return content.match(FENCED_SOURCE_PATTERN)?.[2] ?? content;
}
