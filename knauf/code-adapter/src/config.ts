/**
 * Env parsing into one frozen typed Config. Fail-fast on boot with a
 * one-line-per-missing-var report (except LOCAL_MODE, which relaxes the
 * auth + Azure requirements for local development).
 */

export interface Config {
  port: number;
  logLevel: string;
  localMode: boolean;
  /**
   * HMAC key behind two things: the owner tag every session id carries, and the derivation
   * of a session id from `runtime_session_hint` (both in validate.ts).
   *
   * It must be stable per deployment. Its *secrecy* matters only for the second use —
   * ownership checks compare a supplied id against the caller's own tag, so they hold even
   * if this value is public. Defaulting to the JWT public key is therefore sound today, and
   * needs no new provisioning; `SESSION_HINT_SECRET` overrides it, and must be set to a real
   * secret before `toolExecution.sandbox.statefulSessions` is ever enabled, or a known
   * conversation id yields a predictable session id. index.ts warns when it is unset.
   */
  sessionHintSecret: string;

  jwt: {
    publicKeyPem: string | null;
    allowedAlgs: string[];
    issuer: string;
    audience: string;
    kid: string | null;
    clockToleranceS: number;
    maxAgeS: number;
  };

  aca: {
    // One pool for everything: the built-in code-interpreter (PythonLTS) pool,
    // which has bash + python3 + the data-science stack. Both lang=py and
    // lang=bash route here (see exec/wrapper.ts). KK20-108, verified Aug 2026.
    poolEndpoint: string;
    apiVersion: string;
    tokenScope: string;
    tokenRefreshSkewS: number;
    execTimeoutMs: number;
    fileOpTimeoutMs: number;
  };

  exec: {
    wrapper: 'full' | 'off';
    codeMaxBytes: number;
    stdoutMaxBytes: number;
    stderrMaxBytes: number;
    captureMaxFiles: number;
    captureMaxTotalBytes: number;
    /**
     * Wall-clock ceiling on the whole post-exec capture phase.
     *
     * The file and byte caps do not bound time: `captureMaxFiles` (20) fetches run
     * sequentially, each with its own `fileOpTimeoutMs` (30s), so capture alone could
     * run 10 minutes on top of a 230s execution. Node's own `server.requestTimeout`
     * would then cut the response at 300s, losing files that were already persisted.
     * Stopping early and saying so beats delivering nothing.
     */
    captureMaxTotalMs: number;
  };

  uploadMaxBytes: number;

  mongo: {
    uri: string;
    db: string | null;
    filesCollection: string;
  };

  blob: {
    /**
     * Connection string auth. Legacy path, and a credential-scope problem: the value in
     * `agentic-karl-BLOB-STORAGE-CONNECTION-STRING` is the storage account's **primary key**
     * (`module.storage_blob_dev.storage_primary_connection_string` in agk-infrastructure), so
     * it grants this pod full control of every container on the account, including the app's
     * own `files`. Prefer `accountUrl` + workload identity, which can be scoped to one
     * container by role assignment. Null when `accountUrl` is used instead.
     */
    connectionString: string | null;
    /**
     * Workload-identity auth: `https://<account>.blob.core.windows.net`. Uses the same
     * `DefaultAzureCredential` the pod already federates with for ACA, so no new credential
     * is introduced — and the pod's access becomes exactly the role assignments it holds.
     */
    accountUrl: string | null;
    container: string;
  };

  fileTtlHours: number;
  /** How often the orphaned-blob reaper sweeps. See store/reaper.ts. */
  reaperIntervalMs: number;
  metricsEnabled: boolean;
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

/**
 * The Blob endpoint for workload-identity auth, from either an explicit URL or an account
 * name. Accepting the name is the ergonomic half: a values file should not have to spell out
 * `https://<account>.blob.core.windows.net` when the account name is the only variable.
 */
function resolveBlobAccountUrl(str: (name: string) => string | null): string | null {
  const explicit = str('AZURE_STORAGE_ACCOUNT_URL');
  if (explicit != null) {
    // Trimmed with a loop rather than /\/+$/ — the quantifier makes that regex backtrack.
    let url = explicit;
    while (url.endsWith('/')) {
      url = url.slice(0, -1);
    }
    return url;
  }
  const account = str('AZURE_STORAGE_ACCOUNT_NAME');
  return account != null ? `https://${account}.blob.core.windows.net` : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const str = (name: string): string | null => {
    const v = env[name];
    return v != null && v.trim() !== '' ? v.trim() : null;
  };
  const int = (name: string, fallback: number): number => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const v = str(name);
    if (v == null) {
      return fallback;
    }
    return v === 'true' || v === '1' || v.toLowerCase() === 'yes';
  };
  const resolvePublicKey = (): string | null => {
    const inline = str('CODEAPI_JWT_PUBLIC_KEY');
    if (inline) {
      return normalizePem(inline);
    }
    const b64 = str('CODEAPI_JWT_PUBLIC_KEY_BASE64');
    if (b64) {
      return normalizePem(Buffer.from(b64, 'base64').toString('utf8'));
    }
    return null;
  };

  const localMode = bool('CODE_ADAPTER_LOCAL_MODE', false);
  if (localMode && env.NODE_ENV === 'production') {
    throw new Error('CODE_ADAPTER_LOCAL_MODE=true is not allowed with NODE_ENV=production');
  }

  const missing: string[] = [];
  const required = (name: string): string => {
    const v = str(name);
    if (v == null) {
      missing.push(name);
      return '';
    }
    return v;
  };

  const publicKeyPem = resolvePublicKey();
  if (!localMode && publicKeyPem == null) {
    missing.push('CODEAPI_JWT_PUBLIC_KEY (or CODEAPI_JWT_PUBLIC_KEY_BASE64)');
  }

  // Blob auth is one-of, not both-optional: without either the store cannot be constructed,
  // and silently starting with no staging store would fail at first upload instead of at boot.
  const blobAccountUrl = resolveBlobAccountUrl(str);
  if (str('AZURE_STORAGE_CONNECTION_STRING') == null && blobAccountUrl == null) {
    missing.push(
      'AZURE_STORAGE_ACCOUNT_NAME (or AZURE_STORAGE_ACCOUNT_URL) for workload-identity Blob ' +
        'auth, or AZURE_STORAGE_CONNECTION_STRING for key auth',
    );
  }

  const config: Config = {
    port: int('PORT', 8080),
    logLevel: str('LOG_LEVEL') ?? 'info',
    localMode,
    sessionHintSecret: str('SESSION_HINT_SECRET') ?? publicKeyPem ?? 'knauf-code-adapter-local',
    jwt: {
      publicKeyPem,
      allowedAlgs: (str('CODEAPI_JWT_ALLOWED_ALGS') ?? 'EdDSA').split(',').map((s) => s.trim()),
      issuer: str('CODEAPI_JWT_ISSUER') ?? 'librechat',
      audience: str('CODEAPI_JWT_AUDIENCE') ?? 'codeapi',
      kid: str('CODEAPI_JWT_KID'),
      clockToleranceS: int('CODEAPI_JWT_CLOCK_TOLERANCE_S', 5),
      maxAgeS: int('CODEAPI_JWT_MAX_AGE_S', 300),
    },
    aca: {
      poolEndpoint: required('ACA_POOL_ENDPOINT').replace(/\/+$/, ''),
      apiVersion: str('ACA_API_VERSION') ?? '2024-02-02-preview',
      tokenScope: str('ACA_TOKEN_SCOPE') ?? 'https://dynamicsessions.io/.default',
      tokenRefreshSkewS: int('ACA_TOKEN_REFRESH_SKEW_S', 300),
      execTimeoutMs: int('ACA_EXEC_TIMEOUT_MS', 230_000),
      fileOpTimeoutMs: int('ACA_FILE_OP_TIMEOUT_MS', 30_000),
    },
    exec: {
      wrapper: str('EXEC_WRAPPER') === 'off' ? 'off' : 'full',
      codeMaxBytes: int('CODE_MAX_BYTES', 262_144),
      stdoutMaxBytes: int('STDOUT_MAX_BYTES', 65_536),
      stderrMaxBytes: int('STDERR_MAX_BYTES', 65_536),
      captureMaxFiles: int('CAPTURE_MAX_FILES', 20),
      captureMaxTotalBytes: int('CAPTURE_MAX_TOTAL_BYTES', 268_435_456),
      // Sized against the response budget, not against the file caps: execTimeoutMs
      // (230s) + this must stay comfortably under `server.requestTimeout` (index.ts).
      captureMaxTotalMs: int('CAPTURE_MAX_TOTAL_MS', 60_000),
    },
    uploadMaxBytes: int('UPLOAD_MAX_BYTES', 134_217_728),
    mongo: {
      uri: required('MONGO_URI'),
      db: str('MONGO_DB'),
      filesCollection: str('MONGO_FILES_COLLECTION') ?? 'code_adapter_files',
    },
    blob: {
      connectionString: str('AZURE_STORAGE_CONNECTION_STRING'),
      accountUrl: blobAccountUrl,
      container: str('BLOB_CONTAINER') ?? 'code-adapter-staging',
    },
    fileTtlHours: int('FILE_TTL_HOURS', 24),
    // Hourly is ample: the reaper only deletes what is already past the TTL, so the sweep
    // interval sets how long an orphan lingers, not whether it is collected.
    reaperIntervalMs: int('REAPER_INTERVAL_MS', 3_600_000),
    metricsEnabled: bool('METRICS_ENABLED', true),
  };

  if (missing.length > 0) {
    throw new Error(
      `code-adapter configuration is incomplete:\n${missing.map((m) => `  - ${m} is required`).join('\n')}`,
    );
  }

  return Object.freeze(config);
}
