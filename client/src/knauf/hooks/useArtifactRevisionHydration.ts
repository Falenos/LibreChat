import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useSetRecoilState } from 'recoil';
import type { Artifact, ArtifactRevisionEntry } from '~/common';
import {
  getArtifactRevision,
  getArtifactRevisionHistory,
} from '~/knauf/data-provider/data-service';
import {
  artifactRevisionId,
  isArtifactRevisionHistoryUnavailable,
  mergeArtifactRevisionRegistry,
  projectArtifactRevisionHistory,
  projectArtifactRevisionSnapshot,
} from '~/knauf/utils/artifactRevisions';
import { artifactsState, visibleArtifacts } from '~/store/artifacts';

interface ArtifactRevisionHydration {
  artifactKey: string;
  currentArtifact: Artifact;
  directiveVersion: number;
  now: number;
}

export default function useArtifactRevisionHydration({
  isArtifactPage,
  messageId,
  setArtifact,
}: {
  isArtifactPage: boolean;
  messageId: string;
  setArtifact: Dispatch<SetStateAction<Artifact | null>>;
}) {
  const setArtifacts = useSetRecoilState(artifactsState);
  const setVisibleArtifacts = useSetRecoilState(visibleArtifacts);
  const rootRevisionTimeRef = useRef<{ lineageKey: string; time: number } | null>(null);
  const historyRequestRef = useRef(0);
  const loadedHistoryRef = useRef<{
    key: string;
    history: ArtifactRevisionEntry[];
  } | null>(null);

  return useCallback(
    ({ artifactKey, currentArtifact, directiveVersion, now }: ArtifactRevisionHydration) => {
      if (directiveVersion <= 1 || !isArtifactPage) {
        historyRequestRef.current += 1;
        loadedHistoryRef.current = null;
        return false;
      }

      const identifier = currentArtifact.identifier ?? '';
      const lineage = { messageId, identifier };
      const lineageKey = `${messageId}:${identifier}`;
      const historyKey = `${lineageKey}:${directiveVersion}:${currentArtifact.title}:${currentArtifact.type}`;

      const register = (additions: Artifact[], history: Artifact['knaufRevisionHistory']) => {
        if (!history) {
          return;
        }
        const update = (artifacts: Record<string, Artifact | undefined> | null) =>
          mergeArtifactRevisionRegistry({
            current: artifacts,
            additions,
            ...lineage,
            history,
          });
        setArtifacts(update);
        setVisibleArtifacts(update);
      };

      if (loadedHistoryRef.current?.key === historyKey) {
        const revisionHistory = loadedHistoryRef.current.history;
        const authoritativeVersion = revisionHistory.reduce(
          (latest, revision) => Math.max(latest, revision.version),
          1,
        );
        const latestMetadata = revisionHistory.find(
          (revision) => revision.available && revision.version === authoritativeVersion,
        );
        register(
          [
            {
              ...currentArtifact,
              id:
                latestMetadata?.id ??
                artifactRevisionId({ ...lineage, version: authoritativeVersion }),
              knaufRevision: { identifier, version: authoritativeVersion },
              knaufRevisionHistory: revisionHistory,
            },
          ],
          revisionHistory,
        );
        return true;
      }
      const requestId = ++historyRequestRef.current;

      void (async () => {
        let history;
        try {
          history = await getArtifactRevisionHistory(lineage);
        } catch (error) {
          if (requestId !== historyRequestRef.current) {
            return;
          }
          const legacyRevisionId = artifactRevisionId({
            ...lineage,
            version: directiveVersion,
          });
          const legacyLatest = {
            ...currentArtifact,
            id: legacyRevisionId,
            knaufRevision: { identifier, version: directiveVersion },
          };
          if (!isArtifactRevisionHistoryUnavailable(error)) {
            setArtifact(legacyLatest);
            return;
          }
          try {
            const snapshot = await getArtifactRevision({ ...lineage, version: 1 });
            if (requestId !== historyRequestRef.current) {
              return;
            }
            const fallbackHistory = [
              {
                id: artifactKey,
                version: 1,
                available: true,
                title: snapshot.title,
                type: snapshot.type,
                language: snapshot.language,
              },
              {
                id: legacyRevisionId,
                version: directiveVersion,
                available: true,
                title: currentArtifact.title,
                type: currentArtifact.type,
                language: currentArtifact.language,
              },
            ];
            const original = projectArtifactRevisionSnapshot({
              snapshot,
              base: currentArtifact,
              rootTime: now - directiveVersion + 1,
              history: fallbackHistory,
            });
            const latestWithHistory = {
              ...legacyLatest,
              knaufRevisionHistory: fallbackHistory,
            };
            loadedHistoryRef.current = { key: historyKey, history: fallbackHistory };
            register([latestWithHistory, original], fallbackHistory);
            setArtifact(original);
          } catch {
            if (requestId === historyRequestRef.current) {
              setArtifact(legacyLatest);
            }
          }
          return;
        }

        try {
          if (requestId !== historyRequestRef.current) {
            return;
          }
          const authoritativeVersion = history.currentVersion;
          const revisionHistory = projectArtifactRevisionHistory({
            history,
            ...lineage,
          });
          loadedHistoryRef.current = { key: historyKey, history: revisionHistory };
          const latestMetadata = revisionHistory.find(
            (revision) => revision.available && revision.version === authoritativeVersion,
          );
          const latest: Artifact = {
            ...currentArtifact,
            id:
              latestMetadata?.id ??
              artifactRevisionId({ ...lineage, version: authoritativeVersion }),
            knaufRevision: { identifier, version: authoritativeVersion },
            knaufRevisionHistory: revisionHistory,
          };
          if (authoritativeVersion === 1) {
            register([latest], revisionHistory);
            setArtifact(latest);
            return;
          }

          const previousRoot = rootRevisionTimeRef.current;
          const rootRevisionTime =
            previousRoot?.lineageKey === lineageKey
              ? previousRoot.time
              : now - authoritativeVersion + 1;
          rootRevisionTimeRef.current = { lineageKey, time: rootRevisionTime };
          const rootRevision = revisionHistory.find(
            (revision) => revision.available && revision.version === 1,
          );
          const original = rootRevision
            ? projectArtifactRevisionSnapshot({
                snapshot: await getArtifactRevision({ ...lineage, version: 1 }),
                base: currentArtifact,
                rootTime: rootRevisionTime,
                history: revisionHistory,
              })
            : null;
          if (requestId !== historyRequestRef.current) {
            return;
          }
          register(original ? [latest, original] : [latest], revisionHistory);
          setArtifact(original ?? latest);
        } catch {
          if (requestId === historyRequestRef.current) {
            setArtifact(currentArtifact);
          }
        }
      })();
      return true;
    },
    [isArtifactPage, messageId, setArtifact, setArtifacts, setVisibleArtifacts],
  );
}
