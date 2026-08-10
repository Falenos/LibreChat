export const SHARED_ARTIFACT_PARAM = 'artifactShareId';
export const SHARED_ARTIFACT_PENDING_OPEN = 'knaufSharedArtifactPendingOpen';

export function getSharedArtifactContinuationPath(shareId: string): string {
  return `/c/new?${new URLSearchParams({ [SHARED_ARTIFACT_PARAM]: shareId }).toString()}`;
}
