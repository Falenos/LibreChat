import type { Artifact, ArtifactRevisionEntry } from '~/common';
import type {
  ArtifactRevisionHistory,
  ArtifactRevisionSnapshot,
} from '~/knauf/data-provider/data-service';

const isUnavailableRevision = (
  snapshot: ArtifactRevisionHistory['revisions'][number],
): snapshot is { version: number; available: false } =>
  'available' in snapshot && snapshot.available === false;

export const artifactRootId = ({
  identifier,
  type,
  title,
  messageId,
}: {
  identifier: string;
  type: string;
  title: string;
  messageId: string;
}) => `${identifier}_${type}_${title}_${messageId}`.replace(/\s+/g, '_').toLowerCase();

export const artifactRevisionId = ({
  messageId,
  identifier,
  version,
}: {
  messageId: string;
  identifier: string;
  version: number;
}) => `artifact-revision:${messageId}:${identifier}:version:${version}`;

let nextOpenRequestId = 0;
let activeOpenRequestId: number | null = null;

export const beginArtifactRevisionOpen = () => {
  const requestId = ++nextOpenRequestId;
  activeOpenRequestId = requestId;
  return requestId;
};

export const isCurrentArtifactRevisionOpen = (requestId: number) =>
  activeOpenRequestId === requestId;

export const finishArtifactRevisionOpen = (requestId: number) => {
  if (activeOpenRequestId === requestId) {
    activeOpenRequestId = null;
  }
};

export const cancelArtifactRevisionOpen = () => {
  nextOpenRequestId += 1;
  activeOpenRequestId = null;
};

export const projectArtifactRevisionHistory = ({
  history,
  messageId,
  identifier,
}: {
  history: ArtifactRevisionHistory;
  messageId: string;
  identifier: string;
}): ArtifactRevisionEntry[] =>
  history.revisions.map((revision) => {
    if (isUnavailableRevision(revision)) {
      return { id: null, version: revision.version, available: false };
    }
    return {
      ...revision,
      id:
        revision.version === 1
          ? artifactRootId({
              identifier,
              messageId,
              title: revision.title,
              type: revision.type,
            })
          : artifactRevisionId({ messageId, identifier, version: revision.version }),
    };
  });

export const projectArtifactRevisionSnapshot = ({
  snapshot,
  base,
  rootTime,
  history,
}: {
  snapshot: ArtifactRevisionSnapshot;
  base: Pick<Artifact, 'identifier' | 'messageId' | 'index'>;
  rootTime: number;
  history: ArtifactRevisionEntry[];
}): Artifact => {
  const identifier = base.identifier ?? '';
  const messageId = base.messageId ?? '';
  const metadata = history.find(
    (revision) => revision.available && revision.version === snapshot.version,
  );
  const id =
    metadata?.id ??
    (snapshot.version === 1
      ? artifactRootId({
          identifier,
          messageId,
          title: snapshot.title,
          type: snapshot.type,
        })
      : artifactRevisionId({ messageId, identifier, version: snapshot.version }));
  return {
    ...base,
    ...snapshot,
    id,
    lastUpdateTime: rootTime + snapshot.version - 1,
    knaufRevision: { identifier, version: snapshot.version },
    knaufRevisionHistory: history,
  };
};

export const mergeArtifactRevisionRegistry = ({
  current,
  additions,
  messageId,
  identifier,
  history,
}: {
  current: Record<string, Artifact | undefined> | null;
  additions: Artifact[];
  messageId: string;
  identifier: string;
  history: ArtifactRevisionEntry[];
}) => {
  const merged = { ...current };
  const validIds = new Set(
    history.flatMap((revision) => (revision.available && revision.id ? [revision.id] : [])),
  );
  for (const [id, artifact] of Object.entries(merged)) {
    if (artifact?.messageId === messageId && artifact.knaufRevision?.identifier === identifier) {
      if (!validIds.has(id)) {
        delete merged[id];
      } else {
        merged[id] = { ...artifact, knaufRevisionHistory: history };
      }
    }
  }
  for (const artifact of additions) {
    merged[artifact.id] = artifact;
  }
  return merged;
};
