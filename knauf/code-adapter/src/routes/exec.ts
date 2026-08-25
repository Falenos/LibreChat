import { Router } from 'express';
import { isSupportedLang, ValidationError } from '../validate.js';
import { runExec } from '../exec/execService.js';
import type { ExecDeps } from '../exec/execService.js';
import type { ExecRequest } from '../types/contract.js';
import { AdmissionController } from '../exec/admission.js';

type ExecRouterDeps = Omit<ExecDeps, 'admission'>;
const CANARY_STDOUT = 'KARL_CODE_CANARY_OK';
const CANARY_FILENAME = 'karl-code-canary.txt';
const CANARY_CODE = [
  'from pathlib import Path',
  `Path(${JSON.stringify(CANARY_FILENAME)}).write_text("ok", encoding="utf-8")`,
  `print(${JSON.stringify(CANARY_STDOUT)})`,
].join('\n');

export function createExecRouter(deps: ExecRouterDeps): Router {
  const router = Router();
  const runtimeDeps: ExecDeps = {
    ...deps,
    admission: new AdmissionController(deps.config.exec, deps.metrics),
  };

  router.post('/exec', (req, res, next) => {
    void (async () => {
      const body = req.body as ExecRequest | undefined;
      if (body == null || typeof body.code !== 'string') {
        throw new ValidationError('code is required');
      }
      if (typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError('request body must be an object');
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
      if (body.args != null && body.args.length > 100) {
        throw new ValidationError('too many arguments', 413);
      }
      if (body.files != null && !Array.isArray(body.files)) {
        throw new ValidationError('files must be an array');
      }
      for (const file of body.files ?? []) {
        if (
          file == null ||
          typeof file !== 'object' ||
          typeof file.id !== 'string' ||
          file.id === '' ||
          typeof file.name !== 'string' ||
          file.name === ''
        ) {
          throw new ValidationError('each file requires non-empty id and name strings');
        }
        if (
          (file.session_id != null && typeof file.session_id !== 'string') ||
          (file.storage_session_id != null && typeof file.storage_session_id !== 'string') ||
          (file.resource_id != null && typeof file.resource_id !== 'string') ||
          (file.kind != null && !['skill', 'agent', 'user'].includes(file.kind)) ||
          (file.version != null &&
            (!Number.isSafeInteger(file.version) || (file.version as number) < 0)) ||
          (file.read_only != null && typeof file.read_only !== 'boolean')
        ) {
          throw new ValidationError('file reference contains invalid fields');
        }
      }
      for (const field of ['session_id', 'user_id', 'entity_id', 'runtime_session_hint'] as const) {
        if (body[field] != null && typeof body[field] !== 'string') {
          throw new ValidationError(`${field} must be a string`);
        }
        if (
          typeof body[field] === 'string' &&
          Buffer.byteLength(body[field] as string, 'utf8') > 4096
        ) {
          throw new ValidationError(`${field} exceeds the maximum size`, 413);
        }
      }

      const auth = req.auth;
      if (auth == null) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      const response = await runExec(body, body.lang, auth, {
        ...runtimeDeps,
        logger: deps.logger.child({ request_id: req.id }),
      });
      res.status(200).json(response);
    })().catch(next);
  });

  router.post('/internal/canary', (req, res, next) => {
    void (async () => {
      const auth = req.auth;
      if (auth == null) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      try {
        const response = await runExec({ lang: 'py', code: CANARY_CODE }, 'py', auth, {
          ...runtimeDeps,
          logger: deps.logger.child({ request_id: req.id, canary: true }),
        });
        const passed =
          response.code === 0 &&
          response.stdout.trim() === CANARY_STDOUT &&
          response.files.some((file) => file.name === CANARY_FILENAME && file.inherited !== true);
        if (!passed) {
          throw new Error('fixed code-execution canary returned an unexpected result');
        }
        deps.metrics.canaryTotal.inc({ outcome: 'success' });
        deps.metrics.canaryLastSuccess.set(Date.now() / 1000);
        res.status(200).json(response);
      } catch (error) {
        deps.metrics.canaryTotal.inc({ outcome: 'error' });
        throw error;
      }
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
