import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useSetRecoilState } from 'recoil';
import type { Artifact, ArtifactRevisionEntry } from '~/common';
import {
  getArtifactRevision,
  getArtifactRevisionHistory,
} from '~/knauf/data-provider/data-service';
import {
  artifactRevisionId,
  mergeArtifactRevisionRegistry,
  projectArtifactRevisionHistory,
  projectArtifactRevisionSnapshot,
} from '~/knauf/utils/artifactRevisions';
import { artifactsState, visibleArtifacts } from '~/store/artifacts';

interface ArtifactRevisionHydration {
  currentArtifact: Artifact;
  directiveVersion: number;
  now: number;
}

type ArtifactLineage = { messageId: string; identifier: string };
type RegisterArtifacts = (additions: Artifact[], history: ArtifactRevisionEntry[]) => void;

const latestHistoryVersion = (history: ArtifactRevisionEntry[]) =>
  history.reduce((latest, revision) => Math.max(latest, revision.version), 1);

const resolveLatestArtifact = async ({
  currentArtifact,
  directiveVersion,
  authoritativeVersion,
  lineage,
  rootRevisionTime,
  history,
}: {
  currentArtifact: Artifact;
  directiveVersion: number;
  authoritativeVersion: number;
  lineage: ArtifactLineage;
  rootRevisionTime: number;
  history: ArtifactRevisionEntry[];
}): Promise<Artifact> => {
  if (directiveVersion !== authoritativeVersion) {
    return projectArtifactRevisionSnapshot({
      snapshot: await getArtifactRevision({
        ...lineage,
        version: authoritativeVersion,
      }),
      base: currentArtifact,
      rootTime: rootRevisionTime,
      history,
    });
  }
  const metadata = history.find(
    (revision) => revision.available && revision.version === authoritativeVersion,
  );
  return {
    ...currentArtifact,
    id: metadata?.id ?? artifactRevisionId({ ...lineage, version: authoritativeVersion }),
    title: metadata?.title ?? currentArtifact.title,
    type: metadata?.type ?? currentArtifact.type,
    language: metadata?.language ?? currentArtifact.language,
    knaufRevision: { identifier: lineage.identifier, version: authoritativeVersion },
    knaufRevisionHistory: history,
  };
};

const hydrateFromServer = async ({
  currentArtifact,
  directiveVersion,
  lineage,
  historyKey,
  isCurrent,
  rootRevisionTimeFor,
  rememberHistory,
  register,
  registerFallback,
  setArtifact,
}: {
  currentArtifact: Artifact;
  directiveVersion: number;
  lineage: ArtifactLineage;
  historyKey: string;
  isCurrent: () => boolean;
  rootRevisionTimeFor: (version: number) => number;
  rememberHistory: (key: string, history: ArtifactRevisionEntry[]) => void;
  register: RegisterArtifacts;
  registerFallback: () => void;
  setArtifact: Dispatch<SetStateAction<Artifact | null>>;
}) => {
  let history;
  try {
    history = await getArtifactRevisionHistory(lineage);
  } catch {
    if (isCurrent()) {
      registerFallback();
    }
    return;
  }
  if (!isCurrent()) {
    return;
  }

  const authoritativeVersion = history.currentVersion;
  let revisionHistory: ArtifactRevisionEntry[];
  let rootRevisionTime: number;
  let latest: Artifact;
  try {
    revisionHistory = projectArtifactRevisionHistory({ history, ...lineage });
    rootRevisionTime = rootRevisionTimeFor(authoritativeVersion);
    latest = await resolveLatestArtifact({
      currentArtifact,
      directiveVersion,
      authoritativeVersion,
      lineage,
      rootRevisionTime,
      history: revisionHistory,
    });
  } catch {
    if (isCurrent()) {
      registerFallback();
    }
    return;
  }
  if (!isCurrent()) {
    return;
  }
  if (authoritativeVersion === 1) {
    rememberHistory(historyKey, revisionHistory);
    register([latest], revisionHistory);
    setArtifact(latest);
    return;
  }

  let original: Artifact | null = null;
  if (revisionHistory.some((revision) => revision.available && revision.version === 1)) {
    try {
      original = projectArtifactRevisionSnapshot({
        snapshot: await getArtifactRevision({ ...lineage, version: 1 }),
        base: currentArtifact,
        rootTime: rootRevisionTime,
        history: revisionHistory,
      });
    } catch {
      if (isCurrent()) {
        register([latest], revisionHistory);
        setArtifact(latest);
      }
      return;
    }
  }
  if (!isCurrent()) {
    return;
  }
  rememberHistory(historyKey, revisionHistory);
  register(original ? [latest, original] : [latest], revisionHistory);
  setArtifact(original ?? latest);
};

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

  useEffect(() => {
    return () => {
      historyRequestRef.current += 1;
      loadedHistoryRef.current = null;
      rootRevisionTimeRef.current = null;
    };
  }, [messageId]);

  return useCallback(
    ({ currentArtifact, directiveVersion, now }: ArtifactRevisionHydration) => {
      if (directiveVersion <= 1 || !isArtifactPage) {
        historyRequestRef.current += 1;
        loadedHistoryRef.current = null;
        return false;
      }

      const identifier = currentArtifact.identifier ?? '';
      const lineage = { messageId, identifier };
      const lineageKey = `${messageId}:${identifier}`;
      const historyKey = `${lineageKey}:${directiveVersion}:${currentArtifact.title}:${currentArtifact.type}`;
      const fallbackArtifact: Artifact = {
        ...currentArtifact,
        id:
          directiveVersion === 1
            ? currentArtifact.id
            : artifactRevisionId({ ...lineage, version: directiveVersion }),
        knaufRevision: { identifier, version: directiveVersion },
      };

      const register: RegisterArtifacts = (additions, history) => {
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
      const registerFallback = () => {
        const update = (artifacts: Record<string, Artifact | undefined> | null) => ({
          ...artifacts,
          [fallbackArtifact.id]: fallbackArtifact,
        });
        setArtifacts(update);
        setVisibleArtifacts(update);
        setArtifact(fallbackArtifact);
      };

      if (loadedHistoryRef.current?.key === historyKey) {
        const revisionHistory = loadedHistoryRef.current.history;
        const authoritativeVersion = latestHistoryVersion(revisionHistory);
        if (directiveVersion !== authoritativeVersion) {
          register([], revisionHistory);
          return true;
        }
        const metadata = revisionHistory.find(
          (revision) => revision.available && revision.version === authoritativeVersion,
        );
        const latest = {
          ...currentArtifact,
          id: metadata?.id ?? artifactRevisionId({ ...lineage, version: authoritativeVersion }),
          title: metadata?.title ?? currentArtifact.title,
          type: metadata?.type ?? currentArtifact.type,
          language: metadata?.language ?? currentArtifact.language,
          knaufRevision: { identifier, version: authoritativeVersion },
          knaufRevisionHistory: revisionHistory,
        };
        register([latest], revisionHistory);
        if (authoritativeVersion === 1) {
          setArtifact(latest);
        }
        return true;
      }
      const requestId = ++historyRequestRef.current;
      void hydrateFromServer({
        currentArtifact,
        directiveVersion,
        lineage,
        historyKey,
        isCurrent: () => requestId === historyRequestRef.current,
        rootRevisionTimeFor: (authoritativeVersion) => {
          const previousRoot = rootRevisionTimeRef.current;
          const rootRevisionTime =
            previousRoot?.lineageKey === lineageKey
              ? previousRoot.time
              : now - authoritativeVersion + 1;
          rootRevisionTimeRef.current = { lineageKey, time: rootRevisionTime };
          return rootRevisionTime;
        },
        rememberHistory: (key, history) => {
          loadedHistoryRef.current = { key, history };
        },
        register,
        registerFallback,
        setArtifact,
      });
      return true;
    },
    [isArtifactPage, messageId, setArtifact, setArtifacts, setVisibleArtifacts],
  );
}
