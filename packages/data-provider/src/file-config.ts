import { z } from 'zod';
import type { EndpointFileConfig, FileConfig } from './types/files';
import { EModelEndpoint, isAgentsEndpoint, isDocumentSupportedProvider } from './schemas';
import { normalizeEndpointName } from './utils';

export const supportsFiles = {
  [EModelEndpoint.openAI]: true,
  [EModelEndpoint.google]: true,
  [EModelEndpoint.assistants]: true,
  [EModelEndpoint.azureAssistants]: true,
  [EModelEndpoint.agents]: true,
  [EModelEndpoint.azureOpenAI]: true,
  [EModelEndpoint.anthropic]: true,
  [EModelEndpoint.custom]: true,
  [EModelEndpoint.bedrock]: true,
};

export const excelFileTypes = [
  'application/vnd.ms-excel',
  'application/msexcel',
  'application/x-msexcel',
  'application/x-ms-excel',
  'application/x-excel',
  'application/x-dos_ms_excel',
  'application/xls',
  'application/x-xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export const fullMimeTypesList = [
  'text/x-c',
  'text/x-c++',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/x-java',
  'application/json',
  'text/markdown',
  'application/pdf',
  'text/x-php',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/x-python',
  'text/x-script.python',
  'text/x-ruby',
  'text/x-tex',
  'text/plain',
  'text/css',
  'text/calendar',
  'text/vtt',
  'image/jpeg',
  'text/javascript',
  'image/gif',
  'image/png',
  'image/heic',
  'image/heif',
  'application/x-tar',
  'application/x-sh',
  'application/typescript',
  'application/sql',
  'application/yaml',
  'application/vnd.coffeescript',
  'application/xml',
  'application/zip',
  'application/x-parquet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.graphics',
  'image/svg',
  'image/svg+xml',
  // Video formats
  'video/mp4',
  'video/avi',
  'video/mov',
  'video/wmv',
  'video/flv',
  'video/webm',
  'video/mkv',
  'video/m4v',
  'video/3gp',
  'video/ogv',
  // Audio formats
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/m4a',
  'audio/aac',
  'audio/flac',
  'audio/wma',
  'audio/opus',
  'audio/mpeg',
  ...excelFileTypes,
];

export const codeInterpreterMimeTypesList = [
  'text/x-c',
  'text/x-c++',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/x-java',
  'application/json',
  'text/markdown',
  'application/pdf',
  'text/x-php',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/x-python',
  'text/x-script.python',
  'text/x-ruby',
  'text/x-tex',
  'text/plain',
  'text/css',
  'text/calendar',
  'image/jpeg',
  'text/javascript',
  'image/gif',
  'image/png',
  'image/heic',
  'image/heif',
  'application/x-tar',
  'application/typescript',
  'application/xml',
  'application/zip',
  'application/x-parquet',
  ...excelFileTypes,
];

export const retrievalMimeTypesList = [
  'text/x-c',
  'text/x-c++',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/x-java',
  'application/json',
  'text/markdown',
  'application/pdf',
  'text/x-php',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/x-python',
  'text/x-script.python',
  'text/x-ruby',
  'text/x-tex',
  'text/plain',
];

export const imageExtRegex = /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i;

/** @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_DocumentBlock.html */
export type BedrockDocumentFormat =
  | 'pdf'
  | 'csv'
  | 'doc'
  | 'docx'
  | 'xls'
  | 'xlsx'
  | 'html'
  | 'txt'
  | 'md';

/** Maps MIME types to Bedrock Converse API document format values */
export const bedrockDocumentFormats: Record<string, BedrockDocumentFormat> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

export const isBedrockDocumentType = (mimeType?: string): boolean =>
  mimeType != null && mimeType in bedrockDocumentFormats;

/** File extensions accepted by Bedrock document uploads (for input accept attributes) */
export const bedrockDocumentExtensions =
  '.pdf,.csv,.doc,.docx,.xls,.xlsx,.html,.htm,.txt,.md,application/pdf,text/csv,application/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/html,text/plain,text/markdown';

export const excelMimeTypes =
  /^application\/(vnd\.ms-excel|msexcel|x-msexcel|x-ms-excel|x-excel|x-dos_ms_excel|xls|x-xls|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/;

export const textMimeTypes =
  /^(text\/(x-c|x-csharp|tab-separated-values|x-c\+\+|x-h|x-java|html|markdown|x-php|x-python|x-script\.python|x-ruby|x-tex|plain|css|vtt|javascript|csv|xml|calendar))$/;

export const applicationMimeTypes =
  /^(application\/(epub\+zip|csv|json|msword|pdf|x-tar|x-sh|typescript|sql|yaml|x-parquet|vnd\.apache\.parquet|vnd\.coffeescript|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation|spreadsheetml\.sheet)|vnd\.oasis\.opendocument\.(text|spreadsheet|presentation|graphics)|xml|zip))$/;

export const imageMimeTypes = /^image\/(jpeg|gif|png|webp|heic|heif)$/;

export const audioMimeTypes =
  /^audio\/(mp3|mpeg|mpeg3|wav|wave|x-wav|ogg|vorbis|mp4|m4a|x-m4a|flac|x-flac|webm|aac|wma|opus)$/;

export const videoMimeTypes = /^video\/(mp4|avi|mov|wmv|flv|webm|mkv|m4v|3gp|ogv)$/;

export const defaultOCRMimeTypes = [
  imageMimeTypes,
  excelMimeTypes,
  /^application\/pdf$/,
  /^application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation)$/,
  /^application\/vnd\.ms-(word|powerpoint)$/,
  /^application\/epub\+zip$/,
  /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation|graphics)$/,
];

/** MIME types handled by the built-in document parser (pdf, docx, excel variants, ods/odt) */
export const documentParserMimeTypes = [
  excelMimeTypes,
  /^application\/pdf$/,
  /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/,
  /^application\/vnd\.oasis\.opendocument\.spreadsheet$/,
  /^application\/vnd\.oasis\.opendocument\.text$/,
];

export const defaultTextMimeTypes = [/^[\w.-]+\/[\w.-]+$/];

export const defaultSTTMimeTypes = [audioMimeTypes];

export const supportedMimeTypes = [
  textMimeTypes,
  excelMimeTypes,
  applicationMimeTypes,
  imageMimeTypes,
  videoMimeTypes,
  audioMimeTypes,
  /** Supported by LC Code Interpreter API */
  /^image\/(svg|svg\+xml)$/,
];

export const codeInterpreterMimeTypes = [
  textMimeTypes,
  excelMimeTypes,
  applicationMimeTypes,
  imageMimeTypes,
];

export const codeTypeMapping: { [key: string]: string } = {
  c: 'text/x-c', // .c - C source
  cs: 'text/x-csharp', // .cs - C# source
  cpp: 'text/x-c++', // .cpp - C++ source
  h: 'text/x-h', // .h - C/C++ header
  md: 'text/markdown', // .md - Markdown
  php: 'text/x-php', // .php - PHP source
  py: 'text/x-python', // .py - Python source
  rb: 'text/x-ruby', // .rb - Ruby source
  tex: 'text/x-tex', // .tex - LaTeX source
  java: 'text/x-java', // .java - Java source
  js: 'text/javascript', // .js - JavaScript source
  sh: 'application/x-sh', // .sh - Shell script
  ts: 'application/typescript', // .ts - TypeScript source
  tar: 'application/x-tar', // .tar - Tar archive
  zip: 'application/zip', // .zip - ZIP archive
  txt: 'text/plain', // .txt - Plain text file
  log: 'text/plain', // .log - Log file
  csv: 'text/csv', // .csv - Comma-separated values
  tsv: 'text/tab-separated-values', // .tsv - Tab-separated values
  parquet: 'application/x-parquet', // .parquet - Apache Parquet columnar storage
  json: 'application/json', // .json - JSON file
  xml: 'application/xml', // .xml - XML file
  html: 'text/html', // .html - HTML file
  htm: 'text/html', // .htm - HTML file
  css: 'text/css', // .css - CSS file
  yml: 'application/yaml', // .yml - YAML
  yaml: 'application/yaml', // .yaml - YAML
  sql: 'application/sql', // .sql - SQL (IANA registered)
  dart: 'text/plain', // .dart - Dart source
  coffee: 'application/vnd.coffeescript', // .coffee - CoffeeScript (IANA registered)
  go: 'text/plain', // .go - Go source
  rs: 'text/plain', // .rs - Rust source
  swift: 'text/plain', // .swift - Swift source
  kt: 'text/plain', // .kt - Kotlin source
  kts: 'text/plain', // .kts - Kotlin script
  scala: 'text/plain', // .scala - Scala source
  lua: 'text/plain', // .lua - Lua source
  r: 'text/plain', // .r - R source
  pl: 'text/plain', // .pl - Perl source
  pm: 'text/plain', // .pm - Perl module
  groovy: 'text/plain', // .groovy - Groovy source
  gradle: 'text/plain', // .gradle - Gradle build script
  clj: 'text/plain', // .clj - Clojure source
  cljs: 'text/plain', // .cljs - ClojureScript source
  cljc: 'text/plain', // .cljc - Clojure common source
  elm: 'text/plain', // .elm - Elm source
  erl: 'text/plain', // .erl - Erlang source
  hrl: 'text/plain', // .hrl - Erlang header
  ex: 'text/plain', // .ex - Elixir source
  exs: 'text/plain', // .exs - Elixir script
  hs: 'text/plain', // .hs - Haskell source
  lhs: 'text/plain', // .lhs - Literate Haskell source
  ml: 'text/plain', // .ml - OCaml source
  mli: 'text/plain', // .mli - OCaml interface
  fs: 'text/plain', // .fs - F# source
  fsx: 'text/plain', // .fsx - F# script
  lisp: 'text/plain', // .lisp - Lisp source
  cl: 'text/plain', // .cl - Common Lisp source
  scm: 'text/plain', // .scm - Scheme source
  rkt: 'text/plain', // .rkt - Racket source
  jsx: 'text/plain', // .jsx - React JSX
  tsx: 'text/plain', // .tsx - React TSX
  vue: 'text/plain', // .vue - Vue component
  svelte: 'text/plain', // .svelte - Svelte component
  astro: 'text/plain', // .astro - Astro component
  scss: 'text/plain', // .scss - SCSS source
  sass: 'text/plain', // .sass - Sass source
  less: 'text/plain', // .less - Less source
  styl: 'text/plain', // .styl - Stylus source
  toml: 'text/plain', // .toml - TOML config
  ini: 'text/plain', // .ini - INI config
  cfg: 'text/plain', // .cfg - Config file
  conf: 'text/plain', // .conf - Config file
  env: 'text/plain', // .env - Environment file
  properties: 'text/plain', // .properties - Java properties
  graphql: 'text/plain', // .graphql - GraphQL schema/query
  gql: 'text/plain', // .gql - GraphQL schema/query
  proto: 'text/plain', // .proto - Protocol Buffers
  dockerfile: 'text/plain', // Dockerfile
  makefile: 'text/plain', // Makefile
  cmake: 'text/plain', // .cmake - CMake script
  rake: 'text/plain', // .rake - Rake task
  gemspec: 'text/plain', // .gemspec - Ruby gem spec
  bash: 'text/plain', // .bash - Bash script
  zsh: 'text/plain', // .zsh - Zsh script
  fish: 'text/plain', // .fish - Fish script
  ps1: 'text/plain', // .ps1 - PowerShell script
  psm1: 'text/plain', // .psm1 - PowerShell module
  bat: 'text/plain', // .bat - Batch script
  cmd: 'text/plain', // .cmd - Windows command script
  asm: 'text/plain', // .asm - Assembly source
  s: 'text/plain', // .s - Assembly source
  v: 'text/plain', // .v - V or Verilog source
  zig: 'text/plain', // .zig - Zig source
  nim: 'text/plain', // .nim - Nim source
  cr: 'text/plain', // .cr - Crystal source
  d: 'text/plain', // .d - D source
  pas: 'text/plain', // .pas - Pascal source
  pp: 'text/plain', // .pp - Pascal/Puppet source
  f90: 'text/plain', // .f90 - Fortran 90 source
  f95: 'text/plain', // .f95 - Fortran 95 source
  f03: 'text/plain', // .f03 - Fortran 2003 source
  jl: 'text/plain', // .jl - Julia source
  m: 'text/plain', // .m - Objective-C/MATLAB source
  mm: 'text/plain', // .mm - Objective-C++ source
  ada: 'text/plain', // .ada - Ada source
  adb: 'text/plain', // .adb - Ada body
  ads: 'text/plain', // .ads - Ada spec
  cob: 'text/plain', // .cob - COBOL source
  cbl: 'text/plain', // .cbl - COBOL source
  tcl: 'text/plain', // .tcl - Tcl source
  awk: 'text/plain', // .awk - AWK script
  sed: 'text/plain', // .sed - Sed script
  odt: 'application/vnd.oasis.opendocument.text', // .odt - OpenDocument Text
  ods: 'application/vnd.oasis.opendocument.spreadsheet', // .ods - OpenDocument Spreadsheet
  odp: 'application/vnd.oasis.opendocument.presentation', // .odp - OpenDocument Presentation
  odg: 'application/vnd.oasis.opendocument.graphics', // .odg - OpenDocument Graphics
  ics: 'text/calendar', // .ics - iCalendar
  ical: 'text/calendar', // .ical - iCalendar
  ifb: 'text/calendar', // .ifb - iCalendar free/busy
  icalendar: 'text/calendar', // .icalendar - iCalendar
};

/** Maps image extensions to MIME types for formats browsers may not recognize */
export const imageTypeMapping: { [key: string]: string } = {
  heic: 'image/heic',
  heif: 'image/heif',
};

/** Normalizes non-standard MIME types that browsers may report to their canonical forms */
export const mimeTypeAliases: Readonly<Record<string, string>> = {
  'text/x-python-script': 'text/x-python',
  'text/x-markdown': 'text/markdown',
};

/**
 * Infers the MIME type from a file's extension when the browser doesn't recognize it,
 * and normalizes known non-standard MIME type aliases to their canonical forms.
 * @param fileName - The file name including its extension
 * @param currentType - The MIME type reported by the browser (may be empty string)
 * @returns The normalized or inferred MIME type; empty string if unresolvable
 */
export function inferMimeType(fileName: string, currentType: string): string {
  if (currentType) {
    return mimeTypeAliases[currentType] ?? currentType;
  }

  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  return codeTypeMapping[extension] || imageTypeMapping[extension] || currentType;
}

export const retrievalMimeTypes = [
  /^(text\/(x-c|x-c\+\+|x-h|html|x-java|markdown|x-php|x-python|x-script\.python|x-ruby|x-tex|plain|vtt|xml))$/,
  /^(application\/(json|pdf|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|presentationml\.presentation)))$/,
];

export const megabyte = 1024 * 1024;
/** Helper function to get megabytes value */
export const mbToBytes = (mb: number): number => mb * megabyte;

const defaultSizeLimit = mbToBytes(512);
const defaultTokenLimit = 100000;
const assistantsFileConfig = {
  fileLimit: 10,
  fileSizeLimit: defaultSizeLimit,
  totalSizeLimit: defaultSizeLimit,
  supportedMimeTypes,
  disabled: false,
};

export const fileConfig = {
  endpoints: {
    [EModelEndpoint.assistants]: assistantsFileConfig,
    [EModelEndpoint.azureAssistants]: assistantsFileConfig,
    [EModelEndpoint.agents]: assistantsFileConfig,
    [EModelEndpoint.anthropic]: {
      fileLimit: 10,
      fileSizeLimit: defaultSizeLimit,
      totalSizeLimit: defaultSizeLimit,
      supportedMimeTypes,
      disabled: false,
    },
    default: {
      fileLimit: 10,
      fileSizeLimit: defaultSizeLimit,
      totalSizeLimit: defaultSizeLimit,
      supportedMimeTypes,
      disabled: false,
    },
  },
  serverFileSizeLimit: defaultSizeLimit,
  avatarSizeLimit: mbToBytes(2),
  fileTokenLimit: defaultTokenLimit,
  clientImageResize: {
    enabled: false,
    maxWidth: 1900,
    maxHeight: 1900,
    quality: 0.92,
  },
  ocr: {
    supportedMimeTypes: defaultOCRMimeTypes,
  },
  text: {
    supportedMimeTypes: defaultTextMimeTypes,
  },
  stt: {
    supportedMimeTypes: defaultSTTMimeTypes,
  },
  checkType: function (fileType: string, supportedTypes: RegExp[] = supportedMimeTypes) {
    return supportedTypes.some((regex) => regex.test(fileType));
  },
};

const supportedMimeTypesSchema = z.array(z.string()).optional();

export const endpointFileConfigSchema = z.object({
  disabled: z.boolean().optional(),
  fileLimit: z.number().min(0).optional(),
  fileSizeLimit: z.number().min(0).optional(),
  totalSizeLimit: z.number().min(0).optional(),
  supportedMimeTypes: supportedMimeTypesSchema.optional(),
});

export const fileConfigSchema = z.object({
  endpoints: z.record(endpointFileConfigSchema).optional(),
  serverFileSizeLimit: z.number().min(0).optional(),
  avatarSizeLimit: z.number().min(0).optional(),
  fileTokenLimit: z.number().min(0).optional(),
  imageGeneration: z
    .object({
      percentage: z.number().min(0).max(100).optional(),
      px: z.number().min(0).optional(),
    })
    .optional(),
  clientImageResize: z
    .object({
      enabled: z.boolean().optional(),
      maxWidth: z.number().min(0).optional(),
      maxHeight: z.number().min(0).optional(),
      quality: z.number().min(0).max(1).optional(),
    })
    .optional(),
  ocr: z
    .object({
      supportedMimeTypes: supportedMimeTypesSchema.optional(),
    })
    .optional(),
  text: z
    .object({
      supportedMimeTypes: supportedMimeTypesSchema.optional(),
    })
    .optional(),
});

export type TFileConfig = z.infer<typeof fileConfigSchema>;

/** Helper function to safely convert string patterns to RegExp objects */
export const convertStringsToRegex = (patterns: string[]): RegExp[] =>
  patterns.reduce((acc: RegExp[], pattern) => {
    try {
      const regex = new RegExp(pattern);
      acc.push(regex);
    } catch (error) {
      console.error(`Invalid regex pattern "${pattern}" skipped.`, error);
    }
    return acc;
  }, []);

/** Detects whether the given MIME type patterns accept all file types (e.g., `.*` or `.+`). */
export const isPermissiveMimeConfig = (types?: RegExp[]): boolean => {
  if (!types || types.length === 0) {
    return false;
  }
  return types.some((regex) => regex.test('x-librechat/x-probe'));
};

/**
 * Gets the appropriate endpoint file configuration with standardized lookup logic.
 *
 * @param params - Object containing fileConfig, endpoint, and optional conversationEndpoint
 * @param params.fileConfig - The merged file configuration
 * @param params.endpoint - The endpoint name to look up
 * @param params.conversationEndpoint - Optional conversation endpoint for additional context
 * @returns The endpoint file configuration or undefined
 */
/**
 * Merges an endpoint config with the default config to ensure all fields are populated.
 * For document-supported providers, uses the comprehensive MIME type list (includes videos/audio).
 */
function mergeWithDefault(
  endpointConfig: EndpointFileConfig,
  defaultConfig: EndpointFileConfig,
  endpoint?: string | null,
): EndpointFileConfig {
  /** Use comprehensive MIME types for document-supported providers */
  const defaultMimeTypes = isDocumentSupportedProvider(endpoint)
    ? supportedMimeTypes
    : defaultConfig.supportedMimeTypes;

  return {
    disabled: endpointConfig.disabled ?? defaultConfig.disabled,
    fileLimit: endpointConfig.fileLimit ?? defaultConfig.fileLimit,
    fileSizeLimit: endpointConfig.fileSizeLimit ?? defaultConfig.fileSizeLimit,
    totalSizeLimit: endpointConfig.totalSizeLimit ?? defaultConfig.totalSizeLimit,
    supportedMimeTypes: endpointConfig.supportedMimeTypes ?? defaultMimeTypes,
  };
}

export function getEndpointFileConfig(params: {
  fileConfig?: FileConfig | null;
  endpoint?: string | null;
  endpointType?: string | null;
}): EndpointFileConfig {
  const { fileConfig: mergedFileConfig, endpoint, endpointType } = params;

  if (!mergedFileConfig?.endpoints) {
    return fileConfig.endpoints.default;
  }

  /** Compute an effective default by merging user-configured default over the base default */
  const baseDefaultConfig = fileConfig.endpoints.default;
  const userDefaultConfig = mergedFileConfig.endpoints.default;
  const defaultConfig = userDefaultConfig
    ? mergeWithDefault(userDefaultConfig, baseDefaultConfig, 'default')
    : baseDefaultConfig;

  const normalizedEndpoint = normalizeEndpointName(endpoint ?? '');
  const standardEndpoints = new Set([
    'default',
    EModelEndpoint.agents,
    EModelEndpoint.assistants,
    EModelEndpoint.azureAssistants,
    EModelEndpoint.openAI,
    EModelEndpoint.azureOpenAI,
    EModelEndpoint.anthropic,
    EModelEndpoint.google,
    EModelEndpoint.bedrock,
  ]);

  const normalizedEndpointType = normalizeEndpointName(endpointType ?? '');
  const isCustomEndpoint =
    endpointType === EModelEndpoint.custom ||
    (!standardEndpoints.has(normalizedEndpointType) &&
      normalizedEndpoint &&
      !standardEndpoints.has(normalizedEndpoint));

  if (isCustomEndpoint) {
    /** 1. Check direct endpoint lookup (could be normalized or not) */
    if (endpoint && mergedFileConfig.endpoints[endpoint]) {
      return mergeWithDefault(mergedFileConfig.endpoints[endpoint], defaultConfig, endpoint);
    }
    /** 2. Check normalized endpoint lookup (skip standard endpoint keys) */
    for (const key in mergedFileConfig.endpoints) {
      if (!standardEndpoints.has(key) && normalizeEndpointName(key) === normalizedEndpoint) {
        return mergeWithDefault(mergedFileConfig.endpoints[key], defaultConfig, key);
      }
    }
    /** 3. Fallback to generic 'custom' config if any */
    if (mergedFileConfig.endpoints[EModelEndpoint.custom]) {
      return mergeWithDefault(
        mergedFileConfig.endpoints[EModelEndpoint.custom],
        defaultConfig,
        endpoint,
      );
    }
    /** 4. Fallback to 'agents' (all custom endpoints are non-assistants) */
    if (mergedFileConfig.endpoints[EModelEndpoint.agents]) {
      return mergeWithDefault(
        mergedFileConfig.endpoints[EModelEndpoint.agents],
        defaultConfig,
        endpoint,
      );
    }
    /** 5. Fallback to default */
    return defaultConfig;
  }

  /** Check endpointType first (most reliable for standard endpoints) */
  if (endpointType && mergedFileConfig.endpoints[endpointType]) {
    return mergeWithDefault(mergedFileConfig.endpoints[endpointType], defaultConfig, endpointType);
  }

  /** Check direct endpoint lookup */
  if (endpoint && mergedFileConfig.endpoints[endpoint]) {
    return mergeWithDefault(mergedFileConfig.endpoints[endpoint], defaultConfig, endpoint);
  }

  /** Check normalized endpoint */
  if (normalizedEndpoint && mergedFileConfig.endpoints[normalizedEndpoint]) {
    return mergeWithDefault(
      mergedFileConfig.endpoints[normalizedEndpoint],
      defaultConfig,
      normalizedEndpoint,
    );
  }

  /** Fallback to agents if endpoint is explicitly agents */
  const isAgents = isAgentsEndpoint(normalizedEndpointType || normalizedEndpoint);
  if (isAgents && mergedFileConfig.endpoints[EModelEndpoint.agents]) {
    return mergeWithDefault(
      mergedFileConfig.endpoints[EModelEndpoint.agents],
      defaultConfig,
      EModelEndpoint.agents,
    );
  }

  /** Return default config */
  return defaultConfig;
}

export function mergeFileConfig(dynamic: z.infer<typeof fileConfigSchema> | undefined): FileConfig {
  const mergedConfig: FileConfig = {
    ...fileConfig,
    endpoints: {
      ...fileConfig.endpoints,
    },
    ocr: {
      ...fileConfig.ocr,
      supportedMimeTypes: fileConfig.ocr?.supportedMimeTypes || [],
    },
    text: {
      ...fileConfig.text,
      supportedMimeTypes: fileConfig.text?.supportedMimeTypes || [],
    },
    stt: {
      ...fileConfig.stt,
      supportedMimeTypes: fileConfig.stt?.supportedMimeTypes || [],
    },
  };
  if (!dynamic) {
    return mergedConfig;
  }

  if (dynamic.serverFileSizeLimit !== undefined) {
    mergedConfig.serverFileSizeLimit = mbToBytes(dynamic.serverFileSizeLimit);
  }

  if (dynamic.avatarSizeLimit !== undefined) {
    mergedConfig.avatarSizeLimit = mbToBytes(dynamic.avatarSizeLimit);
  }

  if (dynamic.fileTokenLimit !== undefined) {
    mergedConfig.fileTokenLimit = dynamic.fileTokenLimit;
  }

  // Merge clientImageResize configuration
  if (dynamic.clientImageResize !== undefined) {
    mergedConfig.clientImageResize = {
      ...mergedConfig.clientImageResize,
      ...dynamic.clientImageResize,
    };
  }

  if (dynamic.ocr !== undefined) {
    const { supportedMimeTypes: ocrMimeTypes, ...ocrRest } = dynamic.ocr;
    mergedConfig.ocr = {
      ...mergedConfig.ocr,
      ...ocrRest,
    };
    if (ocrMimeTypes) {
      mergedConfig.ocr.supportedMimeTypes = convertStringsToRegex(ocrMimeTypes);
    }
  }

  if (dynamic.text !== undefined) {
    const { supportedMimeTypes: textMimeTypes, ...textRest } = dynamic.text;
    mergedConfig.text = {
      ...mergedConfig.text,
      ...textRest,
    };
    if (textMimeTypes) {
      mergedConfig.text.supportedMimeTypes = convertStringsToRegex(textMimeTypes);
    }
  }

  if (!dynamic.endpoints) {
    return mergedConfig;
  }

  for (const key in dynamic.endpoints) {
    const dynamicEndpoint = (dynamic.endpoints as Record<string, EndpointFileConfig>)[key];

    /** Deep copy the base endpoint config if it exists to prevent mutation */
    if (!mergedConfig.endpoints[key]) {
      mergedConfig.endpoints[key] = {};
    } else {
      mergedConfig.endpoints[key] = { ...mergedConfig.endpoints[key] };
    }

    const mergedEndpoint = mergedConfig.endpoints[key];

    if (dynamicEndpoint.disabled === true) {
      mergedEndpoint.disabled = true;
      mergedEndpoint.fileLimit = 0;
      mergedEndpoint.fileSizeLimit = 0;
      mergedEndpoint.totalSizeLimit = 0;
      mergedEndpoint.supportedMimeTypes = [];
      continue;
    }

    if (dynamicEndpoint.fileSizeLimit !== undefined) {
      mergedEndpoint.fileSizeLimit = mbToBytes(dynamicEndpoint.fileSizeLimit);
    }

    if (dynamicEndpoint.totalSizeLimit !== undefined) {
      mergedEndpoint.totalSizeLimit = mbToBytes(dynamicEndpoint.totalSizeLimit);
    }

    const configKeys = ['fileLimit'] as const;
    configKeys.forEach((field) => {
      if (dynamicEndpoint[field] !== undefined) {
        mergedEndpoint[field] = dynamicEndpoint[field];
      }
    });

    if (dynamicEndpoint.disabled !== undefined) {
      mergedEndpoint.disabled = dynamicEndpoint.disabled;
    }

    if (dynamicEndpoint.supportedMimeTypes) {
      mergedEndpoint.supportedMimeTypes = convertStringsToRegex(
        dynamicEndpoint.supportedMimeTypes as unknown as string[],
      );
    }
  }

  return mergedConfig;
}

// [knauf] Per-format-category upload size caps (KK20-190). The fileConfig schema
// exposes only a single `fileSizeLimit` per endpoint, but the product spec needs
// different per-file caps by category: documents 25 MB, data/spreadsheets 50 MB,
// images 20 MB. Centralized here so the client (validateFiles) and server
// (filterFile) classify + enforce identically, reusing the MIME regexes above.
// Endpoint `fileSizeLimit` is set to the largest cap (50 MB) as a backstop; this
// applies the tighter per-category limit on top.
// NOTE: this block exceeds the Tier-4c 30-line guideline; extract to
// packages/knauf/ once ADR-017 lands. Until then it stays here as an additive
// export with near-zero merge surface (appended at end of file). KK20-190.
//
// LOCKSTEP: these numbers are also stated in plain text in the locale strings
// (`com_knauf_error_file_too_large_{document,data,image}` and the `com_knauf_
// upload_formats_*` copy) in client/src/locales/{en,de}/translation.json — the
// errors are thrown server-side as bare i18n keys, so the MB value can't be
// interpolated from here. If you change a cap, update those strings too. (The
// dialog's per-category badge does derive its number from this map.)
export const knaufCategorySizeLimits = {
  document: mbToBytes(25),
  data: mbToBytes(50),
  image: mbToBytes(20),
} as const;

/** CSV arrives as text/csv or application/csv; classified as "data", not document. */
const knaufCsvMimeTypes = /^(text\/csv|application\/csv)$/;

type KnaufSizeCategory = keyof typeof knaufCategorySizeLimits;

/** Per-category "file too large" i18n key per category (localized client-side). */
const knaufCategorySizeErrorKeys: Record<KnaufSizeCategory, string> = {
  document: 'com_knauf_error_file_too_large_document',
  data: 'com_knauf_error_file_too_large_data',
  image: 'com_knauf_error_file_too_large_image',
};

/**
 * Single source of the MIME → category cascade, so the size cap and the error key
 * can't drift. Order matters: image → data (xlsx/csv) → document (other
 * text/application). Returns `undefined` for types outside a capped category.
 */
function classifyKnaufCategory(mimetype?: string | null): KnaufSizeCategory | undefined {
  if (!mimetype) {
    return undefined;
  }
  if (imageMimeTypes.test(mimetype)) {
    return 'image';
  }
  if (excelMimeTypes.test(mimetype) || knaufCsvMimeTypes.test(mimetype)) {
    return 'data';
  }
  if (textMimeTypes.test(mimetype) || applicationMimeTypes.test(mimetype)) {
    return 'document';
  }
  return undefined;
}

/**
 * Per-category upload size cap (bytes) for a MIME type, or `undefined` when the
 * type isn't in a capped category (caller then falls back to endpoint fileSizeLimit).
 */
export function knaufCategorySizeLimit(mimetype?: string | null): number | undefined {
  const category = classifyKnaufCategory(mimetype);
  return category ? knaufCategorySizeLimits[category] : undefined;
}

/** i18n key for the per-category "file too large" rejection (localized client-side).
 * Only meaningful when `knaufCategorySizeLimit` returned a cap; out-of-scope types
 * fall back to the document key (matching the prior behavior). */
export function knaufCategorySizeErrorKey(mimetype?: string | null): string {
  return knaufCategorySizeErrorKeys[classifyKnaufCategory(mimetype) ?? 'document'];
}

/**
 * Single source for the chat file-picker `accept` attribute (extensions + image
 * MIME types). Mirrors the server-side allow-list (`supportedMimeTypes:
 * &knauf_allowed_mime` in librechat.yaml); keep the two in sync. Imported by
 * AttachFileMenu and pinned by its spec so a change here surfaces in review.
 */
export const knaufChatUploadAccept =
  '.pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.json,image/png,image/jpeg,image/webp';
// End [knauf]

// [knauf] Legacy Office binary detection (KK20-190 upload-guidance follow-up).
// The allow-list rejects pre-OOXML formats (.doc/.xls/.ppt) because rag_api can't
// embed them. Rather than a bare "unsupported type", return a specific i18n key
// that tells the user to Save As the modern format. Detected by MIME, with the
// filename extension as a backstop (some browsers report a generic type for
// legacy binaries). Shared by client (validateFiles) and server (filterFile).
const knaufLegacyOfficeByMime: Record<string, string> = {
  'application/msword': 'com_knauf_error_legacy_doc',
  'application/vnd.ms-excel': 'com_knauf_error_legacy_xls',
  'application/vnd.ms-powerpoint': 'com_knauf_error_legacy_ppt',
};
const knaufLegacyOfficeByExt: Record<string, string> = {
  doc: 'com_knauf_error_legacy_doc',
  xls: 'com_knauf_error_legacy_xls',
  ppt: 'com_knauf_error_legacy_ppt',
};

/**
 * i18n key for a legacy-Office rejection ("Save As .docx/.xlsx/.pptx"), or
 * `undefined` when the file isn't a recognized legacy binary. Caller uses this to
 * upgrade a generic "unsupported type" rejection into actionable migration help.
 * `.docx`/`.xlsx`/`.pptx` end in their own extensions, so the ext backstop never
 * matches them.
 */
export function knaufLegacyOfficeErrorKey(
  mimetype?: string | null,
  filename?: string | null,
): string | undefined {
  if (mimetype && knaufLegacyOfficeByMime[mimetype]) {
    return knaufLegacyOfficeByMime[mimetype];
  }
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext && knaufLegacyOfficeByExt[ext]) {
    return knaufLegacyOfficeByExt[ext];
  }
  return undefined;
}
// End [knauf]
