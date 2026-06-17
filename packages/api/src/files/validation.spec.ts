import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Providers } from '@librechat/agents';
import { mbToBytes } from 'librechat-data-provider';
import {
  validatePdf,
  validateBedrockDocument,
  validateVideo,
  validateAudio,
  detectEncryptedFile,
  detectEncryptedFileAtPath,
} from './validation';

describe('PDF Validation with fileConfig.endpoints.*.fileSizeLimit', () => {
  /** Helper to create a PDF buffer with valid header */
  const createMockPdfBuffer = (sizeInMB: number): Buffer => {
    const bytes = Math.floor(sizeInMB * 1024 * 1024);
    const buffer = Buffer.alloc(bytes);
    buffer.write('%PDF-1.4\n', 0);
    return buffer;
  };

  describe('validatePdf - OpenAI provider', () => {
    const provider = Providers.OPENAI;

    it('should accept PDF within provider limit when no config provided', async () => {
      const pdfBuffer = createMockPdfBuffer(8);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject PDF exceeding provider limit when no config provided', async () => {
      const pdfBuffer = createMockPdfBuffer(12);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('12MB');
      expect(result.error).toContain('10MB');
    });

    it('should use configured limit when it is lower than provider limit', async () => {
      const configuredLimit = 5 * 1024 * 1024; // 5MB
      const pdfBuffer = createMockPdfBuffer(7); // Between configured and provider limit
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('7MB');
      expect(result.error).toContain('5MB');
    });

    it('should allow configured limit higher than provider default', async () => {
      const configuredLimit = 50 * 1024 * 1024; // 50MB (higher than 10MB provider default)
      const pdfBuffer = createMockPdfBuffer(12); // Between provider default and configured limit
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept PDF within both configured and provider limits', async () => {
      const configuredLimit = 50 * 1024 * 1024; // 50MB
      const pdfBuffer = createMockPdfBuffer(8);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept PDF within lower configured limit', async () => {
      const configuredLimit = 5 * 1024 * 1024; // 5MB
      const pdfBuffer = createMockPdfBuffer(4);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should handle exact limit size correctly', async () => {
      const configuredLimit = 10 * 1024 * 1024; // Exactly 10MB
      const pdfBuffer = Buffer.alloc(10 * 1024 * 1024);
      pdfBuffer.write('%PDF-1.4\n', 0);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(true);
    });
  });

  describe('validatePdf - Anthropic provider', () => {
    const provider = Providers.ANTHROPIC;

    it('should accept PDF within provider limit when no config provided', async () => {
      const pdfBuffer = createMockPdfBuffer(20);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject PDF exceeding provider limit when no config provided', async () => {
      const pdfBuffer = createMockPdfBuffer(35);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('35MB');
      expect(result.error).toContain('32MB');
    });

    it('should use configured limit when it is lower than provider limit', async () => {
      const configuredLimit = mbToBytes(15); // 15MB
      const pdfBuffer = createMockPdfBuffer(20); // Between configured and provider limit
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('20MB');
      expect(result.error).toContain('15MB');
    });

    it('should allow configured limit higher than provider default', async () => {
      const configuredLimit = mbToBytes(50); // 50MB (higher than 32MB provider default)
      const pdfBuffer = createMockPdfBuffer(35); // Between provider default and configured limit
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject encrypted PDFs regardless of size', async () => {
      const pdfBuffer = Buffer.alloc(1024);
      pdfBuffer.write('%PDF-1.4\n', 0);
      pdfBuffer.write('/Encrypt ', 100);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('encrypted');
    });

    it('should reject PDFs with invalid header', async () => {
      const pdfBuffer = Buffer.alloc(1024);
      pdfBuffer.write('INVALID', 0);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('PDF header');
    });

    it('should reject PDFs that are too small', async () => {
      const pdfBuffer = Buffer.alloc(3);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('too small');
    });
  });

  describe('validatePdf - Bedrock provider', () => {
    const provider = Providers.BEDROCK;

    it('should accept PDF within provider limit when no config provided', async () => {
      const pdfBuffer = createMockPdfBuffer(3);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject PDF exceeding 4.5MB hard limit when no config provided', async () => {
      const pdfBuffer = createMockPdfBuffer(5);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('4.5MB');
    });

    it('should use configured limit when it is lower than provider limit', async () => {
      const configuredLimit = mbToBytes(2);
      const pdfBuffer = createMockPdfBuffer(3);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('2.0MB');
    });

    it('should allow configured limit higher than 4.5MB default', async () => {
      const configuredLimit = mbToBytes(512);
      const pdfBuffer = createMockPdfBuffer(5);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject PDFs with invalid header', async () => {
      const pdfBuffer = Buffer.alloc(1024);
      pdfBuffer.write('INVALID', 0);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('PDF header');
    });

    it('should reject PDFs that are too small', async () => {
      const pdfBuffer = Buffer.alloc(3);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('too small');
    });
  });

  describe('validatePdf - Bedrock with model-specific exemptions', () => {
    const provider = Providers.BEDROCK;

    it('should exempt Claude 4+ PDFs from the 4.5MB limit', async () => {
      const pdfBuffer = createMockPdfBuffer(10);
      const model = 'anthropic.claude-sonnet-4-20250514-v1:0';
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, undefined, model);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should exempt Claude 4+ PDFs via cross-region inference profile ID', async () => {
      const pdfBuffer = createMockPdfBuffer(10);
      const model = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, undefined, model);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should exempt Nova PDFs from the 4.5MB limit', async () => {
      const pdfBuffer = createMockPdfBuffer(10);
      const model = 'amazon.nova-pro-v1:0';
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, undefined, model);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should exempt Nova PDFs via cross-region inference profile ID', async () => {
      const pdfBuffer = createMockPdfBuffer(10);
      const model = 'us.amazon.nova-pro-v1:0';
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, undefined, model);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should still enforce 4.5MB for non-exempt models without config override', async () => {
      const pdfBuffer = createMockPdfBuffer(5);
      const model = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, undefined, model);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('4.5MB');
    });

    it('should accept PDFs below 32MB for exempt Claude 4+ models', async () => {
      const pdfBuffer = createMockPdfBuffer(30);
      const model = 'anthropic.claude-opus-4-20250514-v1:0';
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, undefined, model);

      expect(result.isValid).toBe(true);
    });

    it('should reject exempt model PDFs exceeding 32MB', async () => {
      const pdfBuffer = createMockPdfBuffer(35);
      const model = 'anthropic.claude-sonnet-4-20250514-v1:0';
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, undefined, model);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('32.0MB');
    });

    it('should respect configuredFileSizeLimit when lower than 32MB for exempt models', async () => {
      const configuredLimit = mbToBytes(10);
      const pdfBuffer = createMockPdfBuffer(15);
      const model = 'anthropic.claude-sonnet-4-20250514-v1:0';
      const result = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        provider,
        configuredLimit,
        model,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('10.0MB');
    });

    it('should allow configuredFileSizeLimit higher than 32MB for exempt models', async () => {
      const configuredLimit = mbToBytes(50);
      const pdfBuffer = createMockPdfBuffer(35);
      const model = 'amazon.nova-pro-v1:0';
      const result = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        provider,
        configuredLimit,
        model,
      );

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow configuredFileSizeLimit higher than 4.5MB for non-exempt models', async () => {
      const configuredLimit = mbToBytes(100);
      const pdfBuffer = createMockPdfBuffer(5);
      const model = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
      const result = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        provider,
        configuredLimit,
        model,
      );

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('validateBedrockDocument - non-PDF types', () => {
    it('should accept CSV within 4.5MB limit', async () => {
      const fileSize = 2 * 1024 * 1024;
      const result = await validateBedrockDocument(fileSize, 'text/csv');

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept DOCX within 4.5MB limit', async () => {
      const fileSize = 3 * 1024 * 1024;
      const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const result = await validateBedrockDocument(fileSize, mimeType);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject non-PDF document exceeding 4.5MB default limit', async () => {
      const fileSize = 5 * 1024 * 1024;
      const result = await validateBedrockDocument(fileSize, 'text/plain');

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('4.5MB');
    });

    it('should allow configured limit higher than 4.5MB for non-PDF', async () => {
      const fileSize = 5 * 1024 * 1024;
      const configuredLimit = mbToBytes(512);
      const result = await validateBedrockDocument(
        fileSize,
        'text/html',
        undefined,
        configuredLimit,
      );

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should use configured limit when lower than provider limit for non-PDF', async () => {
      const fileSize = 3 * 1024 * 1024;
      const configuredLimit = mbToBytes(2);
      const result = await validateBedrockDocument(
        fileSize,
        'text/markdown',
        undefined,
        configuredLimit,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('2.0MB');
    });

    it('should exempt Nova DOCX from 4.5MB limit', async () => {
      const fileSize = 10 * 1024 * 1024;
      const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const model = 'amazon.nova-pro-v1:0';
      const result = await validateBedrockDocument(fileSize, mimeType, undefined, undefined, model);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should NOT exempt Claude 4+ DOCX from 4.5MB limit (only PDF exempt)', async () => {
      const fileSize = 5 * 1024 * 1024;
      const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const model = 'anthropic.claude-sonnet-4-20250514-v1:0';
      const result = await validateBedrockDocument(fileSize, mimeType, undefined, undefined, model);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('4.5MB');
    });

    it('should not run PDF header check on non-PDF types', async () => {
      const buffer = Buffer.from('NOT-A-PDF-HEADER-but-valid-csv-content');
      const result = await validateBedrockDocument(buffer.length, 'text/csv', buffer);

      expect(result.isValid).toBe(true);
    });

    it('should still run PDF header check when mimeType is application/pdf', async () => {
      const buffer = Buffer.alloc(1024);
      buffer.write('INVALID', 0);
      const result = await validateBedrockDocument(buffer.length, 'application/pdf', buffer);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('PDF header');
    });
  });

  describe('validatePdf - Google provider', () => {
    const provider = Providers.GOOGLE;

    it('should accept PDF within provider limit when no config provided', async () => {
      const pdfBuffer = createMockPdfBuffer(15);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject PDF exceeding provider limit when no config provided', async () => {
      const pdfBuffer = createMockPdfBuffer(25);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('25MB');
      expect(result.error).toContain('20MB');
    });

    it('should use configured limit when it is lower than provider limit', async () => {
      const configuredLimit = 10 * 1024 * 1024; // 10MB
      const pdfBuffer = createMockPdfBuffer(15); // Between configured and provider limit
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('15MB');
      expect(result.error).toContain('10MB');
    });

    it('should allow configured limit higher than provider default', async () => {
      const configuredLimit = 50 * 1024 * 1024; // 50MB (higher than 20MB provider default)
      const pdfBuffer = createMockPdfBuffer(25); // Between provider default and configured limit
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('validatePdf - VertexAI provider', () => {
    const provider = Providers.VERTEXAI;

    it('should accept PDF within provider limit', async () => {
      const pdfBuffer = createMockPdfBuffer(15);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(true);
    });

    it('should respect configured limit', async () => {
      const configuredLimit = 10 * 1024 * 1024;
      const pdfBuffer = createMockPdfBuffer(15);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('10MB');
    });
  });

  describe('validatePdf - Azure OpenAI provider', () => {
    const provider = Providers.AZURE;

    it('should accept PDF within OpenAI-like provider limit', async () => {
      const pdfBuffer = createMockPdfBuffer(8);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(true);
    });

    it('should respect configured limit for Azure', async () => {
      const configuredLimit = 5 * 1024 * 1024;
      const pdfBuffer = createMockPdfBuffer(7);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider, configuredLimit);

      expect(result.isValid).toBe(false);
    });
  });

  describe('validatePdf - Unsupported providers', () => {
    it('should return valid for providers without specific validation', async () => {
      const pdfBuffer = createMockPdfBuffer(100); // Very large file
      const provider = 'unsupported' as Providers;
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, provider);

      expect(result.isValid).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle zero-configured limit', async () => {
      const configuredLimit = 0;
      const pdfBuffer = createMockPdfBuffer(1);
      const result = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        Providers.OPENAI,
        configuredLimit,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('0MB');
    });

    it('should handle very small PDF files', async () => {
      const pdfBuffer = Buffer.alloc(100);
      pdfBuffer.write('%PDF-1.4\n', 0);
      const result = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        Providers.OPENAI,
        10 * 1024 * 1024,
      );

      expect(result.isValid).toBe(true);
    });

    it('should handle configured limit equal to provider limit', async () => {
      const configuredLimit = 10 * 1024 * 1024; // Same as OpenAI provider limit
      const pdfBuffer = createMockPdfBuffer(12);
      const result = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        Providers.OPENAI,
        configuredLimit,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('10MB');
    });

    it('should use provider limit when configured limit is undefined', async () => {
      const pdfBuffer = createMockPdfBuffer(12);
      const result = await validatePdf(pdfBuffer, pdfBuffer.length, Providers.OPENAI, undefined);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('10MB');
    });
  });

  describe('Bug reproduction - Original issue', () => {
    it('should reproduce the original bug scenario from issue description', async () => {
      /**
       * Original bug: User configures openAI.fileSizeLimit = 50MB in librechat.yaml
       * Uploads a 15MB PDF to OpenAI endpoint
       * Expected: Should be accepted (within 50MB config)
       * Actual (before fix): Rejected with "exceeds 10MB limit"
       */
      const configuredLimit = mbToBytes(50); // User configured 50MB
      const pdfBuffer = createMockPdfBuffer(15); // User uploads 15MB file

      const result = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        Providers.OPENAI,
        configuredLimit,
      );

      /**
       * After fix: Should be accepted because configured limit (50MB) overrides
       * provider default (10MB), allowing for API changes
       */
      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow user to set stricter limits than provider', async () => {
      /**
       * Use case: User wants to enforce stricter limits than provider allows
       * User configures openAI.fileSizeLimit = 5MB
       * Uploads a 7MB PDF to OpenAI endpoint
       * Expected: Should be rejected (exceeds 5MB configured limit)
       */
      const configuredLimit = mbToBytes(5); // User configured 5MB
      const pdfBuffer = createMockPdfBuffer(7); // User uploads 7MB file

      const result = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        Providers.OPENAI,
        configuredLimit,
      );

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('7MB');
      expect(result.error).toContain('5MB');
    });

    it('should allow upload within stricter user-configured limit', async () => {
      /**
       * User configures openAI.fileSizeLimit = 5MB
       * Uploads a 4MB PDF
       * Expected: Should be accepted
       */
      const configuredLimit = mbToBytes(5);
      const pdfBuffer = createMockPdfBuffer(4);

      const result = await validatePdf(
        pdfBuffer,
        pdfBuffer.length,
        Providers.OPENAI,
        configuredLimit,
      );

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Video and Audio Validation with fileConfig', () => {
    /** Helper to create a mock video/audio buffer */
    const createMockMediaBuffer = (sizeInMB: number): Buffer => {
      const bytes = Math.floor(sizeInMB * 1024 * 1024);
      return Buffer.alloc(bytes);
    };

    describe('validateVideo - Google provider', () => {
      const provider = Providers.GOOGLE;

      it('should accept video within provider limit when no config provided', async () => {
        const videoBuffer = createMockMediaBuffer(15);
        const result = await validateVideo(videoBuffer, videoBuffer.length, provider);

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it('should reject video exceeding provider limit when no config provided', async () => {
        const videoBuffer = createMockMediaBuffer(25);
        const result = await validateVideo(videoBuffer, videoBuffer.length, provider);

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('25MB');
        expect(result.error).toContain('20MB');
      });

      it('should use configured limit when it is lower than provider limit', async () => {
        const configuredLimit = mbToBytes(10); // 10MB
        const videoBuffer = createMockMediaBuffer(15); // Between configured and provider limit
        const result = await validateVideo(
          videoBuffer,
          videoBuffer.length,
          provider,
          configuredLimit,
        );

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('15MB');
        expect(result.error).toContain('10MB');
      });

      it('should allow configured limit higher than provider default', async () => {
        const configuredLimit = mbToBytes(50); // 50MB (higher than 20MB provider default)
        const videoBuffer = createMockMediaBuffer(25); // Between provider default and configured limit
        const result = await validateVideo(
          videoBuffer,
          videoBuffer.length,
          provider,
          configuredLimit,
        );

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it('should accept video within lower configured limit', async () => {
        const configuredLimit = mbToBytes(8);
        const videoBuffer = createMockMediaBuffer(7);
        const result = await validateVideo(
          videoBuffer,
          videoBuffer.length,
          provider,
          configuredLimit,
        );

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it('should reject videos that are too small', async () => {
        const videoBuffer = Buffer.alloc(5);
        const result = await validateVideo(videoBuffer, videoBuffer.length, provider);

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('too small');
      });
    });

    describe('validateAudio - Google provider', () => {
      const provider = Providers.GOOGLE;

      it('should accept audio within provider limit when no config provided', async () => {
        const audioBuffer = createMockMediaBuffer(15);
        const result = await validateAudio(audioBuffer, audioBuffer.length, provider);

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it('should reject audio exceeding provider limit when no config provided', async () => {
        const audioBuffer = createMockMediaBuffer(25);
        const result = await validateAudio(audioBuffer, audioBuffer.length, provider);

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('25MB');
        expect(result.error).toContain('20MB');
      });

      it('should use configured limit when it is lower than provider limit', async () => {
        const configuredLimit = mbToBytes(10); // 10MB
        const audioBuffer = createMockMediaBuffer(15); // Between configured and provider limit
        const result = await validateAudio(
          audioBuffer,
          audioBuffer.length,
          provider,
          configuredLimit,
        );

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('15MB');
        expect(result.error).toContain('10MB');
      });

      it('should allow configured limit higher than provider default', async () => {
        const configuredLimit = mbToBytes(50); // 50MB (higher than 20MB provider default)
        const audioBuffer = createMockMediaBuffer(25); // Between provider default and configured limit
        const result = await validateAudio(
          audioBuffer,
          audioBuffer.length,
          provider,
          configuredLimit,
        );

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it('should accept audio within lower configured limit', async () => {
        const configuredLimit = mbToBytes(8);
        const audioBuffer = createMockMediaBuffer(7);
        const result = await validateAudio(
          audioBuffer,
          audioBuffer.length,
          provider,
          configuredLimit,
        );

        expect(result.isValid).toBe(true);
        expect(result.error).toBeUndefined();
      });

      it('should reject audio files that are too small', async () => {
        const audioBuffer = Buffer.alloc(5);
        const result = await validateAudio(audioBuffer, audioBuffer.length, provider);

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('too small');
      });
    });

    describe('validateVideo and validateAudio - VertexAI provider', () => {
      const provider = Providers.VERTEXAI;

      it('should respect configured video limit for VertexAI', async () => {
        const configuredLimit = mbToBytes(10);
        const videoBuffer = createMockMediaBuffer(15);
        const result = await validateVideo(
          videoBuffer,
          videoBuffer.length,
          provider,
          configuredLimit,
        );

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('10MB');
      });

      it('should respect configured audio limit for VertexAI', async () => {
        const configuredLimit = mbToBytes(10);
        const audioBuffer = createMockMediaBuffer(15);
        const result = await validateAudio(
          audioBuffer,
          audioBuffer.length,
          provider,
          configuredLimit,
        );

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('10MB');
      });
    });

    describe('validateVideo and validateAudio - Unsupported providers', () => {
      it('should return valid for video from unsupported provider', async () => {
        const videoBuffer = createMockMediaBuffer(100);
        const provider = Providers.OPENAI;
        const result = await validateVideo(videoBuffer, videoBuffer.length, provider);

        expect(result.isValid).toBe(true);
      });

      it('should return valid for audio from unsupported provider', async () => {
        const audioBuffer = createMockMediaBuffer(100);
        const provider = Providers.OPENAI;
        const result = await validateAudio(audioBuffer, audioBuffer.length, provider);

        expect(result.isValid).toBe(true);
      });
    });
  });
});

// [knauf] detectEncryptedFile — PDF + OOXML encryption detection (KK20-190).
describe('detectEncryptedFile', () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const CFBF_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

  it('rejects an encrypted PDF (has /Encrypt)', () => {
    const buf = Buffer.from('%PDF-1.6\n... /Encrypt 12 0 R ... trailer', 'binary');
    const result = detectEncryptedFile(buf, 'application/pdf');
    expect(result.encrypted).toBe(true);
    expect(result.error).toBe('com_knauf_error_file_encrypted');
  });

  it('accepts a plain PDF (no /Encrypt)', () => {
    const buf = Buffer.from('%PDF-1.4\nhello world plain content', 'binary');
    expect(detectEncryptedFile(buf, 'application/pdf').encrypted).toBe(false);
  });

  it('accepts a non-encrypted PDF with /Encrypt only in an early content stream (F6 regression)', () => {
    // The /Encrypt entry is authoritative only in the trailer dictionary near EOF.
    // A non-encrypted PDF can carry the literal bytes "/Encrypt" inside an
    // (uncompressed) content stream; the tail-only scan must NOT false-positive.
    const head = Buffer.from('%PDF-1.7\nstream ... /Encrypt ... endstream\n', 'binary');
    const padding = Buffer.alloc(5000, 0x20); // > the 4096-byte trailer scan window
    const trailer = Buffer.from('\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF', 'binary');
    const buf = Buffer.concat([head, padding, trailer]);
    expect(detectEncryptedFile(buf, 'application/pdf').encrypted).toBe(false);
  });

  it('rejects an encrypted OOXML file (CFBF magic, declared docx)', () => {
    const buf = Buffer.concat([CFBF_HEADER, Buffer.alloc(64)]);
    const result = detectEncryptedFile(buf, DOCX);
    expect(result.encrypted).toBe(true);
    expect(result.error).toBe('com_knauf_error_file_encrypted');
  });

  it('accepts a normal OOXML file (ZIP magic, declared xlsx)', () => {
    const buf = Buffer.concat([ZIP_HEADER, Buffer.alloc(64)]);
    expect(detectEncryptedFile(buf, XLSX).encrypted).toBe(false);
  });

  it('ignores types outside the PDF/OOXML scope (e.g. png)', () => {
    const buf = Buffer.concat([CFBF_HEADER, Buffer.alloc(64)]);
    // Even with CFBF bytes, a non-OOXML mime is out of scope → not flagged.
    expect(detectEncryptedFile(buf, 'image/png').encrypted).toBe(false);
  });

  it('handles tiny/empty buffers safely', () => {
    expect(detectEncryptedFile(Buffer.alloc(0), 'application/pdf').encrypted).toBe(false);
    expect(detectEncryptedFile(Buffer.from([0x25]), 'application/pdf').encrypted).toBe(false);
  });
});

// detectEncryptedFileAtPath — partial-read variant used on the upload route. It
// must reach the same verdict as detectEncryptedFile while reading only the file
// head (+ PDF trailer region), never the whole file.
describe('detectEncryptedFileAtPath', () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const CFBF_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
  const tmpFiles: string[] = [];

  async function writeTmp(buf: Buffer): Promise<string> {
    const file = path.join(
      os.tmpdir(),
      `knauf-enc-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`,
    );
    await fs.writeFile(file, buf);
    tmpFiles.push(file);
    return file;
  }

  afterAll(async () => {
    await Promise.all(tmpFiles.map((file) => fs.rm(file, { force: true })));
  });

  it('rejects an encrypted PDF (/Encrypt in trailer)', async () => {
    const file = await writeTmp(Buffer.from('%PDF-1.6\n... /Encrypt 1 0 R ... trailer', 'binary'));
    const result = await detectEncryptedFileAtPath(file, 'application/pdf');
    expect(result.encrypted).toBe(true);
    expect(result.error).toBe('com_knauf_error_file_encrypted');
  });

  it('accepts a plain PDF', async () => {
    const file = await writeTmp(Buffer.from('%PDF-1.4\nhello world plain content', 'binary'));
    expect((await detectEncryptedFileAtPath(file, 'application/pdf')).encrypted).toBe(false);
  });

  it('does not false-positive on /Encrypt outside the trailer window (F6 regression)', async () => {
    const head = Buffer.from('%PDF-1.7\nstream ... /Encrypt ... endstream\n', 'binary');
    const padding = Buffer.alloc(5000, 0x20);
    const trailer = Buffer.from('\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF', 'binary');
    const file = await writeTmp(Buffer.concat([head, padding, trailer]));
    expect((await detectEncryptedFileAtPath(file, 'application/pdf')).encrypted).toBe(false);
  });

  it('rejects an encrypted OOXML file (CFBF magic, head-only read)', async () => {
    const file = await writeTmp(Buffer.concat([CFBF_HEADER, Buffer.alloc(64)]));
    expect((await detectEncryptedFileAtPath(file, DOCX)).encrypted).toBe(true);
  });

  it('accepts a normal OOXML file (ZIP magic)', async () => {
    const file = await writeTmp(Buffer.concat([ZIP_HEADER, Buffer.alloc(64)]));
    expect((await detectEncryptedFileAtPath(file, XLSX)).encrypted).toBe(false);
  });

  it('does not flag a non-PDF/OOXML type even with CFBF bytes', async () => {
    const file = await writeTmp(Buffer.concat([CFBF_HEADER, Buffer.alloc(64)]));
    expect((await detectEncryptedFileAtPath(file, 'image/png')).encrypted).toBe(false);
  });

  it('handles tiny files safely', async () => {
    const file = await writeTmp(Buffer.from([0x25]));
    expect((await detectEncryptedFileAtPath(file, 'application/pdf')).encrypted).toBe(false);
  });
});
// End [knauf]
