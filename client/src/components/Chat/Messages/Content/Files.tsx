import { useMemo, useState, useCallback, memo } from 'react';
// [knauf] Route SVG message files through the native editable artifact surface. (NO-TICKET)
import type { TAttachment, TFile, TMessage } from 'librechat-data-provider';
import Attachment from './Parts/Attachment';
import { detectArtifactTypeFromFile, TOOL_ARTIFACT_TYPES } from '~/utils/artifacts';
// End [knauf]
import FileContainer from '~/components/Chat/Input/Files/FileContainer';
import FilePreviewDialog from './FilePreviewDialog';
import Image from './Image';

const Files = ({ message }: { message?: TMessage }) => {
  // [knauf] SVG overlaps image/*, but belongs in Code/Preview rather than the raster dialog. (NO-TICKET)
  const svgFiles = useMemo(() => {
    return (
      message?.files?.filter(
        (file) => detectArtifactTypeFromFile(file) === TOOL_ARTIFACT_TYPES.SVG,
      ) || []
    );
  }, [message?.files]);

  const imageFiles = useMemo(() => {
    return (
      message?.files?.filter(
        (file) =>
          file.type?.startsWith('image/') &&
          detectArtifactTypeFromFile(file) !== TOOL_ARTIFACT_TYPES.SVG,
      ) || []
    );
  }, [message?.files]);

  const otherFiles = useMemo(() => {
    return (
      message?.files?.filter(
        (file) =>
          !file.type?.startsWith('image/') &&
          detectArtifactTypeFromFile(file) !== TOOL_ARTIFACT_TYPES.SVG,
      ) || []
    );
  }, [message?.files]);
  // End [knauf]

  const [selectedFile, setSelectedFile] = useState<Partial<TFile> | null>(null);

  const handleClose = useCallback((open: boolean) => {
    if (!open) {
      setSelectedFile(null);
    }
  }, []);

  return (
    <>
      {otherFiles.length > 0 &&
        otherFiles.map((file) => (
          <FileContainer
            key={file.file_id}
            file={file as TFile}
            onClick={() => setSelectedFile(file)}
          />
        ))}
      {/* [knauf] Reuse the established SVG source hydration and artifact registration path. (NO-TICKET) */}
      {svgFiles.map((file) => (
        <Attachment key={file.file_id} attachment={file as TAttachment} />
      ))}
      {/* End [knauf] */}
      {/* [knauf] Pass stable identity so failed/expired image URLs can use authenticated recovery. (NO-TICKET) */}
      {imageFiles.length > 0 &&
        imageFiles.map((file) => (
          <Image
            key={file.file_id}
            imagePath={file.preview ?? file.filepath ?? ''}
            fileId={file.file_id}
            height={file.height ?? 1920}
            width={file.width ?? 1080}
            altText={file.filename ?? 'Uploaded Image'}
          />
        ))}
      {/* End [knauf] */}
      <FilePreviewDialog
        open={selectedFile !== null}
        onOpenChange={handleClose}
        fileName={selectedFile?.filename ?? ''}
        fileId={selectedFile?.file_id}
        filePath={selectedFile?.filepath}
        fileType={selectedFile?.type ?? undefined}
        fileSize={(selectedFile as TFile)?.bytes}
      />
    </>
  );
};

export default memo(Files);
