/**
 * [knauf] KK20-397 — let the model look at page and slide renders it made in the sandbox.
 *
 * WHY THIS EXISTS
 * The Office/PDF skills check their output the way a person would: render pages or slides
 * to images and look for overflowing text, overlaps and poor contrast, then fix and
 * re-render. Upstream `read_file` refuses every raster path in the sandbox
 * (`BINARY_EXTENSIONS_NEVER_READABLE`, agents/handlers.ts) — the sandbox read is a `cat`
 * over a JSON stdout transport that mangles binary — and code-output images never reach
 * the model any other way. So the render step existed and the look step could not.
 *
 * HOW
 * A raster file the current run produced is already a staged, `kind: 'user'` object in
 * `tc.codeSessionContext.files`. This fetches its bytes binary-safely from the code
 * adapter's `/download` route (the same route `processCodeOutput` uses, owner-checked by the
 * adapter), verifies the magic bytes, and returns the skill-image shape — an `image_url`
 * content artifact, which @librechat/agents hands to the model once, on the next call.
 * `knauf_model_only` tells the tool-end callback not to save it again as a visible
 * attachment. Renders under `/mnt/data/_karl_qa/` are never attachments in the first place
 * (api/server/services/Files/knauf/codeOutputPolicy.js).
 *
 * GATES
 * `KNAUF_CODE_VISUAL_QA_ENABLED=true` (default off: images added mid-run bypass the KK20-199
 * Langfuse image guard, so enabling it in stage/prod needs privacy sign-off), code execution
 * available for the run, an authenticated user, at most `KNAUF_CODE_VISUAL_QA_MAX_IMAGES`
 * (8) images per request and 4 MiB per image. Returns null — "carry on with upstream
 * read_file" — for everything it does not handle.
 */
import axios from 'axios';
import { getCodeBaseURL } from '@librechat/agents';
import type { ToolCallRequest, ToolExecuteResult } from '@librechat/agents';
import type { ServerRequest } from '~/types';
import { codeServerHttpAgent, codeServerHttpsAgent } from '~/utils/code';
import { buildCodeEnvDownloadQuery } from '~/files/code/identity';
import { getCodeApiAuthHeaders } from '~/auth/codeapi';

export const KNAUF_VISUAL_QA_PREFIX = '_karl_qa/';
export const KNAUF_VISUAL_QA_MAX_BYTES: number = 4 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 8;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

type RasterMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export function isKnaufVisualQaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KNAUF_CODE_VISUAL_QA_ENABLED === 'true';
}

function maxImagesPerRequest(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.KNAUF_CODE_VISUAL_QA_MAX_IMAGES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_IMAGES;
}

/**
 * `/mnt/data/a/b.png`, `./a/b.png` and `a/b.png` → `a/b.png`; null for anything that is
 * not a plain relative path inside /mnt/data (absolute elsewhere, traversal, NUL, `\`).
 */
export function toSandboxRelativePath(filePath: string): string | null {
  if (filePath.includes('\0') || filePath.includes('\\')) {
    return null;
  }
  let rel = filePath.startsWith('/mnt/data/') ? filePath.slice('/mnt/data/'.length) : filePath;
  while (rel.startsWith('./')) {
    rel = rel.slice(2);
  }
  if (rel === '' || rel.startsWith('/')) {
    return null;
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return null;
  }
  return rel;
}

export function sniffRasterMime(buffer: Buffer): RasterMime | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('latin1', 0, 6))) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('latin1', 0, 4) === 'RIFF' &&
    buffer.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function isKnaufModelOnlyArtifact(artifact: unknown): boolean {
  return (
    typeof artifact === 'object' &&
    artifact != null &&
    (artifact as { knauf_model_only?: unknown }).knauf_model_only === true
  );
}

type SessionFileRef = {
  id?: string;
  name?: string;
  storage_session_id?: string;
  session_id?: string;
  kind?: string;
};

export type StagedDownload = (params: {
  req: ServerRequest;
  ref: { id: string; storage_session_id: string };
  maxBytes: number;
}) => Promise<Buffer>;

/** Binary-safe fetch of a staged `kind: 'user'` object from the code adapter. */
export const downloadStagedCodeFile: StagedDownload = async ({ req, ref, maxBytes }) => {
  const query = buildCodeEnvDownloadQuery({ kind: 'user', id: req.user?.id ?? '' });
  const response = await axios({
    method: 'get',
    url: `${getCodeBaseURL()}/download/${ref.storage_session_id}/${ref.id}${query}`,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'LibreChat/1.0', ...(await getCodeApiAuthHeaders(req)) },
    httpAgent: codeServerHttpAgent,
    httpsAgent: codeServerHttpsAgent,
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxContentLength: maxBytes,
    maxRedirects: 0,
  });
  return Buffer.from(response.data as ArrayBuffer);
};

/** Images served per request — keyed on the request object so the cap is per response. */
const served = new WeakMap<object, number>();

function errorResult(tc: ToolCallRequest, message: string): ToolExecuteResult {
  return { toolCallId: tc.id, status: 'error', content: '', errorMessage: message };
}

/** The sandbox-relative path of a raster image `read_file` may show, or null to defer. */
function inspectableRasterPath(
  path: string,
  mergedConfigurable?: Record<string, unknown>,
): string | null {
  if (path.startsWith('skills/') || mergedConfigurable?.codeEnvAvailable !== true) {
    return null;
  }
  const rel = toSandboxRelativePath(path);
  if (rel == null) {
    return null;
  }
  return RASTER_EXTENSIONS.has(rel.slice(rel.lastIndexOf('.')).toLowerCase()) ? rel : null;
}

/** The user's staged copy of `rel` in this response's code session; the newest render wins. */
function findStagedFile(
  tc: ToolCallRequest,
  rel: string,
): { id: string; storage_session_id: string } | null {
  const files = ((tc.codeSessionContext as { files?: SessionFileRef[] } | undefined)?.files ??
    []) as SessionFileRef[];
  let ref: { id: string; storage_session_id: string } | null = null;
  for (const file of files) {
    const storage = file.storage_session_id ?? file.session_id;
    if (file.kind === 'user' && file.name === rel && file.id && storage) {
      ref = { id: file.id, storage_session_id: storage };
    }
  }
  return ref;
}

/** The model-only image result: the text says what it is, the artifact carries the pixels. */
function imageResult(
  tc: ToolCallRequest,
  rel: string,
  buffer: Buffer,
  mime: string,
): ToolExecuteResult {
  return {
    toolCallId: tc.id,
    status: 'success',
    content:
      `Image: /mnt/data/${rel} (${buffer.length} bytes, ${mime}). It is shown to you once, for ` +
      'this step only — note every defect you see now. If no image is visible to you, visual ' +
      'inspection is unavailable here; use the text checks instead.',
    artifact: {
      knauf_model_only: true,
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${buffer.toString('base64')}`, detail: 'high' },
        },
      ],
    },
  };
}

export async function readKnaufSandboxImage(params: {
  tc: ToolCallRequest;
  path: string;
  mergedConfigurable?: Record<string, unknown>;
  req?: ServerRequest;
  env?: NodeJS.ProcessEnv;
  download?: StagedDownload;
}): Promise<ToolExecuteResult | null> {
  const { tc, req } = params;
  const env = params.env ?? process.env;
  const rel = inspectableRasterPath(params.path, params.mergedConfigurable);
  if (rel == null) {
    return null;
  }
  const isQaRender = rel.startsWith(KNAUF_VISUAL_QA_PREFIX);
  if (!isKnaufVisualQaEnabled(env) || req?.user?.id == null) {
    // For an ordinary image upstream's "already attached" message is accurate. For a QA
    // render it is not — those are never attached — so say what is actually true.
    return isQaRender
      ? errorResult(
          tc,
          'Visual inspection of renders is not enabled in this environment. Use the text ' +
            'checks (text dump, page/slide count, layout lint) instead.',
        )
      : null;
  }

  const ref = findStagedFile(tc, rel);
  if (ref == null) {
    return isQaRender
      ? errorResult(
          tc,
          `No render named /mnt/data/${rel} was produced in this response. Re-run the render ` +
            'step and read the exact paths it prints.',
        )
      : null;
  }

  const max = maxImagesPerRequest(env);
  const used = served.get(req) ?? 0;
  if (used >= max) {
    return errorResult(
      tc,
      `Visual inspection limit reached (${max} images per response). Act on what you have ` +
        'already seen, or use the text checks.',
    );
  }
  // Reserved synchronously: parallel read_file calls in one batch must not all pass.
  served.set(req, used + 1);
  const release = () => served.set(req, (served.get(req) ?? 1) - 1);

  let buffer: Buffer;
  try {
    buffer = await (params.download ?? downloadStagedCodeFile)({
      req,
      ref,
      maxBytes: KNAUF_VISUAL_QA_MAX_BYTES,
    });
  } catch {
    release();
    return errorResult(
      tc,
      `Could not fetch /mnt/data/${rel} for inspection (larger than 4 MiB, expired, or the ` +
        'sandbox store is unavailable). Render it smaller, or use the text checks.',
    );
  }
  const mime = sniffRasterMime(buffer);
  if (mime == null || buffer.length > KNAUF_VISUAL_QA_MAX_BYTES) {
    release();
    return errorResult(tc, `/mnt/data/${rel} is not a PNG, JPEG, GIF or WebP image under 4 MiB.`);
  }
  return imageResult(tc, rel, buffer, mime);
}
