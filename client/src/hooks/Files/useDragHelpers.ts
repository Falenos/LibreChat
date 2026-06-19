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
      const cfg = queryClient.getQueryData<t.FileConfig>([QueryKeys.fileConfig]);
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

      // [knauf] Drag-drop parity with the "Upload files" menu (AttachFileMenu).
      // On the Knauf Azure File Search chat, route dropped files straight into
      // File Search (RAG) — documents embed, and useFileHandling's per-file image
      // override diverts images to the vision path — instead of popping the
      // capability-picker modal, which exposes the file_search/code/context
      // mechanism the menu deliberately hides. We gate on the platform capability
      // (fileSearchEnabled), NOT fileSearchAllowedByAgent (the same chicken-and-egg
      // reasoning as the menu: this drop is what enables file_search on the
      // ephemeral agent). Assistants (handled above), custom agents, and non-Azure
      // endpoints fall through to the upstream modal. NB: parity here covers the
      // default ephemeral azureOpenAI chat only — a custom Azure-Responses *agent*
      // runs under endpoint `agents` (not `azureOpenAI`), so on drop it intentionally
      // keeps the upstream modal even though the menu would route it to File Search.
      // KK20-190 (upload-guidance).
      const conv = conversationRef.current;
      const knaufFileSearchChat =
        conv?.endpoint === EModelEndpoint.azureOpenAI &&
        conv?.useResponsesApi === true &&
        fileSearchEnabled;
      if (knaufFileSearchChat) {
        setEphemeralAgent((prev) => ({
          ...prev,
          [EToolResources.file_search]: true,
        }));
        handleFilesRef.current(item.files, EToolResources.file_search);
        return;
      }
      // End [knauf]

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
