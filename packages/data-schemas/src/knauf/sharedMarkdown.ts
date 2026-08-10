import type { SharedFileSnapshot } from '~/types';

export function rewriteSharedMarkdown(
  text: string | undefined,
  snapshots: SharedFileSnapshot[],
  shareId: string,
): string | undefined {
  for (const snapshot of snapshots) {
    const filename = snapshot.filename;
    const duplicate = snapshots.some(
      (candidate) => candidate !== snapshot && candidate.filename === filename,
    );
    if (filename && !duplicate) {
      const route = `/api/share/${shareId}/files/${encodeURIComponent(snapshot.file_id)}`;
      text = text?.replaceAll(`](${filename})`, `](${route})`);
    }
  }
  return text;
}

export function rewriteSharedTextPart(
  value: unknown,
  snapshots: SharedFileSnapshot[],
  shareId: string,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const part = value as Record<string, unknown>;
  if (part.type !== 'text') {
    return value;
  }
  if (typeof part.text === 'string') {
    return { ...part, text: rewriteSharedMarkdown(part.text, snapshots, shareId) };
  }
  const text = part.text as Record<string, unknown> | null;
  return text && typeof text.value === 'string'
    ? { ...part, text: { ...text, value: rewriteSharedMarkdown(text.value, snapshots, shareId) } }
    : value;
}
