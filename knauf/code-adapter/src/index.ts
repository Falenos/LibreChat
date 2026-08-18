import { DefaultAzureCredential } from '@azure/identity';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { importCodeApiKey } from './auth/verifyJwt.js';
import { FilesRepo } from './store/filesRepo.js';
import { checkTableReadiness, createTableStore } from './store/tableStore.js';
import { createBlobStore } from './azure/blobStore.js';
import { createTokenProvider } from './azure/credential.js';
import { createAcaClient } from './azure/acaClient.js';
import { createMetrics } from './middleware/metrics.js';
import { createReaper } from './store/reaper.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // Fail fast on an unusable verification key, before the port opens. `loadConfig` only
  // checks that CODEAPI_JWT_PUBLIC_KEY is *present*; parsing is what catches an
  // unsubstituted placeholder or a PEM mangled by YAML block-scalar indentation. Left to
  // the middleware's lazy import, either of those produces a pod that passes /readyz and
  // then 401s every request with a bare `unauthorized`. Skipped in LOCAL_MODE, which has
  // no key by design (config refuses LOCAL_MODE under NODE_ENV=production).
  if (!config.localMode) {
    await importCodeApiKey(config);
  }

  // Session ids carry an owner tag derived from this secret, and ownership holds even if
  // the secret is public (the check is against the caller's own identity — see
  // validate.ts). What a weak secret does expose is *prediction* of a hint-derived id from
  // a known conversation id, which only matters once the host enables
  // `toolExecution.sandbox.statefulSessions`. KARL does not, so this is a warning rather
  // than a boot failure — but it must be fixed before continuity is switched on.
  if (!config.localMode && process.env.SESSION_HINT_SECRET == null) {
    logger.warn(
      'SESSION_HINT_SECRET is unset — falling back to the JWT public key, which is not ' +
        'secret. Harmless while session continuity is off, but set a real secret before ' +
        'enabling toolExecution.sandbox.statefulSessions.',
    );
  }

  // One process-wide credential serves Table, Blob, and ACA through workload identity.
  const credential = new DefaultAzureCredential();
  const metrics = createMetrics();
  metrics.metadataBackendInfo.set({ backend: 'table', table: config.table.tableName }, 1);
  const table = createTableStore(config, credential, metrics);
  await checkTableReadiness(table, metrics);
  const repo = new FilesRepo(table, config.fileTtlHours, metrics);
  const blob = await createBlobStore(config, credential);
  const tokens = createTokenProvider(config, logger, credential);
  const aca = createAcaClient(config, logger, tokens, metrics);

  // Blob-led cleanup and bounded metadata reconciliation share a renewable Table lease,
  // so only one replica mutates retention state at a time.
  const reaper = createReaper({
    blob,
    repo,
    logger,
    ttlHours: config.fileTtlHours,
    intervalMs: config.reaperIntervalMs,
    leaseMs: config.reaperLeaseMs,
    reconciliationIntervalMs: config.reconciliationIntervalMs,
    reconciliationPageSize: config.reconciliationPageSize,
    reconciliationMaxPages: config.reconciliationMaxPages,
    reconciliationMaxMs: config.reconciliationMaxMs,
    metrics,
  });
  reaper.start();

  const app = createApp({
    config,
    logger,
    aca,
    blob,
    repo,
    metadataReadiness: () => checkTableReadiness(table, metrics),
    metrics,
  });

  // An /exec response legitimately takes execTimeoutMs (230s) plus the baseline listing
  // and the capture phase. Node's default requestTimeout is 300s, which lands inside that
  // window: it would abort the response after the files were already persisted, so the
  // caller sees a socket error and the model never hears about work that did happen.
  // Sized from the same numbers rather than a round guess, so the three move together.
  const requestBudgetMs =
    config.aca.execTimeoutMs + config.aca.fileOpTimeoutMs + config.exec.captureMaxTotalMs + 30_000;

  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        localMode: config.localMode,
        apiVersion: config.aca.apiVersion,
        metadataBackend: 'table',
        tableName: config.table.tableName,
      },
      'code-adapter listening',
    );
  });
  server.requestTimeout = requestBudgetMs;
  // Must exceed requestTimeout, or a slow-but-legal request is cut by the keep-alive
  // reaper instead. `headersTimeout` bounds only the header phase, so it stays short.
  server.keepAliveTimeout = requestBudgetMs + 5_000;

  /**
   * Drain rather than kill. An execution runs for up to `requestBudgetMs`, so the old
   * flat 10s force-exit terminated every in-flight run on any rollout — and it silently
   * overrode the Pod's own `terminationGracePeriodSeconds`, making that value a lie.
   *
   * `server.close()` stops accepting new connections and fires once the in-flight ones
   * finish; `closeIdleConnections()` is what actually lets that happen promptly, since a
   * keep-alive socket sitting idle would otherwise hold the server open for the full
   * budget. The force-exit is the backstop for a genuinely wedged request, and is now
   * derived from the request budget so the two cannot drift apart.
   *
   * NOTE for the GitOps side: `terminationGracePeriodSeconds` must be >= this bound, or
   * the kubelet SIGKILLs mid-drain and the drain is decorative. See
   * knauf/docs/code-execution/scaling.md.
   */
  const drainBudgetMs = requestBudgetMs + 10_000;
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const reaperStopped = reaper.stop();
    logger.info({ signal, drainBudgetMs }, 'shutting down — draining in-flight executions');
    server.close(() => {
      logger.info('drain complete');
      void reaperStopped.finally(() => process.exit(0));
    });
    server.closeIdleConnections();
    setTimeout(() => {
      logger.error({ drainBudgetMs }, 'drain budget exhausted — forcing exit');
      process.exit(1);
    }, drainBudgetMs).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: Error) => {
  // config fail-fast lands here before any logger exists
  console.error(`code-adapter failed to start: ${err.message}`);
  process.exit(1);
});
