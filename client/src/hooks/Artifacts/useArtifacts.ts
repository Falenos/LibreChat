import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Constants } from 'librechat-data-provider';
import { useRecoilState, useRecoilValue, useResetRecoilState } from 'recoil';
import { isCodeOnlyArtifact } from '~/utils/artifacts';
import { useArtifactsContext } from '~/Providers';
import { logger } from '~/utils';
import store from '~/store';

export default function useArtifacts() {
  const [activeTab, setActiveTab] = useState('preview');
  const { isSubmitting, latestMessageId, latestMessageText, conversationId } =
    useArtifactsContext();

  // [knauf] KK20-252 — remember whether the tab was chosen by the user.
  //
  // The panel auto-switches to `code` while an artifact streams so the user can
  // watch it type, and is meant to switch back to `preview` when it closes. The
  // switch-back is a regex over the raw message text, gated on `isSubmitting`,
  // so it never runs again once the turn ends: a directive that the regex cannot
  // match — truncated mid-emission, prose between the directive line and the
  // fence, two fences, or a `}` inside a title attribute — leaves the panel
  // pinned to `code` for the rest of the turn. The user then sees source where
  // they expected a render, with no way to tell whether the artifact is broken.
  //
  // The reconciliation below fixes that unconditionally at end of turn. This ref
  // is what keeps it from overriding a deliberate choice: `selectActiveTab` is
  // returned as `setActiveTab`, so it is what the Code/Preview control calls, and
  // anything arriving through it is treated as the user's decision and is never
  // undone. Effects inside this hook keep using the raw setter, so automatic
  // switches stay automatic. It resets per message, alongside the other
  // run-scoped refs, so a manual pick on one turn does not suppress
  // reconciliation on the next.
  const userSelectedTabRef = useRef<boolean>(false);
  const selectActiveTab = useCallback((tab: string) => {
    userSelectedTabRef.current = true;
    setActiveTab(tab);
  }, []);
  // End [knauf]

  const artifacts = useRecoilValue(store.artifactsState);
  const resetArtifacts = useResetRecoilState(store.artifactsState);
  const resetCurrentArtifactId = useResetRecoilState(store.currentArtifactId);
  const [currentArtifactId, setCurrentArtifactId] = useRecoilState(store.currentArtifactId);

  const { orderedArtifactIds, latestAutoOpenArtifactId } = useMemo(() => {
    const ids = Object.keys(artifacts ?? {}).sort(
      (a, b) => (artifacts?.[a]?.lastUpdateTime ?? 0) - (artifacts?.[b]?.lastUpdateTime ?? 0),
    );
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      if (!isCodeOnlyArtifact(artifacts?.[id]?.type)) {
        return { orderedArtifactIds: ids, latestAutoOpenArtifactId: id };
      }
    }
    return { orderedArtifactIds: ids, latestAutoOpenArtifactId: null };
  }, [artifacts]);

  const prevIsSubmittingRef = useRef<boolean>(false);
  const lastContentRef = useRef<string | null>(null);
  const hasEnclosedArtifactRef = useRef<boolean>(false);
  const hasAutoSwitchedToCodeRef = useRef<boolean>(false);
  const lastRunMessageIdRef = useRef<string | null>(null);
  const prevConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    const resetState = () => {
      resetArtifacts();
      resetCurrentArtifactId();
      prevConversationIdRef.current = conversationId;
      lastRunMessageIdRef.current = null;
      lastContentRef.current = null;
      hasEnclosedArtifactRef.current = false;
      hasAutoSwitchedToCodeRef.current = false;
    };
    if (conversationId !== prevConversationIdRef.current && prevConversationIdRef.current != null) {
      resetState();
    } else if (conversationId === Constants.NEW_CONVO) {
      resetState();
    }
    prevConversationIdRef.current = conversationId;
    /** Resets artifacts when unmounting */
    return () => {
      logger.log('artifacts_visibility', 'Unmounting artifacts');
      resetState();
    };
  }, [conversationId, resetArtifacts, resetCurrentArtifactId]);

  /**
   * Read currentArtifactId in effects without subscribing as a dependency.
   * Adding it to effect deps fires auto-select on every reset, breaking toggle-close.
   */
  const currentArtifactIdRef = useRef(currentArtifactId);
  currentArtifactIdRef.current = currentArtifactId;

  useEffect(() => {
    if (orderedArtifactIds.length === 0) return;
    const currentId = currentArtifactIdRef.current;
    if (currentId != null && orderedArtifactIds.includes(currentId)) return;
    if (latestAutoOpenArtifactId == null) {
      if (currentId != null) {
        resetCurrentArtifactId();
      }
      return;
    }
    setCurrentArtifactId(latestAutoOpenArtifactId);
  }, [latestAutoOpenArtifactId, orderedArtifactIds, resetCurrentArtifactId, setCurrentArtifactId]);

  /**
   * Manage artifact selection and code tab switching for non-enclosed artifacts
   * Runs when artifact content changes
   */
  useEffect(() => {
    // Check if we just finished submitting (transition from true to false)
    const justFinishedSubmitting = prevIsSubmittingRef.current && !isSubmitting;
    prevIsSubmittingRef.current = isSubmitting;

    // Only process during submission OR when just finished
    if (!isSubmitting && !justFinishedSubmitting) {
      return;
    }
    if (orderedArtifactIds.length === 0) {
      return;
    }
    if (latestMessageId == null) {
      return;
    }
    const latestArtifactId = orderedArtifactIds[orderedArtifactIds.length - 1];
    const latestArtifact = artifacts?.[latestArtifactId];
    if (latestArtifact?.content === lastContentRef.current && !justFinishedSubmitting) {
      return;
    }
    lastContentRef.current = latestArtifact?.content ?? null;
    if (isCodeOnlyArtifact(latestArtifact?.type)) {
      return;
    }

    setCurrentArtifactId(latestArtifactId);

    // Only switch to code tab if we haven't detected an enclosed artifact yet
    if (!hasEnclosedArtifactRef.current && !hasAutoSwitchedToCodeRef.current) {
      const artifactStartContent = latestArtifact?.content?.slice(0, 50) ?? '';
      if (artifactStartContent.length > 0 && latestMessageText.includes(artifactStartContent)) {
        setActiveTab('code');
        hasAutoSwitchedToCodeRef.current = true;
      }
    }

    // [knauf] KK20-252 — the switch back to `preview`, guaranteed.
    //
    // The enclosure watcher below is the only other route out of `code`, and it
    // is gated on `isSubmitting`, so it cannot fire once the turn is over. This
    // runs exactly on the streaming→idle transition and does not care why the
    // watcher missed: whatever the emission looked like, if we put the user on
    // `code` and they did not ask for it, the artifact they clicked is now
    // complete and they should be looking at it.
    //
    // Deliberately not conditioned on the artifact parsing cleanly. A broken
    // artifact showing an empty pane or a Sandpack error is a legible failure;
    // source code sitting where a render belongs is not — that is what made this
    // look like the model had emitted the wrong thing.
    if (justFinishedSubmitting && hasAutoSwitchedToCodeRef.current && !userSelectedTabRef.current) {
      logger.log('artifacts', 'Generation finished; returning to preview tab');
      setActiveTab('preview');
      hasAutoSwitchedToCodeRef.current = false;
    }
    // End [knauf]
  }, [
    artifacts,
    isSubmitting,
    latestMessageId,
    latestMessageText,
    orderedArtifactIds,
    setCurrentArtifactId,
  ]);

  /**
   * Watch for enclosed artifact pattern during message generation
   * Optimized: Exits early if already detected, only checks during streaming
   */
  useEffect(() => {
    if (!isSubmitting || hasEnclosedArtifactRef.current) {
      return;
    }

    const hasEnclosedArtifact =
      /:::artifact(?:\{[^}]*\})?(?:\s|\n)*(?:```[\s\S]*?```(?:\s|\n)*)?:::/m.test(
        latestMessageText.trim(),
      );

    if (hasEnclosedArtifact) {
      logger.log('artifacts', 'Enclosed artifact detected during generation, switching to preview');
      setActiveTab('preview');
      hasEnclosedArtifactRef.current = true;
      hasAutoSwitchedToCodeRef.current = false;
    }
  }, [isSubmitting, latestMessageText]);

  useEffect(() => {
    if (latestMessageId !== lastRunMessageIdRef.current) {
      lastRunMessageIdRef.current = latestMessageId;
      hasEnclosedArtifactRef.current = false;
      hasAutoSwitchedToCodeRef.current = false;
      // [knauf] KK20-252 — a manual tab choice is scoped to the run it was made
      // in, so the next artifact still reconciles to preview.
      userSelectedTabRef.current = false;
      // End [knauf]
    }
  }, [latestMessageId]);

  // [knauf] KK20-410 — derive traversal from immutable lineage metadata, not global render order.
  const currentArtifact = currentArtifactId != null ? artifacts?.[currentArtifactId] : null;
  const artifactVersions = useMemo(() => {
    const revision = currentArtifact?.knaufRevision;
    if (!revision || !currentArtifact?.messageId) {
      return [];
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
    const versions = new Map<number, { id: string | null; version: number; available: boolean }>(
      (currentArtifact.knaufUnavailableVersions ?? []).map((version) => [
        version,
        { id: null, version, available: false },
      ]),
    );
    for (const available of availableVersions) {
      versions.set(available.version, available);
    }
    return [...versions.values()].sort((left, right) => left.version - right.version);
  }, [artifacts, currentArtifact]);
  const currentIndex = artifactVersions.findIndex(({ id }) => id === currentArtifactId);
  // End [knauf]

  return {
    activeTab,
    // [knauf] KK20-252 — the wrapper, so a tab the user picked is recorded as
    // theirs and survives the reconciliation above.
    setActiveTab: selectActiveTab,
    // End [knauf]
    currentIndex,
    currentArtifact,
    // [knauf] KK20-410 — expose the lineage-scoped selector model to the Preview panel.
    artifactVersions,
    // End [knauf]
    orderedArtifactIds,
    setCurrentArtifactId,
  };
}
