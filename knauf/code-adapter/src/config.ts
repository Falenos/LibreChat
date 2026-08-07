/**
 * Env parsing into one frozen typed Config. Fail-fast on boot with a
 * one-line-per-missing-var report (except LOCAL_MODE, which relaxes the
 * auth + Azure requirements for local development).
 */

export interface Config {
  port: number;
  logLevel: string;
  localMode: boolean;

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
  };

  uploadMaxBytes: number;

  mongo: {
    uri: string;
    db: string | null;
    filesCollection: string;
  };

  blob: {
    connectionString: string;
    container: string;
  };

  fileTtlHours: number;
  metricsEnabled: boolean;
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
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

  const config: Config = {
    port: int('PORT', 8080),
    logLevel: str('LOG_LEVEL') ?? 'info',
    localMode,
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
    },
    uploadMaxBytes: int('UPLOAD_MAX_BYTES', 134_217_728),
    mongo: {
      uri: required('MONGO_URI'),
      db: str('MONGO_DB'),
      filesCollection: str('MONGO_FILES_COLLECTION') ?? 'code_adapter_files',
    },
    blob: {
      connectionString: required('AZURE_STORAGE_CONNECTION_STRING'),
      container: str('BLOB_CONTAINER') ?? 'code-adapter-staging',
    },
    fileTtlHours: int('FILE_TTL_HOURS', 24),
    metricsEnabled: bool('METRICS_ENABLED', true),
  };

  if (missing.length > 0) {
    throw new Error(
      `code-adapter configuration is incomplete:\n${missing.map((m) => `  - ${m} is required`).join('\n')}`,
    );
  }

  return Object.freeze(config);
}
