import { useState, useMemo, useCallback, useRef } from 'react';
import { useDrop } from 'react-dnd';
import { useToastContext } from '@librechat/client';
import { NativeTypes } from 'react-dnd-html5-backend';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import {
  Tools,
  QueryKeys,
  Constants,
  inferMimeType,
  EToolResources,
  EModelEndpoint,
  mergeFileConfig,
  AgentCapabilities,
  resolveEndpointType,
  isAssistantsEndpoint,
  getEndpointFileConfig,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { DropTargetMonitor } from 'react-dnd';
import type * as t from 'librechat-data-provider';
import store, { ephemeralAgentByConvoId } from '~/store';
import useFileHandling from './useFileHandling';
import { isEphemeralAgent } from '~/common';
import useLocalize from '../useLocalize';

// [knauf] Knauf File Search drag-routing, extracted from useDragHelpers.handleDrop to
// keep that handler under SonarQube's cognitive-complexity limit (S3776). Decides
// whether a drop should auto-route into File Search instead of the upstream
// capability-picker modal, applies the routing through injected callbacks, and returns
// true when it handled the drop (the caller then returns early):
//   • Default Knauf chat (azureOpenAI, including Model Router Chat Completions):
//     enable file_search on the ephemeral agent, then route. Gated on the platform capability, NOT
//     fileSearchAllowedByAgent — this drop is what enables file_search (chicken-and-egg).
//   • Custom agent chat (endpoint `agents`) where File Search is the SOLE destination:
//     route into the agent's own file_search tool (no ephemeral toggle). If the agent
//     also offers code execution / context, returns false so the modal still shows.
// Documents embed; images divert to vision via the per-file override in useFileHandling.
// KK20-190.
function routeKnaufFileSearchDrop({
  endpoint,
  fileSearchEnabled,
  fileSearchAllowedByAgent,
  codeEnabled,
  codeAllowedByAgent,
  contextEnabled,
  enableEphemeralFileSearch,
  routeToFileSearch,
}: {
  endpoint?: string;
  fileSearchEnabled: boolean;
  fileSearchAllowedByAgent: boolean;
  codeEnabled: boolean;
  codeAllowedByAgent: boolean;
  contextEnabled: boolean;
  enableEphemeralFileSearch: () => void;
  routeToFileSearch: () => void;
}): boolean {
  if (!fileSearchEnabled) {
    return false;
  }
  if (endpoint === EModelEndpoint.azureOpenAI) {
    enableEphemeralFileSearch();
    routeToFileSearch();
    return true;
  }
  const agentFileSearchOnly =
    endpoint === EModelEndpoint.agents &&
    fileSearchAllowedByAgent &&
    !(codeEnabled && codeAllowedByAgent) &&
    !contextEnabled;
  if (agentFileSearchOnly) {
    routeToFileSearch();
    return true;
  }
  return false;
}
// End [knauf]

export default function useDragHelpers() {
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const [showModal, setShowModal] = useState(false);
  const [draggedFiles, setDraggedFiles] = useState<File[]>([]);
  const conversation = useRecoilValue(store.conversationByIndex(0)) || undefined;
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );

  const isAssistants = useMemo(
    () => isAssistantsEndpoint(conversation?.endpoint),
    [conversation?.endpoint],
  );

  const { handleFiles } = useFileHandling();

  const handleOptionSelect = useCallback(
    (toolResource: EToolResources | undefined) => {
      /** File search is not automatically enabled to simulate legacy behavior */
      if (toolResource && toolResource !== EToolResources.file_search) {
        setEphemeralAgent((prev) => ({
          ...prev,
          [toolResource]: true,
        }));
      }
      handleFiles(draggedFiles, toolResource);
      setShowModal(false);
      setDraggedFiles([]);
    },
    [draggedFiles, handleFiles, setEphemeralAgent],
  );

  /** Use refs to avoid re-creating the drop handler */
  const handleFilesRef = useRef(handleFiles);
  const conversationRef = useRef(conversation);

  handleFilesRef.current = handleFiles;
  conversationRef.current = conversation;

  const handleDrop = useCallback(
    (item: { files: File[] }) => {
      /** Early block: leverage endpoint file config to prevent drag/drop on disabled endpoints */
      const currentEndpoint = conversationRef.current?.endpoint ?? 'default';
      const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);

      /** Get agent data from cache; if absent, provider-specific file config restrictions are bypassed client-side */
      const agentId = conversationRef.current?.agent_id;
      const agent = agentId
        ? queryClient.getQueryData<t.Agent>([QueryKeys.agent, agentId])
        : undefined;

      const currentEndpointType = resolveEndpointType(
        endpointsConfig,
        currentEndpoint,
        agent?.provider,
      );
      const cfg = queryClient.getQueryData<t.TFileConfig>([QueryKeys.fileConfig]);
      if (cfg) {
        const mergedCfg = mergeFileConfig(cfg);
        const endpointCfg = getEndpointFileConfig({
          fileConfig: mergedCfg,
          endpoint: currentEndpoint,
          endpointType: currentEndpointType,
        });
        if (endpointCfg?.disabled === true) {
          showToast({
            message: localize('com_ui_attach_error_disabled'),
            status: 'error',
          });
          return;
        }
      }

      if (isAssistants) {
        handleFilesRef.current(item.files);
        return;
      }

      const agentsConfig = endpointsConfig?.[EModelEndpoint.agents];
      const capabilities = agentsConfig?.capabilities ?? defaultAgentCapabilities;
      const fileSearchEnabled = capabilities.includes(AgentCapabilities.file_search) === true;
      const codeEnabled = capabilities.includes(AgentCapabilities.execute_code) === true;
      const contextEnabled = capabilities.includes(AgentCapabilities.context) === true;

      let fileSearchAllowedByAgent = true;
      let codeAllowedByAgent = true;

      if (agentId && !isEphemeralAgent(agentId)) {
        if (agent) {
          const agentTools = agent.tools as string[] | undefined;
          fileSearchAllowedByAgent = agentTools?.includes(Tools.file_search) ?? false;
          codeAllowedByAgent = agentTools?.includes(Tools.execute_code) ?? false;
        } else {
          fileSearchAllowedByAgent = false;
          codeAllowedByAgent = false;
        }
      }

      // [knauf] Auto-route Knauf File Search drops (default chat + agent chats) instead
      // of the upstream capability-picker modal — see routeKnaufFileSearchDrop. KK20-190.
      const conv = conversationRef.current;
      const handledByKnauf = routeKnaufFileSearchDrop({
        endpoint: conv?.endpoint ?? undefined,
        fileSearchEnabled,
        fileSearchAllowedByAgent,
        codeEnabled,
        codeAllowedByAgent,
        contextEnabled,
        enableEphemeralFileSearch: () =>
          setEphemeralAgent((prev) => ({ ...prev, [EToolResources.file_search]: true })),
        routeToFileSearch: () => handleFilesRef.current(item.files, EToolResources.file_search),
      });
      if (handledByKnauf) {
        return;
      }
      // End [knauf]

      /** Determine if dragged files are all images (enables the base image option) */
      const allImages = item.files.every((f) =>
        inferMimeType(f.name, f.type)?.startsWith('image/'),
      );

      const shouldShowModal =
        allImages ||
        (fileSearchEnabled && fileSearchAllowedByAgent) ||
        (codeEnabled && codeAllowedByAgent) ||
        contextEnabled;

      if (!shouldShowModal) {
        // Fallback: directly handle files without showing modal
        handleFilesRef.current(item.files);
        return;
      }
      setDraggedFiles(item.files);
      setShowModal(true);
    },
    // [knauf] setEphemeralAgent added for the File Search drag-drop parity block. KK20-190.
    [isAssistants, queryClient, showToast, localize, setEphemeralAgent],
    // End [knauf]
  );

  const [{ canDrop, isOver }, drop] = useDrop(
    () => ({
      accept: [NativeTypes.FILE],
      drop: handleDrop,
      canDrop: () => true,
      collect: (monitor: DropTargetMonitor) => {
        /** Optimize collect to reduce re-renders */
        const isOver = monitor.isOver();
        const canDrop = monitor.canDrop();
        return { isOver, canDrop };
      },
    }),
    [handleDrop],
  );

  return {
    canDrop,
    isOver,
    drop,
    showModal,
    setShowModal,
    draggedFiles,
    handleOptionSelect,
  };
}
