import type { TSharedArtifact } from 'librechat-data-provider';

export const SHARED_ARTIFACT_PARAM = 'artifactShareId';

export function buildSharedArtifactPrompt(
  artifact: TSharedArtifact,
  introduction: string,
  requestLabel: string,
): string {
  const metadata = JSON.stringify({
    title: artifact.title,
    type: artifact.type,
    ...(artifact.language ? { language: artifact.language } : {}),
  });
  const body = `${metadata}\n\n${artifact.content}`;
  let boundary = '--- KNAUF SHARED ARTIFACT SOURCE ---';
  while (body.includes(boundary)) {
    boundary += '-';
  }

  return `${introduction}\n\n${boundary}\n${body}${body.endsWith('\n') ? '' : '\n'}${boundary}\n\n${requestLabel}`;
}

export function getSharedArtifactContinuationPath(shareId: string): string {
  return `/c/new?${new URLSearchParams({ [SHARED_ARTIFACT_PARAM]: shareId }).toString()}`;
}
