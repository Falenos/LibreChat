import {
  TextPaths,
  FilePaths,
  CodePaths,
  AudioPaths,
  VideoPaths,
  SheetPaths,
} from '@librechat/client';
import {
  megabyte,
  QueryKeys,
  inferMimeType,
  excelMimeTypes,
  EToolResources,
  EModelEndpoint,
  fileConfig as defaultFileConfig,
  // [knauf] Per-category upload size caps (documents 25 / data 50 / images 20 MB). KK20-190.
  knaufCategorySizeLimit,
  knaufCategorySizeErrorKey,
  // [knauf] Legacy Office binary detection for actionable rejection messages. KK20-190.
  knaufLegacyOfficeErrorKey,
} from 'librechat-data-provider';
import type { TFile, EndpointFileConfig, FileConfig } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { ExtendedFile } from '~/common';

export const partialTypes = ['text/x-'];

const textDocument = {
  paths: TextPaths,
  fill: '#FF5588',
  title: 'Document',
};

const spreadsheet = {
  paths: SheetPaths,
  fill: '#10A37F',
  title: 'Spreadsheet',
};

const codeFile = {
  paths: CodePaths,
  fill: '#FF6E3C',
  // TODO: make this dynamic to the language
  title: 'Code',
};

const artifact = {
  paths: CodePaths,
  fill: '#2D305C',
  title: 'Code',
};

const audioFile = {
  paths: AudioPaths,
  fill: '#FF6B35',
  title: 'Audio',
};

const videoFile = {
  paths: VideoPaths,
  fill: '#8B5CF6',
  title: 'Video',
};

export const fileTypes = {
  /* Category matches */
  file: {
    paths: FilePaths,
    fill: '#0000FF',
    title: 'File',
  },
  text: textDocument,
  txt: textDocument,
  audio: audioFile,
  video: videoFile,
  // application:,

  /* Partial matches */
  csv: spreadsheet,
  'application/pdf': textDocument,
  pdf: textDocument,
  'text/x-': codeFile,
  artifact: artifact,

  /* Exact matches */
  // 'application/json':,
  // 'text/html':,
  // 'text/css':,
  // image,
};

// export const getFileType = (type = '') => {
//   let fileType = fileTypes.file;
//   const exactMatch = fileTypes[type];
//   const partialMatch = !exactMatch && partialTypes.find((type) => type.includes(type));
//   const category = (!partialMatch && (type.split('/')[0] ?? 'text') || 'text');

//   if (exactMatch) {
//     fileType = exactMatch;
//   } else if (partialMatch) {
//     fileType = fileTypes[partialMatch];
//   } else if (fileTypes[category]) {
//     fileType = fileTypes[category];
//   }

//   if (!fileType) {
//     fileType = fileTypes.file;
//   }

//   return fileType;
// };

export const getFileType = (
  type = '',
): {
  paths: React.FC;
  fill: string;
  title: string;
} => {
  // Direct match check
  if (fileTypes[type]) {
    return fileTypes[type];
  }

  if (excelMimeTypes.test(type)) {
    return spreadsheet;
  }

  // Partial match check
  const partialMatch = partialTypes.find((partial) => type.includes(partial));
  if (partialMatch && fileTypes[partialMatch]) {
    return fileTypes[partialMatch];
  }

  // Category check
  const category = type.split('/')[0] || 'text';
  if (fileTypes[category]) {
    return fileTypes[category];
  }

  // Default file type
  return fileTypes.file;
};

/**
 * Format a date string to a human readable format
 * @example
 * formatDate('2020-01-01T00:00:00.000Z') // '1 Jan 2020'
 */
export function formatDate(dateString: string, isSmallScreen = false) {
  if (!dateString) {
    return '';
  }

  const date = new Date(dateString);

  if (isSmallScreen) {
    return date.toLocaleDateString('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: '2-digit',
    });
  }

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();

  return `${day} ${month} ${year}`;
}

/**
 * Adds a file to the query cache
 */
export function addFileToCache(queryClient: QueryClient, newfile: TFile) {
  const currentFiles = queryClient.getQueryData<TFile[]>([QueryKeys.files]);

  if (!currentFiles) {
    console.warn('No current files found in cache, skipped updating file query cache');
    return;
  }

  const fileIndex = currentFiles.findIndex((file) => file.file_id === newfile.file_id);

  if (fileIndex > -1) {
    console.warn('File already exists in cache, skipped updating file query cache');
    return;
  }

  queryClient.setQueryData<TFile[]>(
    [QueryKeys.files],
    [
      {
        ...newfile,
      },
      ...currentFiles,
    ],
  );
}

export function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) {
    return 0;
  }
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm));
}

const { checkType } = defaultFileConfig;

export const validateFiles = ({
  files,
  fileList,
  setError,
  endpointFileConfig,
  toolResource,
  fileConfig,
  endpoint,
}: {
  fileList: File[];
  files: Map<string, ExtendedFile>;
  setError: (error: string) => void;
  endpointFileConfig: EndpointFileConfig;
  toolResource?: string;
  fileConfig: FileConfig | null;
  // [knauf] Conversation endpoint id — gates the Knauf-specific rejection
  // messaging + per-category caps to the endpoints carrying the allow-list
  // (azureOpenAI chat + agents), mirroring filterFile's isKnaufCappedEndpoint
  // server-side. Other endpoints keep upstream validation. KK20-190.
  endpoint?: string;
}) => {
  const { fileLimit, fileSizeLimit, totalSizeLimit, supportedMimeTypes, disabled } =
    endpointFileConfig;
  // [knauf] Only the Knauf upload endpoints carry the restricted allow-list and
  // per-category caps; scope the Knauf branches below to them so non-Knauf
  // endpoints keep upstream behavior (matches process.js filterFile). The explicit
  // `endpoint != null` guard avoids a footgun: without it, an absent endpoint would
  // satisfy `undefined === EModelEndpoint.azureOpenAI` if that enum ever resolved to
  // `undefined` (circular import / partial build), wrongly flagging every upload as
  // Knauf-capped. KK20-190.
  const isKnaufCappedEndpoint =
    endpoint != null &&
    (endpoint === EModelEndpoint.azureOpenAI || endpoint === EModelEndpoint.agents);
  // End [knauf]
  /** Block all uploads if the endpoint is explicitly disabled */
  if (disabled === true) {
    setError('com_ui_attach_error_disabled');
    return false;
  }
  const existingFiles = Array.from(files.values());
  const incomingTotalSize = fileList.reduce((total, file) => total + file.size, 0);
  if (incomingTotalSize === 0) {
    setError('com_error_files_empty');
    return false;
  }
  const currentTotalSize = existingFiles.reduce((total, file) => total + file.size, 0);

  if (fileLimit && fileList.length + files.size > fileLimit) {
    setError(`File limit reached: ${fileLimit} files`);
    return false;
  }

  for (let i = 0; i < fileList.length; i++) {
    let originalFile = fileList[i];
    const fileType = inferMimeType(originalFile.name, originalFile.type);

    // Check if the file type is still empty after the extension check
    if (!fileType) {
      setError('Unable to determine file type for: ' + originalFile.name);
      return false;
    }

    // Replace empty type with inferred type
    if (originalFile.type !== fileType) {
      const newFile = new File([originalFile], originalFile.name, { type: fileType });
      originalFile = newFile;
      fileList[i] = newFile;
    }

    let mimeTypesToCheck = supportedMimeTypes;
    if (toolResource === EToolResources.context) {
      mimeTypesToCheck = [
        ...(fileConfig?.text?.supportedMimeTypes || []),
        ...(fileConfig?.ocr?.supportedMimeTypes || []),
        ...(fileConfig?.stt?.supportedMimeTypes || []),
      ];
    }

    if (!checkType(originalFile.type, mimeTypesToCheck)) {
      // [knauf] On the Knauf allow-list endpoints, turn the bare "unsupported
      // type" into actionable guidance: legacy Office binaries (.doc/.xls/.ppt)
      // get specific Save-As-to-OOXML help; anything else gets a friendly message
      // listing supported formats. Both are i18n keys localized in useFileHandling
      // (localize(key)||key). Other endpoints keep the upstream generic message.
      // KK20-190 (upload-guidance follow-up).
      const unsupportedError = isKnaufCappedEndpoint
        ? (knaufLegacyOfficeErrorKey(originalFile.type, originalFile.name) ??
          'com_knauf_error_unsupported_type')
        : `Unsupported file type: ${originalFile.type}`;
      // End [knauf]
      setError(unsupportedError);
      return false;
    }

    // [knauf] On the Knauf allow-list endpoints the per-category cap is the
    // AUTHORITATIVE per-file size gate (documents 25 / data 50 / images 20 MB):
    // when a cap applies we enforce only it (strict `>`, localized i18n key
    // rendered via localize(key) in useFileHandling) and skip the generic endpoint
    // `fileSizeLimit` check. This resolves a client/server boundary mismatch: the
    // largest cap (data, 50 MB) equals the endpoint fileSizeLimit, but the upstream
    // generic check uses `>=` (rejecting a file *exactly* at 50 MB, with a
    // non-localized English string) while server filterFile uses `>` (allowing it).
    // Without this, a 50 MB spreadsheet is accepted server-side yet rejected
    // client-side, and German users get an English error at the boundary. Every
    // allow-listed type maps to a capped category, so on Knauf endpoints this branch
    // always wins; non-Knauf endpoints (no cap) keep the upstream `>=` check verbatim.
    // KK20-190.
    const knaufCategoryCap = isKnaufCappedEndpoint
      ? knaufCategorySizeLimit(originalFile.type)
      : undefined;
    if (knaufCategoryCap != null) {
      if (originalFile.size > knaufCategoryCap) {
        setError(knaufCategorySizeErrorKey(originalFile.type));
        return false;
      }
    } else if (fileSizeLimit && originalFile.size >= fileSizeLimit) {
      setError(`File size limit exceeded: ${fileSizeLimit / megabyte} MB`);
      return false;
    }
    // End [knauf]
  }

  if (totalSizeLimit && currentTotalSize + incomingTotalSize > totalSizeLimit) {
    setError(`Total file size limit exceeded: ${totalSizeLimit / megabyte} MB`);
    return false;
  }

  const combinedFilesInfo = [
    ...existingFiles.map(
      (file) =>
        `${file.file?.name ?? file.filename}-${file.size}-${file.type?.split('/')[0] ?? 'file'}`,
    ),
    ...fileList.map(
      (file: File | undefined) =>
        `${file?.name}-${file?.size}-${file?.type.split('/')[0] ?? 'file'}`,
    ),
  ];

  const uniqueFilesSet = new Set(combinedFilesInfo);

  if (uniqueFilesSet.size !== combinedFilesInfo.length) {
    setError('com_error_files_dupe');
    return false;
  }

  return true;
};

export function sortPagesByRelevance(
  pages: number[],
  pageRelevance: Record<number, number>,
): number[] {
  if (!pageRelevance || Object.keys(pageRelevance).length === 0) {
    return pages;
  }
  return [...pages].sort((a, b) => (pageRelevance[b] || 0) - (pageRelevance[a] || 0));
}
