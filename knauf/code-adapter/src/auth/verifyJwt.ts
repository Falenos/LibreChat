import { importSPKI, jwtVerify } from 'jose';
import type { KeyLike } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config.js';
import type { AuthContext } from '../types/contract.js';
import type { Logger } from '../logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Verify the per-request JWT LibreChat mints in
 * packages/api/src/auth/codeapi.ts: pinned alg allowlist (EdDSA
 * default), issuer + audience required, optional kid pin, maxTokenAge
 * matching the mint-side TTL cap (300s), small clock tolerance.
 *
 * LOCAL_MODE injects a synthetic auth context — local dev only; config
 * refuses LOCAL_MODE under NODE_ENV=production.
 */
export function createJwtMiddleware(config: Config, logger: Logger) {
  let keyPromise: Promise<KeyLike> | null = null;

  const getKey = (): Promise<KeyLike> => {
    if (keyPromise == null) {
      const pem = config.jwt.publicKeyPem;
      if (pem == null) {
        throw new Error('JWT public key is not configured');
      }
      const alg = config.jwt.allowedAlgs[0] ?? 'EdDSA';
      keyPromise = importSPKI(pem, alg);
    }
    return keyPromise;
  };

  return async function verifyJwtMiddleware(req: Request, res: Response, next: NextFunction) {
    if (config.localMode) {
      req.auth = { userId: 'local', tenantId: 'local', role: 'ADMIN' };
      next();
      return;
    }

    const header = req.headers.authorization;
    if (header == null || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const token = header.slice('Bearer '.length);

    try {
      const key = await getKey();
      const { payload, protectedHeader } = await jwtVerify(token, key, {
        algorithms: config.jwt.allowedAlgs,
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
        clockTolerance: config.jwt.clockToleranceS,
        maxTokenAge: config.jwt.maxAgeS,
      });

      if (config.jwt.kid != null && protectedHeader.kid !== config.jwt.kid) {
        logger.warn({ kid: protectedHeader.kid }, 'JWT kid mismatch');
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const sub = typeof payload.sub === 'string' ? payload.sub : null;
      const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : null;
      if (sub == null || tenantId == null) {
        logger.warn('JWT missing sub or tenant_id claim');
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      req.auth = {
        userId: sub,
        tenantId,
        role: typeof payload.role === 'string' ? payload.role : 'USER',
      };
      next();
    } catch (err) {
      logger.info({ err: (err as Error).message }, 'JWT verification failed');
      res.status(401).json({ error: 'unauthorized' });
    }
  };
}
