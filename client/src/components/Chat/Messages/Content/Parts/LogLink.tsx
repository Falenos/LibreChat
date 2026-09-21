import React, { useContext, useRef, useState } from 'react';
import { useToastContext } from '@librechat/client';
import { FileSources, sharedFileDownload } from 'librechat-data-provider';
import { useCodeOutputDownload, useFileDownload } from '~/data-provider';
import { isHttpDownloadTarget, triggerDownload } from '~/utils';
import { useShareContext } from '~/Providers';
import { AuthContext, useLocalize } from '~/hooks';

interface LogLinkProps {
  href: string;
  filename: string;
  file_id?: string;
  user?: string;
  source?: string;
  children: React.ReactNode;
}

interface AttachmentLinkOptions {
  href: string;
  filename: string;
  file_id?: string;
  user?: string;
  source?: string;
}

/**
 * Determines if a file is stored locally (not an external API URL).
 * Files with these sources are stored on the LibreChat server and should
 * use the /api/files/download endpoint instead of direct URL access.
 */
const isLocallyStoredSource = (source?: string): boolean => {
  if (!source) {
    return false;
  }
  return [
    FileSources.local,
    FileSources.firebase,
    FileSources.s3,
    FileSources.cloudfront,
    FileSources.azure_blob,
  ].includes(source as FileSources);
};

export const useAttachmentLink = ({
  href,
  filename,
  file_id,
  user,
  source,
}: AttachmentLinkOptions) => {
  const { showToast } = useToastContext();
  const { shareId } = useShareContext();
  // [knauf] KK20-366 — freshly streamed translated attachments can precede their user metadata.
  const currentUser = useContext(AuthContext)?.user;
  const downloadUser = user ?? currentUser?.id;
  // End [knauf]
  // [knauf] KK20-366 — surface failed generated-file downloads instead of only logging them.
  const localize = useLocalize();
  // End [knauf]
  // [knauf] KK20-366 — every attachment surface shares this synchronous lock to prevent
  // duplicate downloads before its busy state can render.
  const [isDownloading, setIsDownloading] = useState(false);
  const downloadingRef = useRef(false);
  // End [knauf]

  const useLocalDownload = isLocallyStoredSource(source) && !!file_id && !!downloadUser;
  const { refetch: downloadFromApi } = useFileDownload(downloadUser, file_id, { source });
  const { refetch: downloadFromUrl } = useCodeOutputDownload(href);

  const handleDownload = async (event: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => {
    event.preventDefault();
    if (downloadingRef.current) {
      return;
    }
    downloadingRef.current = true;
    setIsDownloading(true);
    try {
      // In a shared view, a snapshotted file's href is rewritten to the share
      // route; download it through the share-scoped path (authorized by share
      // permission, not owner ACL). Non-snapshotted files fall through so the
      // original href / code-output path still works when snapshots are disabled.
      if (shareId && file_id && href.startsWith('/api/share/')) {
        triggerDownload(sharedFileDownload(shareId, file_id), filename);
        return;
      }

      if (!useLocalDownload && isHttpDownloadTarget(href)) {
        triggerDownload(href, filename);
        return;
      }

      const stream = useLocalDownload ? await downloadFromApi() : await downloadFromUrl();
      if (stream.data == null || stream.data === '') {
        console.error('Error downloading file: No data found');
        showToast({
          status: 'error',
          // [knauf] KK20-366 — use the existing localized download error for empty responses.
          message: localize('com_ui_download_error'),
          // End [knauf]
        });
        return;
      }
      triggerDownload(stream.data, filename);
    } catch (error) {
      console.error('Error downloading file:', error);
      // [knauf] KK20-366 — keep the card recoverable and tell the user the request failed.
      showToast({
        status: 'error',
        message: localize('com_ui_download_error'),
      });
      // End [knauf]
    } finally {
      downloadingRef.current = false;
      setIsDownloading(false);
    }
  };

  return { handleDownload, isDownloading };
};

const LogLink: React.FC<LogLinkProps> = ({ href, filename, file_id, user, source, children }) => {
  const { handleDownload, isDownloading } = useAttachmentLink({
    href,
    filename,
    file_id,
    user,
    source,
  });
  return (
    <a
      href={href}
      onClick={handleDownload}
      target="_blank"
      rel="noopener noreferrer"
      aria-busy={isDownloading}
      aria-disabled={isDownloading || undefined}
      className="!text-blue-400 visited:!text-purple-400 hover:underline aria-disabled:pointer-events-none aria-disabled:cursor-wait"
    >
      {children}
    </a>
  );
};

export default LogLink;
