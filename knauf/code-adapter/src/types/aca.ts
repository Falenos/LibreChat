/**
 * Azure Container Apps dynamic sessions data-plane types.
 *
 * Pinned by the KK20-108 spike against live West Europe pools (Aug 2026);
 * raw fixtures in test/fixtures/aca/. KARL runs everything on ONE pool — the
 * built-in **code-interpreter (PythonLTS)** pool, which has bash + python3 +
 * the data-science stack. Both `lang=py` and `lang=bash` submit a Python
 * wrapper (see exec/wrapper.ts) to:
 *
 *   POST {pool}/code/execute?api-version=2024-02-02-preview
 *     body { properties: { codeInputType, executionType, code } }
 *     resp { properties: { status: "Success"|"Failure", stdout, stderr, ... } }
 *
 * The pool runs an IPython kernel, so the wrapper always runs the user's code
 * as a subprocess to recover the real exit code (and to run bash on the pool).
 */

/** Code-interpreter execution response (wrapped in `properties`). */
export interface AcaExecutionResponse {
  properties?: {
    status?: string; // "Success" | "Failure"
    stdout?: string;
    stderr?: string;
    result?: unknown;
    executionTimeInMilliseconds?: number;
  };
}

export interface AcaSessionFile {
  name: string;
  /** e.g. 'File' | 'Directory' */
  type?: string | undefined;
  contentType?: string | null | undefined;
  sizeInBytes?: number | undefined;
  lastModifiedAt?: string | undefined;
}

export const ACA_FILE_MANIFEST_NAME = '.karl_files.json';
export const ACA_FILE_MANIFEST_TRUNCATED_NAME = '.karl_manifest_truncated';

export interface AcaFileManifest {
  version: 1;
  truncated: boolean;
  files: AcaSessionFile[];
}

/** Python pool file entries arrive wrapped: { value: [ { properties: {...} } ] }. */
export interface AcaFileListResponse {
  value: { properties?: AcaFileProperties }[];
}

export interface AcaFileProperties {
  filename?: string;
  size?: number;
  lastModifiedTime?: string;
  contentType?: string | null;
}

/** Normalized execution outcome produced by the ACA client. */
export interface AcaExecOutcome {
  /** Pool-level status: true iff properties.status === "Success". Used only for
   *  the sentinel-missing fallback; the real exit code comes from the wrapper. */
  succeeded: boolean;
  stdout: string;
  stderr: string;
  executionMs?: number | undefined;
  raw: AcaExecutionResponse;
}

export class AcaError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly acaCode?: string | undefined,
    public readonly retryAfterSeconds?: number | undefined,
  ) {
    super(message);
    this.name = 'AcaError';
  }
}

export class AcaSessionNotFoundError extends AcaError {
  constructor(message = 'SessionWithIdentifierNotFound') {
    super(message, 404, 'SessionWithIdentifierNotFound');
    this.name = 'AcaSessionNotFoundError';
  }
}

export class AcaTimeoutError extends AcaError {
  constructor(message = 'Execution timed out') {
    super(message, 408, 'ExecutionTimeout');
    this.name = 'AcaTimeoutError';
  }
}
