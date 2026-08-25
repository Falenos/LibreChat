import express from 'express';
import { pinoHttp } from 'pino-http';
import { createJwtMiddleware } from './auth/verifyJwt.js';
import { createErrorHandler } from './middleware/errorHandler.js';
import { normalizeHttpRoute, traceHttpRequest } from './middleware/telemetry.js';
import { createExecRouter } from './routes/exec.js';
import { createUploadRouter } from './routes/upload.js';
import { createDownloadRouter } from './routes/download.js';
import { createObjectsRouter } from './routes/objects.js';
import { createHealthRouter } from './routes/health.js';
import type { Express } from 'express';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { AcaClient } from './azure/acaClient.js';
import type { BlobStore } from './azure/blobStore.js';
import type { FilesRepo } from './store/filesRepo.js';
import type { Metrics } from './middleware/metrics.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  aca: AcaClient;
  blob: BlobStore;
  repo: FilesRepo;
  metadataReadiness: () => Promise<void>;
  metrics: Metrics;
}

/**
 * Express factory. Everything LibreChat calls lives under /v1 behind
 * JWT auth (LIBRECHAT_CODE_BASEURL=http://<svc>:<port>/v1); health and
 * metrics endpoints are unprefixed and unauthenticated (k8s only).
 */
export function createApp(deps: AppDeps): Express {
  const { config, logger, metrics } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(traceHttpRequest);

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req: (serialized) => ({
          method: serialized.method,
          route: normalizeHttpRoute(serialized.url),
        }),
        res: (serialized) => ({ statusCode: serialized.statusCode }),
      },
      autoLogging: {
        ignore: (req) => req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics',
      },
    }),
  );

  app.use(createHealthRouter(deps.metadataReadiness));
  if (config.metricsEnabled) {
    app.get('/metrics', (req, res, next) => {
      void (async () => {
        res.setHeader('Content-Type', metrics.registry.contentType);
        res.end(await metrics.registry.metrics());
      })().catch(next);
    });
  }
  const v1 = express.Router();
  v1.use(createJwtMiddleware(config, logger));
  v1.use(express.json({ limit: `${Math.ceil(config.exec.codeMaxBytes / 1024) + 64}kb` }));
  v1.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  v1.use(
    createExecRouter({ config, logger, aca: deps.aca, blob: deps.blob, repo: deps.repo, metrics }),
  );
  v1.use(createUploadRouter({ config, logger, blob: deps.blob, repo: deps.repo, metrics }));
  v1.use(createDownloadRouter({ blob: deps.blob, repo: deps.repo, logger }));
  v1.use(createObjectsRouter({ blob: deps.blob, repo: deps.repo, logger }));
  app.use('/v1', v1);

  app.use(createErrorHandler(logger));
  return app;
}
