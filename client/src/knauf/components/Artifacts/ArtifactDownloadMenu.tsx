import { useContext, useState } from 'react';
import { Download, FileCode2, FileText, Image } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  useToastContext,
} from '@librechat/client';
import type { Artifact } from '~/common';
import { NotificationSeverity } from '~/common';
import { useFileDownload } from '~/data-provider';
import useArtifactProps from '~/hooks/Artifacts/useArtifactProps';
import { useCodeState } from '~/Providers/EditorContext';
import { AuthContext, useLocalize } from '~/hooks';
import { postArtifactExport } from '~/knauf/data-provider/data-service';
import { triggerDownload } from '~/utils/downloadFile';

type ExportFormat = 'source' | 'png' | 'pdf';

type ExportError = {
  code?: unknown;
  details?: { actualPages?: unknown; maxPages?: unknown };
};

const exportErrorMessage = (error: unknown, localize: ReturnType<typeof useLocalize>): string => {
  const { code, details } = (error ?? {}) as ExportError;
  const pages = {
    actualPages: String(details?.actualPages ?? ''),
    maxPages: String(details?.maxPages ?? ''),
  };
  if (code === 'artifact_page_limit') {
    return localize('com_knauf_artifact_download_page_limit', pages);
  }
  if (code === 'artifact_png_height_limit') {
    return localize('com_knauf_artifact_download_png_limit', pages);
  }
  if (code === 'artifact_output_too_large') {
    return localize('com_knauf_artifact_download_output_too_large');
  }
  if (code === 'artifact_renderer_busy' || code === 'artifact_rate_limit') {
    return localize('com_knauf_artifact_download_busy');
  }
  return localize('com_knauf_artifact_download_error');
};

const safeTitle = (title: string): string => {
  const sanitized = title
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
    .trim()
    .replace(/^\.+/u, '');
  return /[\p{L}\p{N}]/u.test(sanitized) ? sanitized : 'artifact';
};

export default function ArtifactDownloadMenu({
  artifact,
  shareId,
}: Readonly<{ artifact: Artifact; shareId?: string }>) {
  const localize = useLocalize();
  const user = useContext(AuthContext)?.user;
  const { showToast } = useToastContext();
  const { currentCode } = useCodeState();
  const { fileKey } = useArtifactProps({ artifact });
  const [isExporting, setIsExporting] = useState(false);
  const content = currentCode || artifact.content || '';
  const isNativeSvg = artifact.type === 'image/svg+xml';
  const isOriginalUnavailable = !!shareId && artifact.type === 'spreadsheet-preview';
  const originalFileId = shareId ? undefined : artifact.sourceFileId;
  const { refetch: downloadOriginal } = useFileDownload(user?.id, originalFileId, {
    direct: false,
  });

  const download = async (format: ExportFormat) => {
    if (
      (!content && !(format === 'source' && originalFileId)) ||
      (format === 'source' && isOriginalUnavailable) ||
      isExporting
    ) {
      return;
    }
    setIsExporting(true);
    try {
      if (format === 'source') {
        if (originalFileId) {
          const result = await downloadOriginal();
          if (!result.data) {
            throw new Error('Original artifact file download returned no URL');
          }
          triggerDownload(result.data, safeTitle(artifact.title || 'artifact'));
          return;
        }
        const sourceTitle = safeTitle((artifact.title || 'artifact').replace(/\.svg$/iu, ''));
        triggerDownload(
          URL.createObjectURL(
            new Blob([content], { type: isNativeSvg ? 'image/svg+xml' : 'text/plain' }),
          ),
          isNativeSvg ? `${sourceTitle}.svg` : fileKey,
        );
        return;
      }
      const title = artifact.title || 'Generated artifact';
      const blob = await postArtifactExport(
        {
          title,
          type: artifact.type,
          content,
          language: artifact.language,
        },
        format,
        shareId,
      );
      triggerDownload(URL.createObjectURL(blob), `${safeTitle(title)}.${format}`);
    } catch (error) {
      console.error('Artifact export failed:', error);
      showToast({
        message: exportErrorMessage(error, localize),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    } finally {
      setIsExporting(false);
    }
  };

  const label = localize(
    isExporting ? 'com_knauf_artifact_download_loading' : 'com_ui_download_artifact',
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-9 w-9"
          aria-label={label}
          disabled={isExporting}
        >
          {isExporting ? (
            <Spinner className="size-4" aria-hidden="true" />
          ) : (
            <Download size={16} aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[1001] min-w-44">
        <DropdownMenuItem
          className="cursor-pointer gap-2"
          disabled={isOriginalUnavailable}
          onSelect={() => void download('source')}
        >
          <FileCode2 className="size-4" aria-hidden="true" />
          {localize(
            isNativeSvg ? 'com_knauf_artifact_download_svg' : 'com_knauf_artifact_download_source',
          )}
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer gap-2" onSelect={() => void download('png')}>
          <Image className="size-4" aria-hidden="true" />
          {localize('com_knauf_artifact_download_png')}
        </DropdownMenuItem>
        <DropdownMenuItem className="cursor-pointer gap-2" onSelect={() => void download('pdf')}>
          <FileText className="size-4" aria-hidden="true" />
          {localize('com_knauf_artifact_download_pdf')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
