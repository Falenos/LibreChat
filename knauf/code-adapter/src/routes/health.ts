import { Router } from 'express';
import type { MongoHandle } from '../store/mongo.js';

/**
 * /healthz (liveness) and /readyz (readiness: Mongo ping). Unprefixed
 * and unauthenticated — k8s probes only; LibreChat's verifyToolAuth
 * never probes the backend, so these buy nothing on the LibreChat side.
 */
export function createHealthRouter(mongo: Pick<MongoHandle, 'db'>): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  router.get('/readyz', (req, res, next) => {
    void (async () => {
      await mongo.db.command({ ping: 1 });
      res.status(200).json({ status: 'ok' });
    })().catch(next);
  });

  return router;
}
