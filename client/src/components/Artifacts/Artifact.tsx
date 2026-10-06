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
import { artifactsState } from '~/store/artifacts';
// [knauf] KK20-410 — keep revision hydration in fork-owned code.
import useArtifactRevisionHydration from '~/knauf/hooks/useArtifactRevisionHydration';
import { artifactRootId } from '~/knauf/utils/artifactRevisions';
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
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  // [knauf] KK20-410 — server-owned history normalizes directive metadata and binds V1.
  const hydrateArtifactRevision = useArtifactRevisionHydration({
    isArtifactPage: isArtifactRoute(location.pathname),
    messageId,
    setArtifact,
  });
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
    // [knauf] KK20-410 — stable generated-artifact keys include the message lineage.
    const artifactKey = artifactRootId({ identifier, type, title, messageId });
    const defaultArtifactKey = artifactRootId({
      identifier: defaultIdentifier,
      type: defaultType,
      title: defaultTitle,
      messageId,
    });
    // End [knauf]

    throttledUpdateRef.current(() => {
      const now = Date.now();
      if (artifactKey === defaultArtifactKey) {
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
        // [knauf] KK20-410 — carry the rendered locator only as a hydration hint.
        knaufRevision: { identifier, version },
        // End [knauf]
      };

      // [knauf] KK20-410 — fork-owned hydration handles persisted revision lineages.
      if (
        hydrateArtifactRevision({
          currentArtifact,
          directiveVersion: version,
          now,
        })
      ) {
        return;
      }
      // End [knauf]

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
    hydrateArtifactRevision,
  ]);

  useEffect(() => {
    resetCounter();
    updateArtifact();
  }, [updateArtifact, resetCounter]);

  return <ArtifactButton artifact={artifact} />;
}
