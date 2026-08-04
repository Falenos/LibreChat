/**
 * Azure Container Apps dynamic sessions data-plane types.
 *
 * PROVISIONAL until the S5 spike pins real response fixtures
 * (test/fixtures/aca/); the parser in exec/execService.ts is written
 * tolerantly against these shapes. Data-plane api-version is pinned via
 * ACA_API_VERSION. Shapes based on Microsoft Learn "sessions-usage"
 * (July 2026) + the LangChain azure_dynamic_sessions client.
 */

export interface AcaExecutionRequest {
  properties: {
    codeInputType: 'inline';
    executionType: 'synchronous';
    code: string;
  };
}

/**
 * Known observed shapes (the API changed once already):
 *  - 2024 preview: { properties: { status, stdout, stderr, result, executionTimeInMilliseconds } }
 *  - 2025 preview: { id, status, result: { stdout, stderr, executionResult, executionTimeInMilliseconds } }
 * The parser accepts both; S5 fixtures decide which one the pinned
 * api-version actually returns.
 */
export interface AcaExecutionResponse {
  id?: string;
  status?: string;
  properties?: {
    status?: string;
    stdout?: string;
    stderr?: string;
    result?: unknown;
    executionTimeInMilliseconds?: number;
  };
  result?: {
    stdout?: string;
    stderr?: string;
    executionResult?: unknown;
    executionTimeInMilliseconds?: number;
  };
}

export interface AcaSessionFile {
  name: string;
  /** e.g. 'File' | 'Directory' */
  type?: string;
  contentType?: string | null;
  sizeInBytes?: number;
  lastModifiedAt?: string;
}

export interface AcaFileListResponse {
  value: AcaSessionFile[];
}

/** Normalized execution outcome produced by the ACA client. */
export interface AcaExecOutcome {
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
