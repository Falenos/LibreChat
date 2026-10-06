import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import type { Artifact } from '~/common';
import { getArtifactRevision } from '~/knauf/data-provider/data-service';
import {
  beginArtifactRevisionOpen,
  cancelArtifactRevisionOpen,
  finishArtifactRevisionOpen,
  isCurrentArtifactRevisionOpen,
  mergeArtifactRevisionRegistry,
  projectArtifactRevisionSnapshot,
} from '~/knauf/utils/artifactRevisions';
import store from '~/store';

export default function useArtifactRevisionSelection({
  artifacts,
  currentArtifactId,
  scopeKey,
  setCurrentArtifactId,
}: {
  artifacts: Record<string, Artifact | undefined> | null;
  currentArtifactId: string | null;
  scopeKey: string | null;
  setCurrentArtifactId: (id: string) => void;
}) {
  const visibleArtifacts = useRecoilValue(store.visibleArtifacts);
  const setArtifacts = useSetRecoilState(store.artifactsState);
  const setVisibleArtifacts = useSetRecoilState(store.visibleArtifacts);
  const currentArtifact = currentArtifactId != null ? artifacts?.[currentArtifactId] : null;
  const artifactVersions = useMemo(() => {
    const revision = currentArtifact?.knaufRevision;
    if (!revision || !currentArtifact?.messageId) {
      return [];
    }
    if (currentArtifact.knaufRevisionHistory != null) {
      return currentArtifact.knaufRevisionHistory;
    }
    const availableVersions = Object.values(artifacts ?? {})
      .filter(
        (artifact): artifact is NonNullable<typeof artifact> =>
          artifact != null &&
          artifact.messageId === currentArtifact.messageId &&
          artifact.knaufRevision?.identifier === revision.identifier,
      )
      .sort(
        (left, right) => (left.knaufRevision?.version ?? 0) - (right.knaufRevision?.version ?? 0),
      )
      .map((artifact) => ({
        id: artifact.id,
        version: artifact.knaufRevision?.version ?? 0,
        available: true,
      }));
    const versions = new Map<number, { id: string | null; version: number; available: boolean }>();
    for (const available of availableVersions) {
      versions.set(available.version, available);
    }
    return [...versions.values()].sort((left, right) => left.version - right.version);
  }, [artifacts, currentArtifact]);
  const currentIndex = artifactVersions.findIndex(({ id }) => id === currentArtifactId);
  const [isArtifactVersionLoading, setIsArtifactVersionLoading] = useState(false);
  const [artifactVersionError, setArtifactVersionError] = useState(false);
  const versionSelectionRequestRef = useRef(0);

  useEffect(() => {
    setArtifactVersionError(false);
    setIsArtifactVersionLoading(false);
  }, [currentArtifactId]);

  useEffect(() => {
    cancelArtifactRevisionOpen();
    versionSelectionRequestRef.current += 1;
    setArtifactVersionError(false);
    setIsArtifactVersionLoading(false);
  }, [scopeKey]);

  const selectArtifactVersion = useCallback(
    async (index: number) => {
      const target = artifactVersions[index];
      const revision = currentArtifact?.knaufRevision;
      const messageId = currentArtifact?.messageId;
      if (!target?.available || !target.id || !revision || !messageId) {
        return;
      }
      const lineage = { messageId, identifier: revision.identifier };
      const requestId = beginArtifactRevisionOpen();
      const localRequestId = ++versionSelectionRequestRef.current;
      setArtifactVersionError(false);
      setIsArtifactVersionLoading(true);
      try {
        const cached = artifacts?.[target.id] ?? visibleArtifacts?.[target.id];
        const selected =
          cached?.content != null
            ? { ...cached, knaufRevisionHistory: artifactVersions }
            : projectArtifactRevisionSnapshot({
                snapshot: await getArtifactRevision({
                  ...lineage,
                  version: target.version,
                }),
                base: {
                  messageId,
                  identifier: revision.identifier,
                  index: currentArtifact.index,
                },
                rootTime:
                  currentArtifact.lastUpdateTime -
                  Math.max((currentArtifact.knaufRevision?.version ?? 1) - 1, 0),
                history: artifactVersions,
              });
        if (!isCurrentArtifactRevisionOpen(requestId)) {
          return;
        }
        const register = (current: Record<string, Artifact | undefined> | null) =>
          mergeArtifactRevisionRegistry({
            current,
            additions: [selected],
            ...lineage,
            history: artifactVersions,
          });
        setArtifacts(register);
        setVisibleArtifacts(register);
        setCurrentArtifactId(selected.id);
      } catch {
        if (isCurrentArtifactRevisionOpen(requestId)) {
          setArtifactVersionError(true);
        }
      } finally {
        if (localRequestId === versionSelectionRequestRef.current) {
          setIsArtifactVersionLoading(false);
        }
        finishArtifactRevisionOpen(requestId);
      }
    },
    [
      artifactVersions,
      artifacts,
      currentArtifact,
      setArtifacts,
      setCurrentArtifactId,
      setVisibleArtifacts,
      visibleArtifacts,
    ],
  );

  return {
    artifactVersionError,
    artifactVersions,
    currentArtifact,
    currentIndex,
    isArtifactVersionLoading,
    selectArtifactVersion,
  };
}
