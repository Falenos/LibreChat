const telemetry = require('./telemetry');
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const cors = require('cors');
const axios = require('axios');
const express = require('express');
const passport = require('passport');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  isEnabled,
  apiNotFound,
  createMetrics,
  ErrorController,
  memoryDiagnostics,
  performStartupChecks,
  handleJsonParseError,
  GenerationJobManager,
  QUERY_DEVTOOLS_HEADER,
  createStreamServices,
  initializeFileStorage,
  initializeDeploymentSkills,
  // [knauf] KK20-243 — see the call site below.
  verifyDeploymentSkills,
  // End [knauf]
  maybeInjectQueryDevtoolsBootstrap,
  preAuthTenantMiddleware,
  setupGracefulShutdown,
  updateInterfacePermissions,
} = require('@librechat/api');
const { connectDb, indexSync } = require('~/db');
const {
  updateAccessPermissions,
  sweepOrphanedPreviews,
  getRoleByName,
  seedDatabase,
} = require('~/models');
const initializeOAuthReconnectManager = require('./services/initializeOAuthReconnectManager');
const { capabilityContextMiddleware } = require('./middleware/roles/capabilities');
const createValidateImageRequest = require('./middleware/validateImageRequest');
const { startExpiredFileSweep } = require('./services/Files/process');
const { initializeGitHubSkillSync } = require('./services/Skills/sync');
const { jwtLogin, ldapLogin, passportLogin } = require('~/strategies');
const { checkMigrations } = require('./services/start/migration');
const optionalJwtAuth = require('./middleware/optionalJwtAuth');
const initializeMCPs = require('./services/initializeMCPs');
const configureSocialLogins = require('./socialLogins');
const createSpaFallback = require('./utils/fallback');
const { getAppConfig } = require('./services/Config');
const staticCache = require('./utils/staticCache');
const noIndex = require('./middleware/noIndex');
// [knauf] Migration access enforcement on protected API routes.
const requireJwtAuth = require('./middleware/requireJwtAuth');
const requireMigrationAccess = require('./middleware/requireMigrationAccess');
// End [knauf]
const routes = require('./routes');

const { PORT, HOST, ALLOW_SOCIAL_LOGIN, DISABLE_COMPRESSION, TRUST_PROXY } = process.env ?? {};

// Allow PORT=0 to be used for automatic free port assignment
const port = isNaN(Number(PORT)) ? 3080 : Number(PORT);
const host = HOST || 'localhost';
const trusted_proxy = Number(TRUST_PROXY) || 1; /* trust first proxy by default */

const app = express();
let serverReady = false;

const SERVER_NOT_READY_CODE = 'SERVER_NOT_READY';
const CHAT_START_RETRY_AFTER_SECONDS = '1';

const rejectChatStartsUntilReady = (req, res, next) => {
  if (serverReady || req.method !== 'POST' || req.path === '/abort') {
    return next();
  }

  res.set('Retry-After', CHAT_START_RETRY_AFTER_SECONDS);
  return res.status(503).json({
    code: SERVER_NOT_READY_CODE,
    error: 'Server is still starting. Please retry shortly.',
  });
};

const configureGenerationStreams = () => {
  const streamServices = createStreamServices();
  GenerationJobManager.configure({
    ...streamServices,
    cleanupOnComplete: !isEnabled(process.env.STREAM_KEEP_COMPLETED_JOBS),
  });
  GenerationJobManager.initialize();
};

const startServer = async () => {
  const { metricsMiddleware, metricsRouter } = createMetrics();
  if (!process.env.METRICS_SECRET) {
    logger.warn('[metrics] METRICS_SECRET is not set - /metrics will return 401 for all requests');
  }

  if (typeof Bun !== 'undefined') {
    axios.defaults.headers.common['Accept-Encoding'] = 'gzip';
  }
  await connectDb();

  logger.info('Connected to MongoDB');
  indexSync().catch((err) => {
    logger.error('[indexSync] Background sync failed:', err);
  });

  app.disable('x-powered-by');
  app.set('trust proxy', trusted_proxy);

  if (isEnabled(process.env.TENANT_ISOLATION_STRICT)) {
    logger.warn(
      '[Security] TENANT_ISOLATION_STRICT is active. Ensure your reverse proxy strips or sets ' +
        'the X-Tenant-Id header — untrusted clients must not be able to set it directly.',
    );
  }

  await runAsSystem(seedDatabase);
  /* Recover stuck `status: 'pending'` records from a crash mid-render.
   * `runAsSystem` is required — `File` is tenant-isolated and strict
   * mode rejects unscoped queries. Lazy sweep in the preview endpoint
   * covers anything younger than the boot cutoff. */
  runAsSystem(sweepOrphanedPreviews).catch((err) => {
    logger.error('[sweepOrphanedPreviews] Background sweep failed:', err);
  });
  const appConfig = await getAppConfig({ baseOnly: true });
  initializeFileStorage(appConfig);
  const deploymentSkillRegistry = await initializeDeploymentSkills({
    projectRoot: path.resolve(__dirname, '../..'),
  });
  // [knauf] KK20-243 — assert the skills baked into the image actually loaded.
  // `initializeDeploymentSkills` treats an empty directory as success and logs
  // the zero case at `debug`, so a volume mounted over /app/skill removes the
  // whole feature without a single visible line. Non-fatal on purpose: chat,
  // agents and file search are unaffected, so degraded-and-noisy beats a
  // crashloop. Wrapped because a diagnostic must never be the thing that stops
  // a boot.
  try {
    verifyDeploymentSkills({
      loadedNames: deploymentSkillRegistry.list().map((skill) => skill.name),
      directory: deploymentSkillRegistry.getDirectory(),
    });
  } catch (err) {
    logger.error('[knauf][deploymentSkills] Skill verification failed to run:', err);
  }
  // End [knauf]
  initializeGitHubSkillSync(appConfig);
  startExpiredFileSweep({ appConfig, loadAppConfig: getAppConfig });
  await runAsSystem(async () => {
    await performStartupChecks(appConfig);
    await updateInterfacePermissions({ appConfig, getRoleByName, updateAccessPermissions });
  });

  const indexPath = path.join(appConfig.paths.dist, 'index.html');
  let indexHTML = fs.readFileSync(indexPath, 'utf8');

  // In order to provide support to serving the application in a sub-directory
  // We need to update the base href if the DOMAIN_CLIENT is specified and not the root path
  if (process.env.DOMAIN_CLIENT) {
    const clientUrl = new URL(process.env.DOMAIN_CLIENT);
    const baseHref = clientUrl.pathname.endsWith('/')
      ? clientUrl.pathname
      : `${clientUrl.pathname}/`;
    if (baseHref !== '/') {
      logger.info(`Setting base href to ${baseHref}`);
      indexHTML = indexHTML.replace(/base href="\/"/, `base href="${baseHref}"`);
    }
  }

  const sendIndexHtml = (req, res) => {
    res.set({
      'Cache-Control': process.env.INDEX_CACHE_CONTROL || 'no-cache, no-store, must-revalidate',
      // [knauf] Prevent Chrome from prompting users for local-network access.
      'Permissions-Policy': 'local-network-access=()',
      // End [knauf]
      Pragma: process.env.INDEX_PRAGMA || 'no-cache',
      Expires: process.env.INDEX_EXPIRES || '0',
    });
    res.vary(QUERY_DEVTOOLS_HEADER);

    const lang = req.cookies.lang || req.headers['accept-language']?.split(',')[0] || 'en-US';
    const saneLang = lang.replace(/"/g, '&quot;');
    let updatedIndexHtml = indexHTML.replace(/lang="en-US"/g, `lang="${saneLang}"`);
    updatedIndexHtml = maybeInjectQueryDevtoolsBootstrap(updatedIndexHtml, req);

    res.type('html');
    res.send(updatedIndexHtml);
  };

  app.get('/health', (_req, res) => res.status(200).send('OK'));
  app.get('/livez', (_req, res) => res.status(200).send('OK'));
  app.get('/readyz', (_req, res) => {
    if (!serverReady) {
      return res.status(503).send('NOT_READY');
    }
    return res.status(200).send('OK');
  });

  /* Middleware */
  app.use(metricsMiddleware);
  app.use(noIndex);
  app.use(express.json({ limit: '3mb' }));
  app.use(express.urlencoded({ extended: true, limit: '3mb' }));
  app.use(handleJsonParseError);

  /**
   * Express 5 Compatibility: Make req.query writable for mongoSanitize
   * In Express 5, req.query is read-only by default, but express-mongo-sanitize needs to modify it
   */
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'query', {
      ...Object.getOwnPropertyDescriptor(req, 'query'),
      value: req.query,
      writable: true,
    });
    next();
  });

  app.use(mongoSanitize());
  app.use(cors());
  app.use(cookieParser());

  if (!isEnabled(DISABLE_COMPRESSION)) {
    app.use(compression());
  } else {
    console.warn('Response compression has been disabled via DISABLE_COMPRESSION.');
  }

  app.get('/index.html', sendIndexHtml);
  app.use(staticCache(appConfig.paths.dist));
  app.use(staticCache(appConfig.paths.fonts));
  app.use(staticCache(appConfig.paths.assets));

  if (telemetry.enabled) {
    app.use(telemetry.telemetryMiddleware);
  }

  if (!ALLOW_SOCIAL_LOGIN) {
    console.warn('Social logins are disabled. Set ALLOW_SOCIAL_LOGIN=true to enable them.');
  }

  /* OAUTH */
  app.use(passport.initialize());
  passport.use(jwtLogin());
  passport.use(passportLogin());

  /* LDAP Auth */
  if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
    passport.use(ldapLogin);
  }

  if (isEnabled(ALLOW_SOCIAL_LOGIN)) {
    await configureSocialLogins(app);
  }

  /* Per-request capability cache — must be registered before any route that calls hasCapability */
  app.use(capabilityContextMiddleware);

  /* Pre-auth tenant context for unauthenticated routes that need tenant scoping.
   * The reverse proxy / auth gateway sets `X-Tenant-Id` header for multi-tenant deployments. */
  app.use('/oauth', preAuthTenantMiddleware, routes.oauth);
  // [knauf] Migration access gate — when MIGRATION_ALLOWLIST_ENABLED=true, enforces
  // default-deny on all /api routes: every authenticated request must come from a user
  // on the migration allowlist.
  //
  // Disabled by default (MIGRATION_ALLOWLIST_ENABLED=false). Set to 'true' in production
  // to enforce the gate. When disabled, all requests pass through without allowlist checks.
  //
  // Exempt routes (must be reachable before a user is on the allowlist):
  //   /auth                    — Okta login/logout bootstrap
  //   /config                  — pre-login app config (endpoints, UI flags)
  //   /banner                  — public announcement banners
  //   /admin                   — admin panel manages the allowlist itself
  //   /user                    — AuthContext bootstrap: fetches user identity on load.
  //                              Without this, a 403 on /api/user causes LibreChat to
  //                              redirect to /login showing "account temporarily banned".
  //                              The visual gate is handled by useMigrationAccess in Root.tsx.
  //   /knauf/migration/access  — the access-check endpoint the frontend calls
  //   /knauf/migration/file-assets — API-key-protected operational backfill
  //   /knauf/artifact-export/render — one-time-secret snapshot for headless export
  //
  // Note: /api/share is intentionally NOT exempt. With ALLOW_SHARED_LINKS_PUBLIC=false
  // (our current setting) share links already required login before this gate existed.
  // This is a temporary rollout gate and will be removed post-migration.
  if (process.env.MIGRATION_ALLOWLIST_ENABLED === 'true') {
    const MIGRATION_GATE_EXEMPT = [
      '/auth',
      '/config',
      '/banner',
      '/admin',
      '/user',
      '/knauf/migration/access',
      '/knauf/migration/access/check',
      '/knauf/migration/file-assets',
      '/knauf/artifact-export/render',
    ];
    app.use('/api', (req, res, next) => {
      if (
        MIGRATION_GATE_EXEMPT.some(
          (prefix) => req.path === prefix || req.path.startsWith(prefix + '/'),
        )
      ) {
        return next();
      }
      return requireJwtAuth(req, res, () => requireMigrationAccess(req, res, next));
    });
  }
  // End [knauf]

  /* API Endpoints */
  app.use('/api/auth', preAuthTenantMiddleware, routes.auth);
  app.use('/api/admin', routes.adminAuth);
  app.use('/api/admin/config', routes.adminConfig);
  app.use('/api/admin/grants', routes.adminGrants);
  app.use('/api/admin/groups', routes.adminGroups);
  app.use('/api/admin/roles', routes.adminRoles);
  app.use('/api/admin/skills', routes.adminSkills);
  app.use('/api/admin/users', routes.adminUsers);
  app.use('/api/admin/audit-log', routes.adminAuditLog);
  app.use('/api/actions', routes.actions);
  app.use('/api/keys', routes.keys);
  app.use('/api/api-keys', routes.apiKeys);
  app.use('/api/user', routes.user);
  app.use('/api/search', routes.search);
  app.use('/api/messages', routes.messages);
  app.use('/api/convos', routes.convos);
  app.use('/api/presets', routes.presets);
  app.use('/api/projects', routes.projects);
  app.use('/api/prompts', routes.prompts);
  app.use('/api/skills', routes.skills);
  app.use('/api/categories', routes.categories);
  app.use('/api/endpoints', routes.endpoints);
  app.use('/api/balance', routes.balance);
  app.use('/api/models', routes.models);
  app.use('/api/config', preAuthTenantMiddleware, optionalJwtAuth, routes.config);
  app.use('/api/assistants', routes.assistants);
  app.use('/api/files', await routes.files.initialize());
  app.use('/images/', createValidateImageRequest(appConfig.secureImageLinks), routes.staticRoute);
  app.use('/api/share', preAuthTenantMiddleware, routes.share);
  app.use('/api/roles', routes.roles);
  app.use('/api/agents/chat', rejectChatStartsUntilReady);
  app.use('/api/agents', routes.agents);
  app.use('/api/banner', routes.banner);
  app.use('/api/memories', routes.memories);
  app.use('/api/permissions', routes.accessPermissions);

  app.use('/api/tags', routes.tags);
  app.use('/api/mcp', routes.mcp);
  app.use('/api/rum', routes.rum);

  // [knauf] mount-point — Knauf-only routes (additive, isolated under /api/knauf).
  app.use('/api/knauf', require('./routes/knauf'));
  // End [knauf]
  app.use('/metrics', metricsRouter);

  /** 404 for unmatched API routes */
  app.use('/api', apiNotFound);

  /** SPA fallback - serve index.html for all unmatched routes */
  app.use(createSpaFallback(sendIndexHtml));

  /** Record trace errors before the final error controller. */
  if (telemetry.enabled) {
    app.use(telemetry.telemetryErrorMiddleware);
  }
  /** Error handler (must be last - Express identifies error middleware by its 4-arg signature) */
  app.use(ErrorController);

  configureGenerationStreams();

  const server = app.listen(port, host, async (err) => {
    if (err) {
      logger.error('Failed to start server:', err);
      process.exit(1);
    }

    if (host === '0.0.0.0') {
      logger.info(
        `Server listening on all interfaces at port ${port}. Use http://localhost:${port} to access it`,
      );
    } else {
      logger.info(`Server listening at http://${host == '0.0.0.0' ? 'localhost' : host}:${port}`);
    }

    // [knauf] Run the post-listen startup tasks (MCPs, OAuth reconnect, migrations,
    // job manager) inside a fatal try/catch, and flip `serverReady` true ONLY AFTER
    // they all succeed. `serverReady` gates the unhandledRejection handler: while it
    // is false a stray rejection is treated as a fatal startup failure (the worker
    // exits so the container restarts); once true, request-scoped runtime rejections
    // keep the worker alive. So a failure in these awaited startup tasks crashes the
    // worker rather than landing in the keep-alive runtime branch (addresses the
    // review: both "move serverReady after the tasks" AND "wrap in a fatal catch").
    // GenerationJobManager.configure/initialize are synchronous (initialize(): void),
    // so a throw there is caught here too. KK20-190.
    try {
      await runAsSystem(async () => {
        await initializeMCPs();
        await initializeOAuthReconnectManager();
      });
      await checkMigrations();

      const inspectFlags = process.execArgv.some((arg) => arg.startsWith('--inspect'));
      if (inspectFlags || isEnabled(process.env.MEM_DIAG)) {
        memoryDiagnostics.start();
      }

      // Startup fully complete — only now treat a stray rejection as a request-scoped
      // runtime fault (worker kept alive) rather than a fatal startup failure.
      serverReady = true;
      logger.info('Server readiness checks passing.');
    } catch (startupError) {
      logger.error(
        '[startup] Post-listen initialization failed; exiting so the container restarts.',
        { name: startupError?.name, message: startupError?.message, stack: startupError?.stack },
      );
      process.exit(1);
    }
    // End [knauf]
  });

  setupGracefulShutdown(server);
};

// [knauf] `serverReady` (declared above, near `app`) is flipped true in the app.listen
// callback after startup tasks succeed; it gates the unhandledRejection handler's
// keep-alive vs crash decision and the /readyz probe. Boot rejections
// (connectDb/getAppConfig/performStartupChecks) reject before the app.listen callback,
// so serverReady is still false and the unhandledRejection handler below treats them as
// fatal (flush + exit non-zero) — fail-fast, matching upstream's
// `startServer().catch(process.exit)` intent. KK20-190.
startServer();

let messageCount = 0;
process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    logger.error('There was an uncaught error:', err);
  }

  if (err.message && err.message?.toLowerCase()?.includes('abort')) {
    logger.warn('There was an uncatchable abort error.');
    return;
  }

  if (err.message.includes('GoogleGenerativeAI')) {
    logger.warn(
      '\n\n`GoogleGenerativeAI` errors cannot be caught due to an upstream issue, see: https://github.com/google-gemini/generative-ai-js/issues/303',
    );
    return;
  }

  if (err.message.includes('fetch failed')) {
    if (messageCount === 0) {
      logger.warn('Meilisearch error, search will be disabled');
      messageCount++;
    }

    return;
  }

  if (err.message.includes('OpenAIError') || err.message.includes('ChatCompletionMessage')) {
    logger.error(
      '\n\nAn Uncaught `OpenAIError` error may be due to your reverse-proxy setup or stream configuration, or a bug in the `openai` node package.',
    );
    return;
  }

  if (err.stack && err.stack.includes('@librechat/agents')) {
    logger.error(
      '\n\nAn error occurred in the agents system. The error has been logged and the app will continue running.',
      {
        message: err.message,
        stack: err.stack,
      },
    );
    return;
  }

  if (isEnabled(process.env.CONTINUE_ON_UNCAUGHT_EXCEPTION)) {
    logger.error('Unhandled error encountered. The app will continue running.', {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
    return;
  }

  process.exit(1);
});

// [knauf] No `unhandledRejection` handler existed (only `uncaughtException`
// above). Under Node >=15 a stray promise rejection in a request — e.g. an
// un-awaited Azure SDK / fetch call on the file path — can terminate the
// worker, printing only to stderr and never through winston. That produced
// the "socket hang up" on in-flight /api/files requests with an empty error
// log. Log the rejection through winston (so it lands in api/logs/error-*.log),
// and — once the server is ready — keep the worker alive instead of crashing.
//
// Keep-alive is request-scoped only: once the server is listening (serverReady),
// an unhandled rejection is far more likely a per-request async fault than
// corrupted global state, so we log via winston and continue — eliminating the
// silent worker crash. BEFORE the server is ready, a rejection means startup
// itself failed (DB connect, config load, route init); swallowing that would
// leave a half-initialized worker "running" but broken and hide a CrashLoopBackOff,
// so it stays fatal and the process exits non-zero for the orchestrator to restart.
//
// NOTE: the runtime keep-alive is a deliberate availability trade-off, NOT a
// substitute for handling the rejection. The durable fix is to await/`.catch()`
// the originating un-awaited Azure/RAG file-path call at its source; this global
// handler is a safety net. Runtime rejections carry a distinct `[runtime]` marker
// so they can be alerted on (a spike means a missing `.catch()` somewhere). KK20-190.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (!serverReady) {
    logger.error(
      '[unhandledRejection][startup] Promise rejection before the server was ready; exiting so the container restarts.',
      { name: err?.name, message: err?.message, stack: err?.stack },
    );
    // process.exit() can truncate winston's async transports, losing the line
    // above. Flush the logger, then exit non-zero; the timeout backstops the exit
    // in case the 'finish' event never fires.
    const exitFatal = () => process.exit(1);
    logger.on('finish', exitFatal);
    logger.end();
    setTimeout(exitFatal, 1000);
    return;
  }
  logger.error(
    '[unhandledRejection][runtime] A promise rejection was not handled; the worker will continue running.',
    { name: err?.name, message: err?.message, stack: err?.stack },
  );
});
// End [knauf]

/** Export app for easier testing purposes */
module.exports = app;
