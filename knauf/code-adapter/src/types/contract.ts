/**
 * LibreChat Code API contract types — the shapes this adapter must serve.
 *
 * Mirrors the verified callers in the KARL fork:
 * - @librechat/agents CodeExecutor / BashExecutor  → POST /exec
 * - api/server/services/Files/Code/crud.js         → /upload, /upload/batch, /download, DELETE
 * - api/server/services/Files/Code/process.js      → /download (arraybuffer), GET /sessions/:sid/objects/:fid,
 *                                                     readSandboxFile / writeSandboxFile via /exec
 * - packages/api/src/files/code/identity.ts        → kind/id/version identity protocol
 */

export const CODE_ENV_KINDS = ['skill', 'agent', 'user'] as const;
export type CodeEnvKind = (typeof CODE_ENV_KINDS)[number];

export interface CodeEnvIdentity {
  kind: CodeEnvKind;
  id: string;
  /** Required when kind === 'skill'; forbidden otherwise. */
  version?: number | undefined;
}

/** Injected file ref as sent by ToolNode / primeCodeFiles in the /exec body. */
export interface ExecFileRef {
  id: string;
  name: string;
  /** Upload-time storage session the file lives under (may differ from exec session). */
  session_id?: string | undefined;
  storage_session_id?: string | undefined;
  resource_id?: string | undefined;
  kind?: CodeEnvKind | undefined;
  version?: number | undefined;
  read_only?: boolean | undefined;
}

export interface ExecRequest {
  lang: string;
  code: string;
  args?: string[] | undefined;
  files?: ExecFileRef[] | undefined;
  session_id?: string | undefined;
  user_id?: string | undefined;
  entity_id?: string | undefined;
  /**
   * Sandbox-continuity hint. `@librechat/agents` (3.2.65+) sends this — the conversation's
   * `thread_id`, or an explicit host override — but ONLY when the host sets
   * `toolExecution.sandbox.statefulSessions = true`. It never sends `session_id` in the
   * body, so this is the one wire field that can tie consecutive executions to one
   * sandbox. See `deriveSessionId`.
   */
  runtime_session_hint?: string | undefined;
}

export interface ExecResponseFile {
  id: string;
  name: string;
  path: string;
  /** Storage session serving /download for this file; callbacks.js reads it per file. */
  storage_session_id: string;
  /** true ⇒ LibreChat skips re-persisting this file (input echoed back unchanged). */
  inherited?: boolean;
}

export interface ExecResponse {
  session_id: string;
  stdout: string;
  stderr: string;
  /**
   * Numeric exit code; real rc via the sentinel wrapper, else 0/1 synthesized.
   *
   * Callers must not assume this is read: `@librechat/agents` (3.2.65 and 3.2.46) formats
   * only stdout/stderr and never inspects it, which is why a non-zero exit with no output
   * also gets an explanatory line written into `stderr`.
   */
  code: number;
  files: ExecResponseFile[];
  /**
   * Echoed only when the caller supplied `runtime_session_hint`. The client surfaces it on
   * the tool artifact for observability (it does not feed it back — the hint is derived
   * from `thread_id` each turn), so it exists to make continuity visible in traces.
   */
  runtime_session_id?: string;
}

/** crud.js hard-checks message === 'success' and reads files[0].fileId. */
export interface UploadResponse {
  message: 'success';
  storage_session_id: string;
  files: { fileId: string; filename: string }[];
}

export interface BatchUploadFileResult {
  status: 'success' | 'error';
  fileId?: string;
  filename: string;
  error?: string;
}

export interface BatchUploadResponse {
  message: 'success' | 'partial' | 'error';
  storage_session_id: string;
  files: BatchUploadFileResult[];
  succeeded: number;
  failed: number;
}

/** GET /sessions/:sid/objects/:fid — process.js reads lastModified for freshness. */
export interface SessionObjectInfo {
  id: string;
  name: string;
  session_id: string;
  size: number;
  contentType: string;
  lastModified: string;
}

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: string;
}
