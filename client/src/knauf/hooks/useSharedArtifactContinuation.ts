import { useEffect, useRef, type RefObject } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useGetSharedMessages } from 'librechat-data-provider/react-query';
import { Constants } from 'librechat-data-provider';
import { useToastContext } from '@librechat/client';
import { NotificationSeverity } from '~/common';
import useLocalize from '~/hooks/useLocalize';
import { useChatFormContext } from '~/Providers';
import { extractSharedArtifactBody } from '~/knauf/utils/artifactBody';
import {
  SHARED_ARTIFACT_PARAM,
  buildSharedArtifactPrompt,
} from '~/knauf/utils/sharedArtifactContinuation';

export default function useSharedArtifactContinuation({
  conversationId,
  textAreaRef,
}: Readonly<{
  conversationId: string;
  textAreaRef: RefObject<HTMLTextAreaElement>;
}>) {
  const localize = useLocalize();
  const methods = useChatFormContext();
  const { showToast } = useToastContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const shareId = searchParams.get(SHARED_ARTIFACT_PARAM) ?? '';
  const enabled = conversationId === Constants.NEW_CONVO && shareId.length > 0;
  const handledShareIdRef = useRef<string | null>(null);
  const query = useGetSharedMessages(shareId, { enabled, retry: false });

  useEffect(() => {
    if (!enabled || handledShareIdRef.current === shareId) {
      return;
    }
    if (!query.data && !query.isError) {
      return;
    }

    handledShareIdRef.current = shareId;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete(SHARED_ARTIFACT_PARAM);
    setSearchParams(nextParams, { replace: true });

    if (query.isError || query.data?.kind !== 'artifact' || !query.data.artifact) {
      showToast({
        message: localize('com_knauf_artifact_continue_error'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
      return;
    }

    const artifact = {
      ...query.data.artifact,
      content: extractSharedArtifactBody(query.data.artifact.content, query.data.artifact.type),
    };
    const importedPrompt = buildSharedArtifactPrompt(
      artifact,
      localize('com_knauf_artifact_continue_prompt'),
      localize('com_knauf_artifact_continue_request'),
    );
    const currentText = methods.getValues('text');
    const nextText =
      typeof currentText === 'string' && currentText.trim().length > 0
        ? `${importedPrompt}\n\n${currentText}`
        : importedPrompt;

    methods.setValue('text', nextText, { shouldDirty: true, shouldValidate: true });
    textAreaRef.current?.focus();
  }, [
    enabled,
    localize,
    methods,
    query.data,
    query.isError,
    searchParams,
    setSearchParams,
    shareId,
    showToast,
    textAreaRef,
  ]);
}
