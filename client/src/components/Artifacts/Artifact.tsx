import React, { useEffect, useCallback, useRef, useState } from 'react';
import throttle from 'lodash/throttle';
import { visit } from 'unist-util-visit';
import { useSetRecoilState } from 'recoil';
import { useLocation } from 'react-router-dom';
import type { Pluggable } from 'unified';
import type { Artifact } from '~/common';
import { useMessageContext, useArtifactContext } from '~/Providers';
import { logger, isArtifactRoute } from '~/utils';
// [knauf] KK20-252 — single-file body extraction for compiled artifact types;
// see the call site in `updateArtifact` below.
import { extractArtifactBody } from '~/knauf/utils/artifactBody';
// End [knauf]
import { artifactsState, visibleArtifacts } from '~/store/artifacts';
// [knauf] KK20-410 — hydrate the complete immutable revision lineage.
import {
  getArtifactRevision,
  getArtifactRevisionHistory,
} from '~/knauf/data-provider/data-service';
import {
  artifactRevisionId,
  artifactRootId,
  isArtifactRevisionHistoryUnavailable,
  projectArtifactRevisionHistory,
} from '~/knauf/utils/artifactRevisions';
// End [knauf]
import ArtifactButton from './ArtifactButton';

export const artifactPlugin: Pluggable = () => {
  return (tree) => {
    visit(tree, ['textDirective', 'leafDirective', 'containerDirective'], (node, index, parent) => {
      if (node.type === 'textDirective') {
        const replacementText = `:${node.name}`;
        if (parent && Array.isArray(parent.children) && typeof index === 'number') {
          parent.children[index] = {
            type: 'text',
            value: replacementText,
          };
        }
      }
      if (node.name !== 'artifact') {
        return;
      }
      node.data = {
        hName: node.name,
        hProperties: node.attributes,
        ...node.data,
      };
      return node;
    });
  };
};

const defaultTitle = 'untitled';
const defaultType = 'unknown';
const defaultIdentifier = 'lc-no-identifier';

export function Artifact({
  node: _node,
  ...props
}: Artifact & {
  children: React.ReactNode | { props: { children: React.ReactNode } };
  node: unknown;
  version?: string | number;
}) {
  const location = useLocation();
  const { messageId } = useMessageContext();
  const { getNextIndex, resetCounter } = useArtifactContext();
  const artifactIndex = useRef(getNextIndex(false)).current;

  const setArtifacts = useSetRecoilState(artifactsState);
  const setVisibleArtifacts = useSetRecoilState(visibleArtifacts);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  // [knauf] NO-TICKET — keep Version 1's sort position stable across later revisions.
  const rootRevisionTimeRef = useRef<{ artifactKey: string; time: number } | null>(null);
  const historyRequestRef = useRef(0);
  const loadedHistoryRef = useRef<string | null>(null);
  // End [knauf]

  const throttledUpdateRef = useRef(
    throttle((updateFn: () => void) => {
      updateFn();
    }, 25),
  );

  const updateArtifact = useCallback(() => {
    const title = props.title ?? defaultTitle;
    const type = props.type ?? defaultType;

    // [knauf] KK20-252 — for a type that gets compiled, take the fenced code block
    // rather than every child of the directive concatenated. `extractContent` is
    // `children.map(extractContent).join('')`, so anything the model writes after
    // the fence — an HTML comment, a `<style>` block, a closing note — is glued
    // onto the end of App.tsx and Sandpack throws `Unexpected token`. Observed
    // twice on this ticket. Falls back to the upstream call for markdown artifacts
    // and whenever no code block is present. See knauf/utils/artifactBody.
    const content = extractArtifactBody(props.children, type);
    // End [knauf]
    logger.log('artifacts', 'updateArtifact: content.length', content.length);

    const identifier = props.identifier ?? defaultIdentifier;
    const parsedVersion = Number.parseInt(String(props.version ?? 1), 10);
    const version = Number.isSafeInteger(parsedVersion) && parsedVersion > 0 ? parsedVersion : 1;
    const artifactKey = artifactRootId({ identifier, type, title, messageId });

    throttledUpdateRef.current(() => {
      const now = Date.now();
      if (artifactKey === `${defaultIdentifier}_${defaultType}_${defaultTitle}_${messageId}`) {
        return;
      }

      const currentArtifact: Artifact = {
        id: artifactKey,
        identifier,
        title,
        type,
        content,
        messageId,
        index: artifactIndex,
        lastUpdateTime: now,
        knaufRevision: { identifier, version },
      };

      // [knauf] KK20-410 — the backend advances the source message in place but
      // retains inverse patches. Hydrate every reconstructable snapshot in one
      // authenticated read so the selector does not depend on which chat cards
      // happened to mount or get clicked.
      if (version > 1 && isArtifactRoute(location.pathname)) {
        const revisionId = artifactRevisionId({ messageId, identifier, version });
        const latest = { ...currentArtifact, id: revisionId };
        const historyKey = `${messageId}:${identifier}:${version}`;
        const registerLatest = (artifacts: Record<string, Artifact | undefined> | null) => ({
          ...artifacts,
          [revisionId]: latest,
        });
        setArtifacts(registerLatest);
        setVisibleArtifacts(registerLatest);

        if (loadedHistoryRef.current === historyKey) {
          return;
        }
        loadedHistoryRef.current = historyKey;
        const requestId = ++historyRequestRef.current;
        void getArtifactRevisionHistory({ messageId, identifier })
          .then((history) => {
            if (requestId !== historyRequestRef.current) {
              return;
            }
            const previousRoot = rootRevisionTimeRef.current;
            const rootRevisionTime =
              previousRoot?.artifactKey === artifactKey ? previousRoot.time : now - 1;
            rootRevisionTimeRef.current = { artifactKey, time: rootRevisionTime };
            const { artifacts: revisions } = projectArtifactRevisionHistory({
              history,
              base: currentArtifact,
              rootTime: rootRevisionTime,
            });
            const registerHistory = (artifacts: Record<string, Artifact | undefined> | null) => ({
              ...artifacts,
              ...revisions,
            });
            setArtifacts(registerHistory);
            setVisibleArtifacts(registerHistory);
            setArtifact(revisions[artifactKey] ?? revisions[revisionId] ?? latest);
          })
          .catch(async (error) => {
            if (requestId !== historyRequestRef.current) {
              return;
            }
            if (!isArtifactRevisionHistoryUnavailable(error)) {
              setArtifact(latest);
              return;
            }
            try {
              const snapshot = await getArtifactRevision({
                messageId,
                identifier,
                version: 1,
              });
              if (requestId !== historyRequestRef.current) {
                return;
              }
              const original = {
                ...currentArtifact,
                ...snapshot,
                id: artifactKey,
                lastUpdateTime: now - 1,
                knaufRevision: { identifier, version: 1 },
              };
              const registerOriginal = (
                artifacts: Record<string, Artifact | undefined> | null,
              ) => ({
                ...artifacts,
                [artifactKey]: original,
              });
              setArtifacts(registerOriginal);
              setVisibleArtifacts(registerOriginal);
              setArtifact(original);
            } catch {
              if (requestId === historyRequestRef.current) {
                setArtifact(latest);
              }
            }
          });
        return;
      }
      // End [knauf]

      historyRequestRef.current += 1;
      loadedHistoryRef.current = null;
      if (!isArtifactRoute(location.pathname)) {
        return setArtifact(currentArtifact);
      }

      setArtifacts((prevArtifacts) => {
        if (
          prevArtifacts?.[artifactKey] != null &&
          prevArtifacts[artifactKey]?.content === content
        ) {
          return prevArtifacts;
        }

        return {
          ...prevArtifacts,
          [artifactKey]: currentArtifact,
        };
      });

      setArtifact(currentArtifact);
    });
  }, [
    props.type,
    props.title,
    setArtifacts,
    props.children,
    props.identifier,
    props.version,
    messageId,
    artifactIndex,
    location.pathname,
    setVisibleArtifacts,
  ]);

  useEffect(() => {
    resetCounter();
    updateArtifact();
  }, [updateArtifact, resetCounter]);

  return <ArtifactButton artifact={artifact} />;
}
