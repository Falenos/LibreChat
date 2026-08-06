import { promises as fs } from 'node:fs';
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
 * e.g. "anthropic.claude-sonnet-4-6" or "us.anthropic.claude-sonnet-4-6"
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

// [knauf] Encrypted OOXML container detection (KK20-190, narrowed by KK20-232).
// Upstream only checks PDF encryption inside the Anthropic path
// (`validateAnthropicPdf`); KARL's active Azure path never reaches it. This
// remains a provider-agnostic guard for OOXML (.docx/.xlsx/.pptx). PDF access
// is parsed separately for File Search by @knauf/knauf/server/pdfAccessProbe,
// because an /Encrypt dictionary does not mean an open password is required.
// Other allowed types
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

/** OLE2 / Compound File Binary Format magic. A *normal* OOXML file is a ZIP
 * (`PK\x03\x04`); an encrypted one is wrapped in a CFBF "EncryptedPackage".
 * Detection is byte-sniffed, NOT gated on the declared mimetype: req.file.mimetype
 * is the verbatim multipart Content-Type and is attacker-controlled, so an
 * encrypted .docx sent as application/zip / application/pdf must not slip past.
 * No allow-listed format (pdf / modern-OOXML=zip / png / jpeg / webp / txt / md /
 * csv / json) begins with CFBF magic; legacy .doc/.xls binaries are also CFBF but
 * are rejected by the allow-list before this check runs. (Edge case: a legacy .doc
 * renamed to .docx slips past the allow-list and is reported as "encrypted" here —
 * CFBF can't distinguish encrypted-OOXML from a mislabeled OLE2 binary; both are
 * unprocessable, so the rejection is correct even if the wording isn't precise.)
 * KK20-190. */
const CFBF_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Localized client-side (en/de). */
const FILE_ENCRYPTED_ERROR_KEY = 'com_knauf_error_file_encrypted';

/**
 * Detects encrypted OOXML containers from their bytes.
 */
export function detectEncryptedFile(buffer: Buffer, _mimetype: string): EncryptionCheckResult {
  if (!buffer || buffer.length < 8) {
    return { encrypted: false };
  }

  // CFBF magic is byte-sniffed first, independent of the declared mimetype, so a
  // spoofed Content-Type can't hide an encrypted OOXML (see CFBF_MAGIC note).
  if (buffer.subarray(0, 8).equals(CFBF_MAGIC)) {
    return { encrypted: true, error: FILE_ENCRYPTED_ERROR_KEY };
  }

  return { encrypted: false };
}

/**
 * Path-based variant for the upload route. Reads only the 8-byte CFBF header.
 */
export async function detectEncryptedFileAtPath(
  filePath: string,
  _mimetype: string,
): Promise<EncryptionCheckResult> {
  const handle = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(8);
    const { bytesRead } = await handle.read(head, 0, 8, 0);
    if (bytesRead < 8) {
      return { encrypted: false };
    }

    // CFBF magic byte-sniffed first, independent of the declared mimetype (see
    // CFBF_MAGIC note) — keeps the verdict identical to detectEncryptedFile.
    if (head.equals(CFBF_MAGIC)) {
      return { encrypted: true, error: FILE_ENCRYPTED_ERROR_KEY };
    }

    return { encrypted: false };
  } finally {
    await handle.close();
  }
}
// End [knauf]
