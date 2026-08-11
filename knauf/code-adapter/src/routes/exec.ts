import { Router } from 'express';
import { isSupportedLang, ValidationError } from '../validate.js';
import { runExec } from '../exec/execService.js';
import type { ExecDeps } from '../exec/execService.js';
import type { ExecRequest } from '../types/contract.js';

export function createExecRouter(deps: ExecDeps): Router {
  const router = Router();

  router.post('/exec', (req, res, next) => {
    void (async () => {
      const body = req.body as ExecRequest | undefined;
      if (body == null || typeof body.code !== 'string') {
        throw new ValidationError('code is required');
      }
      if (Buffer.byteLength(body.code, 'utf8') > deps.config.exec.codeMaxBytes) {
        throw new ValidationError('code exceeds the maximum size', 413);
      }
      if (!isSupportedLang(body.lang)) {
        res.status(501).json({
          error: `Language '${String(body.lang)}' is not supported by this backend (py, bash only)`,
        });
        return;
      }
      if (
        body.args != null &&
        (!Array.isArray(body.args) || body.args.some((a) => typeof a !== 'string'))
      ) {
        throw new ValidationError('args must be an array of strings');
      }
      if (body.args != null && body.args.some((a) => Buffer.byteLength(a, 'utf8') > 8192)) {
        throw new ValidationError('argument exceeds the maximum size', 413);
      }

      const auth = req.auth;
      if (auth == null) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const response = await runExec(body, body.lang, auth, deps);
      res.status(200).json(response);
    })().catch(next);
  });

  router.post('/exec/programmatic', (_req, res) => {
    res.status(501).json({
      error: {
        code: 'PTC_NOT_SUPPORTED',
        message: 'Programmatic tool calling is not supported by the ACA code adapter',
      },
    });
  });

  return router;
}
