import { Router } from 'express';

/**
 * /healthz (liveness) and /readyz (readiness: exact filtered Table query). Unprefixed
 * and unauthenticated — k8s probes only; LibreChat's verifyToolAuth
 * never probes the backend, so these buy nothing on the LibreChat side.
 */
export function createHealthRouter(metadataReadiness: () => Promise<void>): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/readyz', (req, res, next) => {
    void (async () => {
      await metadataReadiness();
      res.status(200).json({ status: 'ok' });
    })().catch(next);
  });

  return router;
}
