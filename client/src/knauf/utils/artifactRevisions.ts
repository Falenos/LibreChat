import type { Artifact } from '~/common';
import type { ArtifactRevisionHistory } from '~/knauf/data-provider/data-service';

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

export const projectArtifactRevisionHistory = ({
  history,
  base,
  rootTime,
}: {
  history: ArtifactRevisionHistory;
  base: Pick<Artifact, 'identifier' | 'messageId' | 'index'>;
  rootTime: number;
}) => {
  const identifier = base.identifier ?? '';
  const messageId = base.messageId ?? '';
  const unavailableVersions = history.revisions
    .filter(isUnavailableRevision)
    .map(({ version }) => version);
  const artifacts = history.revisions.reduce<Record<string, Artifact>>((registered, snapshot) => {
    if (isUnavailableRevision(snapshot)) {
      return registered;
    }
    const id =
      snapshot.version === 1
        ? artifactRootId({
            identifier,
            messageId,
            title: snapshot.title,
            type: snapshot.type,
          })
        : artifactRevisionId({ messageId, identifier, version: snapshot.version });
    registered[id] = {
      ...base,
      ...snapshot,
      id,
      lastUpdateTime: rootTime + snapshot.version - 1,
      knaufRevision: { identifier, version: snapshot.version },
      knaufUnavailableVersions: unavailableVersions,
    };
    return registered;
  }, {});

  return { artifacts, unavailableVersions };
};
