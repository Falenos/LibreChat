import { promises as fs } from 'fs';
import { Providers } from '@librechat/agents';
import { mbToBytes, isOpenAILikeProvider } from 'librechat-data-provider';

export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

export interface PDFValidationResult {
  isValid: boolean;
  error?: string;
}

export interface VideoValidationResult {
  isValid: boolean;
  error?: string;
}

export interface AudioValidationResult {
  isValid: boolean;
  error?: string;
}

export interface ImageValidationResult {
  isValid: boolean;
  error?: string;
}

export async function validatePdf(
  pdfBuffer: Buffer,
  fileSize: number,
  provider: Providers,
  configuredFileSizeLimit?: number,
  model?: string,
): Promise<PDFValidationResult> {
  if (provider === Providers.ANTHROPIC) {
    return validateAnthropicPdf(pdfBuffer, fileSize, configuredFileSizeLimit);
  }

  if (provider === Providers.BEDROCK) {
    return validateBedrockDocument(
      fileSize,
      'application/pdf',
      pdfBuffer,
      configuredFileSizeLimit,
      model,
    );
  }

  if (isOpenAILikeProvider(provider)) {
    return validateOpenAIPdf(fileSize, configuredFileSizeLimit);
  }

  if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
    return validateGooglePdf(fileSize, configuredFileSizeLimit);
  }

  return { isValid: true };
}

/**
 * Validates if a PDF meets Anthropic's requirements
 * @param pdfBuffer - The PDF file as a buffer
 * @param fileSize - The file size in bytes
 * @param configuredFileSizeLimit - Optional configured file size limit from fileConfig (in bytes)
 * @returns Promise that resolves to validation result
 */
async function validateAnthropicPdf(
  pdfBuffer: Buffer,
  fileSize: number,
  configuredFileSizeLimit?: number,
): Promise<PDFValidationResult> {
  try {
    const providerLimit = mbToBytes(32);
    const effectiveLimit = configuredFileSizeLimit ?? providerLimit;

    if (fileSize > effectiveLimit) {
      const limitMB = Math.round(effectiveLimit / (1024 * 1024));
      return {
        isValid: false,
        error: `PDF file size (${Math.round(fileSize / (1024 * 1024))}MB) exceeds the ${limitMB}MB limit`,
      };
    }

    if (!pdfBuffer || pdfBuffer.length < 5) {
      return {
        isValid: false,
        error: 'Invalid PDF file: too small or corrupted',
      };
    }

    const pdfHeader = pdfBuffer.subarray(0, 5).toString();
    if (!pdfHeader.startsWith('%PDF-')) {
      return {
        isValid: false,
        error: 'Invalid PDF file: missing PDF header',
      };
    }

    const pdfContent = pdfBuffer.toString('binary');
    if (
      pdfContent.includes('/Encrypt ') ||
      pdfContent.includes('/U (') ||
      pdfContent.includes('/O (')
    ) {
      return {
        isValid: false,
        error: 'PDF is password-protected or encrypted. Anthropic requires unencrypted PDFs.',
      };
    }

    const pageMatches = pdfContent.match(/\/Type[\s]*\/Page[^s]/g);
    const estimatedPages = pageMatches ? pageMatches.length : 1;

    if (estimatedPages > 100) {
      return {
        isValid: false,
        error: `PDF has approximately ${estimatedPages} pages, exceeding Anthropic's 100-page limit`,
      };
    }

    return { isValid: true };
  } catch (error) {
    console.error('PDF validation error:', error);
    return {
      isValid: false,
      error: 'Failed to validate PDF file',
    };
  }
}

/**
 * Matches Bedrock Claude 4+ model identifiers, including cross-region inference profile IDs.
 * Pattern: [region.]anthropic.claude-{family}-{version≥4}-{date}-v{n}:{rev}
 * e.g. "anthropic.claude-sonnet-4-20250514-v1:0" or "us.anthropic.claude-sonnet-4-20250514-v1:0"
 */
const BEDROCK_CLAUDE_4_PLUS_RE = /(?:^|\.)anthropic\.claude-(?:sonnet|opus|haiku)-[4-9]\d*-/;
const isBedrockClaude4Plus = (model?: string): boolean =>
  model != null && BEDROCK_CLAUDE_4_PLUS_RE.test(model);

/**
 * Matches Bedrock Nova model identifiers, including cross-region inference profile IDs.
 * e.g. "amazon.nova-pro-v1:0" or "us.amazon.nova-pro-v1:0"
 */
const isBedrockNova = (model?: string): boolean =>
  model != null && /(?:^|\.)amazon\.nova-/.test(model);

const pdfMimeType = 'application/pdf';
const docxMimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Returns true when the given model + MIME type combination is exempt from
 * Bedrock's default 4.5 MB per-document limit.
 *
 * Per AWS docs (https://docs.aws.amazon.com/bedrock/latest/userguide/inference-api-restrictions.html):
 * - Claude 4+: PDFs are exempt from the 4.5 MB limit
 * - Nova: PDFs and DOCX are exempt from the 4.5 MB limit
 */
const isExemptFromBedrockDocLimit = (model?: string, mimeType?: string): boolean => {
  if (mimeType === pdfMimeType) {
    return isBedrockClaude4Plus(model) || isBedrockNova(model);
  }
  if (mimeType === docxMimeType) {
    return isBedrockNova(model);
  }
  return false;
};

/**
 * Validates a document against Bedrock size limits. The default limit is 4.5 MB,
 * but Claude 4+ (PDF) and Nova (PDF/DOCX) models are exempt per AWS docs.
 * When exempt, falls back to a 32 MB request-level limit as a reasonable upper bound.
 * @param fileSize - The file size in bytes
 * @param mimeType - The MIME type of the document
 * @param fileBuffer - The file buffer (used for PDF header validation)
 * @param configuredFileSizeLimit - Optional configured file size limit from fileConfig (in bytes)
 * @param model - Optional Bedrock model identifier for model-specific limit exceptions
 * @returns Promise that resolves to validation result
 */
export async function validateBedrockDocument(
  fileSize: number,
  mimeType: string,
  fileBuffer?: Buffer,
  configuredFileSizeLimit?: number,
  model?: string,
): Promise<ValidationResult> {
  try {
    const exempt = isExemptFromBedrockDocLimit(model, mimeType);
    /** Default 4.5 MB; exempt models (Claude 4+ PDF, Nova PDF/DOCX) default to 32 MB when unconfigured */
    const providerLimit = exempt ? mbToBytes(32) : mbToBytes(4.5);
    const effectiveLimit = configuredFileSizeLimit ?? providerLimit;

    if (fileSize > effectiveLimit) {
      const limitMB = (effectiveLimit / (1024 * 1024)).toFixed(1);
      return {
        isValid: false,
        error: `File size (${(fileSize / (1024 * 1024)).toFixed(1)}MB) exceeds the ${limitMB}MB limit for Bedrock`,
      };
    }

    if (mimeType === pdfMimeType && fileBuffer) {
      if (fileBuffer.length < 5) {
        return {
          isValid: false,
          error: 'Invalid PDF file: too small or corrupted',
        };
      }

      const pdfHeader = fileBuffer.subarray(0, 5).toString();
      if (!pdfHeader.startsWith('%PDF-')) {
        return {
          isValid: false,
          error: 'Invalid PDF file: missing PDF header',
        };
      }
    }

    return { isValid: true };
  } catch (error) {
    console.error('Bedrock document validation error:', error);
    return {
      isValid: false,
      error: 'Failed to validate document file',
    };
  }
}

/**
 * Validates if a PDF meets OpenAI's requirements
 * @param fileSize - The file size in bytes
 * @param configuredFileSizeLimit - Optional configured file size limit from fileConfig (in bytes)
 * @returns Promise that resolves to validation result
 */
async function validateOpenAIPdf(
  fileSize: number,
  configuredFileSizeLimit?: number,
): Promise<PDFValidationResult> {
  const providerLimit = mbToBytes(10);
  const effectiveLimit = configuredFileSizeLimit ?? providerLimit;

  if (fileSize > effectiveLimit) {
    const limitMB = Math.round(effectiveLimit / (1024 * 1024));
    return {
      isValid: false,
      error: `PDF file size (${Math.round(fileSize / (1024 * 1024))}MB) exceeds the ${limitMB}MB limit`,
    };
  }

  return { isValid: true };
}

/**
 * Validates if a PDF meets Google's requirements
 * @param fileSize - The file size in bytes
 * @param configuredFileSizeLimit - Optional configured file size limit from fileConfig (in bytes)
 * @returns Promise that resolves to validation result
 */
async function validateGooglePdf(
  fileSize: number,
  configuredFileSizeLimit?: number,
): Promise<PDFValidationResult> {
  const providerLimit = mbToBytes(20);
  const effectiveLimit = configuredFileSizeLimit ?? providerLimit;

  if (fileSize > effectiveLimit) {
    const limitMB = Math.round(effectiveLimit / (1024 * 1024));
    return {
      isValid: false,
      error: `PDF file size (${Math.round(fileSize / (1024 * 1024))}MB) exceeds the ${limitMB}MB limit`,
    };
  }

  return { isValid: true };
}

/**
 * Validates video files for different providers
 * @param videoBuffer - The video file as a buffer
 * @param fileSize - The file size in bytes
 * @param provider - The provider to validate for
 * @param configuredFileSizeLimit - Optional configured file size limit from fileConfig (in bytes)
 * @returns Promise that resolves to validation result
 */
export async function validateVideo(
  videoBuffer: Buffer,
  fileSize: number,
  provider: Providers,
  configuredFileSizeLimit?: number,
): Promise<VideoValidationResult> {
  if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
    const providerLimit = mbToBytes(20);
    const effectiveLimit = configuredFileSizeLimit ?? providerLimit;

    if (fileSize > effectiveLimit) {
      const limitMB = Math.round(effectiveLimit / (1024 * 1024));
      return {
        isValid: false,
        error: `Video file size (${Math.round(fileSize / (1024 * 1024))}MB) exceeds the ${limitMB}MB limit`,
      };
    }
  }

  if (!videoBuffer || videoBuffer.length < 10) {
    return {
      isValid: false,
      error: 'Invalid video file: too small or corrupted',
    };
  }

  return { isValid: true };
}

/**
 * Validates audio files for different providers
 * @param audioBuffer - The audio file as a buffer
 * @param fileSize - The file size in bytes
 * @param provider - The provider to validate for
 * @param configuredFileSizeLimit - Optional configured file size limit from fileConfig (in bytes)
 * @returns Promise that resolves to validation result
 */
export async function validateAudio(
  audioBuffer: Buffer,
  fileSize: number,
  provider: Providers,
  configuredFileSizeLimit?: number,
): Promise<AudioValidationResult> {
  if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
    const providerLimit = mbToBytes(20);
    const effectiveLimit = configuredFileSizeLimit ?? providerLimit;

    if (fileSize > effectiveLimit) {
      const limitMB = Math.round(effectiveLimit / (1024 * 1024));
      return {
        isValid: false,
        error: `Audio file size (${Math.round(fileSize / (1024 * 1024))}MB) exceeds the ${limitMB}MB limit`,
      };
    }
  }

  if (!audioBuffer || audioBuffer.length < 10) {
    return {
      isValid: false,
      error: 'Invalid audio file: too small or corrupted',
    };
  }

  return { isValid: true };
}

/**
 * Validates image files for different providers
 * @param imageBuffer - The image file as a buffer
 * @param fileSize - The file size in bytes
 * @param provider - The provider to validate for
 * @param configuredFileSizeLimit - Optional configured file size limit from fileConfig (in bytes)
 * @returns Promise that resolves to validation result
 */
export async function validateImage(
  imageBuffer: Buffer,
  fileSize: number,
  provider: Providers | string,
  configuredFileSizeLimit?: number,
): Promise<ImageValidationResult> {
  if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
    const providerLimit = mbToBytes(20);
    const effectiveLimit = configuredFileSizeLimit ?? providerLimit;

    if (fileSize > effectiveLimit) {
      const limitMB = Math.round(effectiveLimit / (1024 * 1024));
      return {
        isValid: false,
        error: `Image file size (${Math.round(fileSize / (1024 * 1024))}MB) exceeds the ${limitMB}MB limit`,
      };
    }
  }

  if (provider === Providers.ANTHROPIC) {
    const providerLimit = mbToBytes(5);
    const effectiveLimit = configuredFileSizeLimit ?? providerLimit;

    if (fileSize > effectiveLimit) {
      const limitMB = Math.round(effectiveLimit / (1024 * 1024));
      return {
        isValid: false,
        error: `Image file size (${Math.round(fileSize / (1024 * 1024))}MB) exceeds the ${limitMB}MB limit`,
      };
    }
  }

  if (!imageBuffer || imageBuffer.length < 10) {
    return {
      isValid: false,
      error: 'Invalid image file: too small or corrupted',
    };
  }

  return { isValid: true };
}

// [knauf] Encrypted / password-protected file detection (KK20-190).
// Upstream only checks PDF encryption inside the Anthropic path
// (`validateAnthropicPdf`); KARL's active Azure path never reaches it. This
// is a provider-agnostic guard covering the two encryptable formats in the
// Knauf allow-list: PDF and OOXML (.docx/.xlsx/.pptx). Other allowed types
// (txt/md/csv/json/png/jpg) have no password-protection concept, and `.zip`
// isn't in the allow-list. Legacy binary `.doc`/`.xls` aren't in the allow-list
// either (rag_api can't embed them — users save as OOXML), so they're out of scope.
// NOTE: this block exceeds the Tier-4c 30-line guideline; extract to
// packages/knauf/ once ADR-017 lands. Until then it stays here as an additive
// export with near-zero merge surface (appended at end of file).
export interface EncryptionCheckResult {
  encrypted: boolean;
  /** i18n key (NOT English) forwarded verbatim by resolveUploadErrorMessage and
   * localized client-side via `localize(msg) || msg` — see utils/files.ts
   * (USER_FACING_UPLOAD_ERRORS) and client locales `com_knauf_error_file_encrypted`. */
  error?: string;
}

const OOXML_MIME_TYPES = new Set<string>([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** OLE2 / Compound File Binary Format magic. A *normal* OOXML file is a ZIP
 * (`PK\x03\x04`); an encrypted one is wrapped in a CFBF "EncryptedPackage". */
const CFBF_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Localized client-side (en/de). Same key for PDF + OOXML — the message is identical. */
const FILE_ENCRYPTED_ERROR_KEY = 'com_knauf_error_file_encrypted';

/** PDF "/Encrypt" trailer marker, searched as bytes (no full-buffer toString). */
const PDF_ENCRYPT_MARKER = Buffer.from('/Encrypt');

/** Bytes from the END of a PDF to scan for the /Encrypt trailer marker. The
 * `/Encrypt` entry lives in the trailer dictionary near EOF; scanning only the
 * tail avoids false positives from the literal `/Encrypt` appearing inside a
 * (typically uncompressed) content stream, and avoids materializing the file. */
const PDF_TRAILER_SCAN_BYTES = 4096;

/** Scan only the trailing region of a PDF buffer for the /Encrypt marker, so the
 * result is identical whether the whole file or just its tail is passed in. */
function pdfTailHasEncryptMarker(buffer: Buffer): boolean {
  const start = buffer.length > PDF_TRAILER_SCAN_BYTES ? buffer.length - PDF_TRAILER_SCAN_BYTES : 0;
  return buffer.subarray(start).includes(PDF_ENCRYPT_MARKER);
}

/**
 * Detects encrypted / password-protected PDF and OOXML files from their bytes.
 * Pure function — the PDF check scans only the buffer tail (trailer region), so
 * passing either the whole file or just its tail yields the same verdict. On the
 * upload path prefer `detectEncryptedFileAtPath`, which avoids reading the file.
 */
export function detectEncryptedFile(buffer: Buffer, mimetype: string): EncryptionCheckResult {
  if (!buffer || buffer.length < 8) {
    return { encrypted: false };
  }

  const isPdf = mimetype === 'application/pdf' || buffer.subarray(0, 5).toString() === '%PDF-';
  if (isPdf) {
    if (pdfTailHasEncryptMarker(buffer)) {
      return { encrypted: true, error: FILE_ENCRYPTED_ERROR_KEY };
    }
    return { encrypted: false };
  }

  if (OOXML_MIME_TYPES.has(mimetype) && buffer.subarray(0, 8).equals(CFBF_MAGIC)) {
    return { encrypted: true, error: FILE_ENCRYPTED_ERROR_KEY };
  }

  return { encrypted: false };
}

/**
 * Path-based variant for the upload route. Reads only the bytes the detector can
 * act on — an 8-byte head (to sniff `%PDF-` even when the declared mimetype lies,
 * and to test the OOXML CFBF magic) plus, for PDFs only, the trailer region —
 * instead of loading the entire upload into memory. Returns `{ encrypted: false }`
 * with no tail read for types outside the PDF/OOXML scope.
 */
export async function detectEncryptedFileAtPath(
  filePath: string,
  mimetype: string,
): Promise<EncryptionCheckResult> {
  const handle = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    if (bytesRead < 8) {
      return { encrypted: false };
    }

    const isPdf = mimetype === 'application/pdf' || head.subarray(0, 5).toString() === '%PDF-';
    if (isPdf) {
      const { size } = await handle.stat();
      const length = Math.min(PDF_TRAILER_SCAN_BYTES, size);
      const start = size > length ? size - length : 0;
      const tail = Buffer.alloc(length);
      await handle.read(tail, 0, length, start);
      return tail.includes(PDF_ENCRYPT_MARKER)
        ? { encrypted: true, error: FILE_ENCRYPTED_ERROR_KEY }
        : { encrypted: false };
    }

    if (OOXML_MIME_TYPES.has(mimetype) && head.equals(CFBF_MAGIC)) {
      return { encrypted: true, error: FILE_ENCRYPTED_ERROR_KEY };
    }

    return { encrypted: false };
  } finally {
    await handle.close();
  }
}
// End [knauf]
