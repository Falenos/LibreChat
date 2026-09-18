/**
 * [knauf] KK20-365 — the artifact types whose body is one compiled source file.
 *
 * Lifted out of `artifactBody.ts` so `normalizeArtifactDirectives.ts` can share it without
 * importing that module, which pulls in React. The normalizer is a pure string transform and
 * is deliberately kept free of every dependency, so a shared constant needs a home neither
 * module owns.
 *
 * Deliberately excludes `text/markdown` / `text/md`, where prose and several code samples are
 * legitimate content, and the tool-produced preview buckets, which never come from a
 * `:::artifact` directive.
 */
export const SINGLE_FILE_ARTIFACT_TYPES = new Set([
  'application/vnd.react',
  'application/vnd.ant.react',
  'text/html',
  'application/vnd.code-html',
  'image/svg+xml',
  'application/vnd.mermaid',
]);
