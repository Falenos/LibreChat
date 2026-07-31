import { useState } from 'react';
import copy from 'copy-to-clipboard';
import { CopyCheck, Share2 } from 'lucide-react';
import type { TArtifactShareLocator } from 'librechat-data-provider';
import { Button, Spinner, TooltipAnchor, useToastContext } from '@librechat/client';
import type { Artifact } from '~/common';
import { useCreateArtifactSharedLinkMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { NotificationSeverity } from '~/common';
import { buildShareLinkUrl } from '~/utils';

export const getArtifactShareLocator = (artifact: Artifact): TArtifactShareLocator | null => {
  if (artifact.sourceFileId && artifact.type) {
    return {
      kind: 'file',
      fileId: artifact.sourceFileId,
      type: artifact.type,
      ...(artifact.language ? { language: artifact.language } : {}),
    };
  }
  if (Number.isInteger(artifact.index) && (artifact.index ?? -1) >= 0) {
    return { kind: 'directive', index: artifact.index as number };
  }
  return null;
};

export default function ShareArtifactButton({
  artifact,
  conversationId,
}: Readonly<{
  artifact: Artifact;
  conversationId: string;
}>) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [shareUrl, setShareUrl] = useState('');
  const locator = getArtifactShareLocator(artifact);

  const copyShareUrl = (url: string) => {
    const copied = copy(url, { format: 'text/plain' });
    showToast({
      message: localize(copied ? 'com_ui_link_copied' : 'com_ui_copy_failed'),
      severity: copied ? NotificationSeverity.SUCCESS : NotificationSeverity.ERROR,
      showIcon: true,
    });
  };

  const createMutation = useCreateArtifactSharedLinkMutation({
    onSuccess: (share) => {
      const url = buildShareLinkUrl(share.shareId);
      setShareUrl(url);
      copyShareUrl(url);
    },
    onError: () => {
      showToast({
        message: localize('com_knauf_artifact_share_error'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    },
  });

  const handleShare = () => {
    if (shareUrl) {
      copyShareUrl(shareUrl);
      return;
    }
    if (!locator || !artifact.messageId || createMutation.isLoading) {
      return;
    }
    createMutation.mutate({
      conversationId,
      messageId: artifact.messageId,
      locator,
    });
  };

  if (!locator || !artifact.messageId) {
    return null;
  }

  const label = createMutation.isLoading
    ? localize('com_knauf_artifact_share_loading')
    : shareUrl
      ? localize('com_ui_copy_link')
      : localize('com_knauf_artifact_share_title');

  return (
    <TooltipAnchor
      description={label}
      render={
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9"
          aria-label={label}
          disabled={createMutation.isLoading}
          onClick={handleShare}
        >
          {createMutation.isLoading ? (
            <Spinner className="size-4" aria-hidden="true" />
          ) : shareUrl ? (
            <CopyCheck size={16} aria-hidden="true" />
          ) : (
            <Share2 size={16} aria-hidden="true" />
          )}
        </Button>
      }
    />
  );
}
