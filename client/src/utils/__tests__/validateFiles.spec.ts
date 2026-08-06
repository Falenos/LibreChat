import {
  megabyte,
  EModelEndpoint,
  EToolResources,
  fileConfig as defaultFileConfig,
  // [knauf] per-category caps — single source of truth for the locale lockstep drift-guard. KK20-190.
  knaufCategorySizeLimits,
} from 'librechat-data-provider';
import type { EndpointFileConfig, FileConfig } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { validateFiles } from '../files';
// [knauf] locale JSON for the cap↔copy lockstep drift-guard (KK20-190).
import enTranslation from '~/locales/en/translation.json';
import deTranslation from '~/locales/de/translation.json';

const supportedMimeTypes = defaultFileConfig.endpoints.default.supportedMimeTypes;

function makeEndpointConfig(overrides: Partial<EndpointFileConfig> = {}): EndpointFileConfig {
  return {
    fileLimit: 10,
    fileSizeLimit: 25 * megabyte,
    totalSizeLimit: 100 * megabyte,
    supportedMimeTypes,
    disabled: false,
    ...overrides,
  };
}

function makeFile(name: string, type: string, size: number): File {
  const content = new ArrayBuffer(size);
  return new File([content], name, { type });
}

function makeExtendedFile(overrides: Partial<ExtendedFile> = {}): ExtendedFile {
  return {
    file_id: 'ext-1',
    size: 1024,
    progress: 1,
    type: 'application/pdf',
    ...overrides,
  };
}

describe('validateFiles', () => {
  let setError: jest.Mock;
  let files: Map<string, ExtendedFile>;
  let endpointFileConfig: EndpointFileConfig;
  const fileConfig: FileConfig | null = null;

  beforeEach(() => {
    setError = jest.fn();
    files = new Map();
    endpointFileConfig = makeEndpointConfig();
  });

  it('returns true when all checks pass', () => {
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  // [knauf] NO-TICKET — SVG context uses the endpoint allow-list, not text-extractor MIMEs.
  it('accepts an SVG uploaded as readable message context', () => {
    const fileList = [makeFile('mark.svg', 'image/svg+xml', 1024)];
    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig,
      endpoint: EModelEndpoint.azureOpenAI,
      toolResource: EToolResources.context,
    });
    expect(result).toBe(true);
  });
  // End [knauf]

  it('rejects when endpoint is disabled', () => {
    endpointFileConfig = makeEndpointConfig({ disabled: true });
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_ui_attach_error_disabled');
  });

  it('rejects empty files (zero bytes)', () => {
    const fileList = [makeFile('empty.pdf', 'application/pdf', 0)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_error_files_empty');
  });

  it('rejects when fileLimit would be exceeded', () => {
    endpointFileConfig = makeEndpointConfig({ fileLimit: 3 });
    files = new Map([
      ['f1', makeExtendedFile({ file_id: 'f1', filename: 'one.pdf', size: 2048 })],
      ['f2', makeExtendedFile({ file_id: 'f2', filename: 'two.pdf', size: 3072 })],
    ]);
    const fileList = [
      makeFile('a.pdf', 'application/pdf', 1024),
      makeFile('b.pdf', 'application/pdf', 2048),
    ];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('File limit reached: 3 files');
  });

  it('allows upload when exactly at fileLimit boundary', () => {
    endpointFileConfig = makeEndpointConfig({ fileLimit: 3 });
    files = new Map([
      ['f1', makeExtendedFile({ file_id: 'f1', filename: 'one.pdf', size: 2048 })],
      ['f2', makeExtendedFile({ file_id: 'f2', filename: 'two.pdf', size: 3072 })],
    ]);
    const fileList = [makeFile('a.pdf', 'application/pdf', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
  });

  it('rejects unsupported MIME type', () => {
    const fileList = [makeFile('data.xyz', 'application/x-unknown', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('Unsupported file type: application/x-unknown');
  });

  it('normalizes Windows ZIP MIME type before validation', () => {
    const fileList = [makeFile('archive.zip', 'application/x-zip-compressed', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
    expect(fileList[0].type).toBe('application/zip');
    expect(setError).not.toHaveBeenCalled();
  });

  it('infers ZIP MIME type when the browser does not provide one', () => {
    const fileList = [makeFile('archive.zip', '', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
    expect(fileList[0].type).toBe('application/zip');
    expect(setError).not.toHaveBeenCalled();
  });

  it('rejects when file size equals fileSizeLimit (>= comparison)', () => {
    const limit = 5 * megabyte;
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: limit });
    const fileList = [makeFile('exact.pdf', 'application/pdf', limit)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`File size limit exceeded: ${limit / megabyte} MB`);
  });

  it('allows file just under fileSizeLimit', () => {
    const limit = 5 * megabyte;
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: limit });
    const fileList = [makeFile('under.pdf', 'application/pdf', limit - 1)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
  });

  // [knauf] Per-category size caps (KK20-190): documents 25 / data 50 / images 20 MB,
  // enforced on top of the endpoint fileSizeLimit via knaufCategorySizeLimit. The
  // endpoint fileSizeLimit is set to 50 MB here so the per-category cap is what fires.
  // The caps + Knauf messaging are scoped to the allow-list endpoints (azureOpenAI /
  // agents) — mirroring filterFile server-side — so these pass `endpoint`.
  it('rejects a document over the 25 MB per-category cap with the localized key', () => {
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: 50 * megabyte });
    const fileList = [makeFile('big.pdf', 'application/pdf', 30 * megabyte)];
    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig,
      endpoint: EModelEndpoint.azureOpenAI,
    });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_knauf_error_file_too_large_document');
  });

  it('rejects an image over the 20 MB per-category cap with the localized key', () => {
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: 50 * megabyte });
    const fileList = [makeFile('big.png', 'image/png', 26 * megabyte)];
    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig,
      endpoint: EModelEndpoint.agents,
    });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_knauf_error_file_too_large_image');
  });

  it('allows a document exactly at the 25 MB per-category cap (strict > boundary)', () => {
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: 50 * megabyte });
    const fileList = [makeFile('exact.pdf', 'application/pdf', 25 * megabyte)];
    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig,
      endpoint: EModelEndpoint.azureOpenAI,
    });
    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  // The data cap (50 MB) EQUALS the endpoint fileSizeLimit (50 MB). The per-category
  // cap must be authoritative so a file exactly at 50 MB is allowed (strict `>`) and
  // the generic endpoint check (`>=`, non-localized) is skipped — otherwise the client
  // rejects a 50 MB spreadsheet that the server (filterFile, `>`) accepts. KK20-190.
  const xlsxMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const xlsxAllowList = [/^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/];

  it('allows a spreadsheet exactly at the 50 MB data cap (== endpoint fileSizeLimit)', () => {
    endpointFileConfig = makeEndpointConfig({
      fileSizeLimit: 50 * megabyte,
      supportedMimeTypes: xlsxAllowList,
    });
    const fileList = [makeFile('exact.xlsx', xlsxMimeType, 50 * megabyte)];
    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig,
      endpoint: EModelEndpoint.azureOpenAI,
    });
    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  it('rejects a spreadsheet over the 50 MB data cap with the localized key', () => {
    endpointFileConfig = makeEndpointConfig({
      fileSizeLimit: 50 * megabyte,
      supportedMimeTypes: xlsxAllowList,
    });
    const fileList = [makeFile('big.xlsx', xlsxMimeType, 50 * megabyte + 1)];
    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig,
      endpoint: EModelEndpoint.azureOpenAI,
    });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_knauf_error_file_too_large_data');
  });

  // The Knauf allow-list (librechat.yaml &knauf_allowed_mime) excludes legacy
  // binaries, so these two cases use a restrictive supportedMimeTypes that mirrors
  // production — the broad upstream default would accept .doc and the message would
  // never fire (the exact gap this messaging exists to cover).
  const knaufAllowList = [/^application\/pdf$/, /^image\/(png|jpeg|webp)$/];

  it('returns the legacy-Office key for a .doc on a Knauf endpoint', () => {
    endpointFileConfig = makeEndpointConfig({ supportedMimeTypes: knaufAllowList });
    const fileList = [makeFile('report.doc', 'application/msword', 1024)];
    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig,
      endpoint: EModelEndpoint.azureOpenAI,
    });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_knauf_error_legacy_doc');
  });

  it('returns the friendly unsupported-type key for an unknown type on a Knauf endpoint', () => {
    endpointFileConfig = makeEndpointConfig({ supportedMimeTypes: knaufAllowList });
    const fileList = [makeFile('data.xyz', 'application/x-unknown', 1024)];
    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig,
      endpoint: EModelEndpoint.azureOpenAI,
    });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_knauf_error_unsupported_type');
  });

  it('does NOT apply the per-category cap on a non-Knauf endpoint (keeps upstream behavior)', () => {
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: 50 * megabyte });
    const fileList = [makeFile('big.pdf', 'application/pdf', 30 * megabyte)];
    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig,
      endpoint: EModelEndpoint.bedrock,
    });
    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });
  // End [knauf]

  it('rejects when totalSizeLimit would be exceeded', () => {
    const limit = 10 * megabyte;
    endpointFileConfig = makeEndpointConfig({ totalSizeLimit: limit });
    files = new Map([['f1', makeExtendedFile({ file_id: 'f1', size: 6 * megabyte })]]);
    const fileList = [makeFile('big.pdf', 'application/pdf', 5 * megabyte)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`Total file size limit exceeded: ${limit / megabyte} MB`);
  });

  it('allows when totalSizeLimit is exactly met', () => {
    const limit = 10 * megabyte;
    endpointFileConfig = makeEndpointConfig({ totalSizeLimit: limit });
    files = new Map([['f1', makeExtendedFile({ file_id: 'f1', size: 5 * megabyte })]]);
    const fileList = [makeFile('fits.pdf', 'application/pdf', 5 * megabyte)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
  });

  it('rejects duplicate files', () => {
    files = new Map([
      [
        'f1',
        makeExtendedFile({
          file_id: 'f1',
          file: makeFile('doc.pdf', 'application/pdf', 1024),
          filename: 'doc.pdf',
          size: 1024,
          type: 'application/pdf',
        }),
      ],
    ]);
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_error_files_dupe');
  });

  it('enforces check ordering: disabled before fileLimit', () => {
    endpointFileConfig = makeEndpointConfig({ disabled: true, fileLimit: 1 });
    files = new Map([['f1', makeExtendedFile({ file_id: 'f1', filename: 'existing.pdf' })]]);
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];
    validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(setError).toHaveBeenCalledWith('com_ui_attach_error_disabled');
  });

  it('enforces check ordering: fileLimit before fileSizeLimit', () => {
    const limit = 1;
    endpointFileConfig = makeEndpointConfig({ fileLimit: 1, fileSizeLimit: limit });
    files = new Map([['f1', makeExtendedFile({ file_id: 'f1', filename: 'existing.pdf' })]]);
    const fileList = [makeFile('huge.pdf', 'application/pdf', limit)];
    validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(setError).toHaveBeenCalledWith('File limit reached: 1 files');
  });
});

// [knauf] Lockstep drift-guard (KK20-190). The per-category caps are the single
// source of truth in `knaufCategorySizeLimits`, but the "file too large" error
// strings hardcode the MB number in plain text (server throws bare i18n keys, so
// the number can't be interpolated — see the LOCKSTEP note in file-config.ts).
// This pins the copy to the map: if a cap changes without the locale string being
// updated, this fails in CI instead of shipping a wrong number to users. Covers en
// + de (the two locales Knauf maintains). KK20-190.
describe('Knauf per-category cap ↔ locale copy lockstep', () => {
  const localesByName: Record<string, Record<string, string>> = {
    en: enTranslation,
    de: deTranslation,
  };
  const categoryToKey: Record<keyof typeof knaufCategorySizeLimits, string> = {
    document: 'com_knauf_error_file_too_large_document',
    data: 'com_knauf_error_file_too_large_data',
    image: 'com_knauf_error_file_too_large_image',
    svg: 'com_knauf_error_file_too_large_svg',
  };

  for (const [locale, translation] of Object.entries(localesByName)) {
    for (const [category, key] of Object.entries(categoryToKey)) {
      const mb =
        knaufCategorySizeLimits[category as keyof typeof knaufCategorySizeLimits] / megabyte;
      it(`${locale}: "${key}" states ${mb} MB`, () => {
        const message = translation[key];
        expect(message).toBeDefined();
        // Match the integer MB as a whole word so e.g. 25 doesn't satisfy a "250" check.
        expect(message).toMatch(new RegExp(String.raw`\b${mb}\b`));
      });
    }
  }
});
// End [knauf]

// [knauf] KK20-227 — re-index (delete + re-upload) must validate against the
// files map with the just-deleted file already removed. If it is still present
// when the identical blob is re-uploaded, validateFiles flags a dupe and the
// re-upload is lost (the server delete already succeeded). The fix defers the
// re-upload through the pending queue until the delete has been applied to
// `files`; these cases pin the real validation behaviour that fix depends on.
describe('validateFiles — KK20-227 re-index de-dupe (real validation path)', () => {
  const fileConfig: FileConfig | null = null;

  it('rejects the identical re-upload while the deleted file is still in files', () => {
    const setError = jest.fn();
    const files = new Map<string, ExtendedFile>([
      [
        'f1',
        makeExtendedFile({
          file_id: 'f1',
          filename: 'doc.pdf',
          size: 1024,
          type: 'application/pdf',
        }),
      ],
    ]);
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig: makeEndpointConfig(),
      fileConfig,
    });

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_error_files_dupe');
  });

  it('accepts the identical re-upload once the deleted file is removed from files', () => {
    const setError = jest.fn();
    const files = new Map<string, ExtendedFile>(); // delete already applied
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig: makeEndpointConfig(),
      fileConfig,
    });

    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });
});
// End [knauf]
