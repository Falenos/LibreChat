/**
 * Azure Container Apps dynamic sessions data-plane types.
 *
 * Pinned by the KK20-108 spike against live West Europe pools (Aug 2026);
 * raw fixtures in test/fixtures/aca/. The two built-in pool types are two
 * distinct contracts:
 *
 *   Python (lang=py): POST {pool}/code/execute?api-version=2024-02-02-preview
 *     body { properties: { codeInputType, executionType, code } }
 *     resp { properties: { status: "Success"|"Failure", stdout, stderr, ... } }
 *     — runs in an IPython kernel; sys.exit() is swallowed, so a real exit
 *       code requires the subprocess sentinel wrapper.
 *
 *   Shell (lang=bash): POST {pool}/executions?api-version=2025-02-02-preview
 *     body { shellCommand }                              (top-level, NOT nested)
 *     resp { status: "<numeric exit code>", result: { stdout, stderr, ... } }
 *     — real exit code native in `status`.
 */

/** Which built-in pool / dialect an execution targets. */
export type PoolKind = 'py' | 'bash';

/** Python code-interpreter response (wrapped in `properties`). */
export interface AcaPyResponse {
  properties?: {
    status?: string; // "Success" | "Failure"
    stdout?: string;
    stderr?: string;
    result?: unknown;
    executionTimeInMilliseconds?: number;
  };
}

/** Shell response (flat; `status` is the numeric exit code as a string). */
export interface AcaShellResponse {
  identifier?: string;
  status?: string; // e.g. "0", "7"
  result?: {
    stdout?: string;
    stderr?: string;
    executionTimeInMilliseconds?: number;
  };
}

export type AcaExecutionResponse = AcaPyResponse | AcaShellResponse;

export interface AcaSessionFile {
  name: string;
  /** e.g. 'File' | 'Directory' */
  type?: string | undefined;
  contentType?: string | null | undefined;
  sizeInBytes?: number | undefined;
  lastModifiedAt?: string | undefined;
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

/**
 * Normalized execution outcome produced by the ACA client, hiding the
 * per-pool response differences from the exec service.
 */
export interface AcaExecOutcome {
  succeeded: boolean;
  stdout: string;
  stderr: string;
  /** Native exit code when the pool provides one (Shell); undefined for Python. */
  nativeExitCode?: number | undefined;
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
