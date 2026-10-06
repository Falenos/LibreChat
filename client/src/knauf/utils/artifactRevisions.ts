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

export const isArtifactRevisionHistoryUnavailable = (error: unknown) => {
  const candidate = error as
    | { status?: unknown; response?: { status?: unknown } }
    | null
    | undefined;
  return candidate?.status === 404 || candidate?.response?.status === 404;
};

let nextOpenRequestId = 0;
const activeOpenRequests = new Map<string, number>();

const artifactLineageKey = ({ messageId, identifier }: { messageId: string; identifier: string }) =>
  `${messageId}\0${identifier}`;

export const beginArtifactRevisionOpen = (lineage: { messageId: string; identifier: string }) => {
  const requestId = ++nextOpenRequestId;
  activeOpenRequests.set(artifactLineageKey(lineage), requestId);
  return requestId;
};

export const isCurrentArtifactRevisionOpen = (
  lineage: { messageId: string; identifier: string },
  requestId: number,
) => activeOpenRequests.get(artifactLineageKey(lineage)) === requestId;

export const finishArtifactRevisionOpen = (
  lineage: { messageId: string; identifier: string },
  requestId: number,
) => {
  const key = artifactLineageKey(lineage);
  if (activeOpenRequests.get(key) === requestId) {
    activeOpenRequests.delete(key);
  }
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
  for (const [id, artifact] of Object.entries(merged)) {
    if (artifact?.messageId === messageId && artifact.knaufRevision?.identifier === identifier) {
      merged[id] = { ...artifact, knaufRevisionHistory: history };
    }
  }
  for (const artifact of additions) {
    merged[artifact.id] = artifact;
  }
  return merged;
};
