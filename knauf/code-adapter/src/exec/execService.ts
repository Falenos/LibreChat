import { AcaError, AcaSessionNotFoundError, AcaTimeoutError } from '../types/aca.js';
import { isValidSessionId, mintSessionId } from '../validate.js';
import { buildWrapper, parseSentinel, OUT_LOG, ERR_LOG } from './wrapper.js';
import { resolveInputs, movePlan, pushInputs, StagedFileMissingError } from './stagePush.js';
import { captureOutputs, echoInputs } from './capture.js';
import type { SupportedLang } from '../validate.js';
import type { AuthContext, ExecRequest, ExecResponse } from '../types/contract.js';
import type { AcaClient } from '../azure/acaClient.js';
import type { BlobStore } from '../azure/blobStore.js';
import type { FilesRepo } from '../store/filesRepo.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../middleware/metrics.js';

const TIMEOUT_STDERR =
  "Execution exceeded the sandbox's 220-second limit and was terminated. " +
  'Split the work into smaller steps and persist intermediate results to /mnt/data.';

const CAPACITY_STDERR = 'The sandbox is at capacity. Try again shortly.';

export interface ExecDeps {
  config: Config;
  logger: Logger;
  aca: AcaClient;
  blob: BlobStore;
  repo: FilesRepo;
  metrics: Metrics;
}

/**
 * The /exec orchestration: session resolution → staged-file push →
 * wrapped execution → sentinel parse (+ truncated-output recovery) →
 * output capture. All user-code failures (non-zero rc, timeout,
 * capacity, expired inputs) return HTTP 200 with code:1 and a
 * model-actionable stderr — never 5xx; infra faults throw AcaError and
 * are mapped by the route/errorHandler.
 */
export async function runExec(
  body: ExecRequest,
  lang: SupportedLang,
  auth: AuthContext,
  deps: ExecDeps,
): Promise<ExecResponse> {
  const { config, logger, metrics } = deps;
  const startedAt = Date.now();

  const sessionId = isValidSessionId(body.session_id) ? body.session_id : mintSessionId();
  if (body.session_id != null && sessionId !== body.session_id) {
    logger.warn({ supplied: String(body.session_id).slice(0, 64) }, 'invalid session_id re-minted');
  }

  const fail = (stderr: string, outcome: string): ExecResponse => {
    metrics.execTotal.inc({ lang, outcome });
    return { session_id: sessionId, stdout: '', stderr, code: 1, files: [] };
  };

  let inputs;
  try {
    inputs = await resolveInputs(body.files ?? [], auth, deps.repo);
  } catch (err) {
    if (err instanceof StagedFileMissingError) {
      return fail(
        `Input file '${err.filename}' is no longer available in the sandbox (expired). Re-attach the file and retry.`,
        'expired_input',
      );
    }
    throw err;
  }

  const runOnce = async (): Promise<ExecResponse> => {
    if (inputs.length > 0) {
      await pushInputs(inputs, sessionId, deps);
    }

    // Everything runs on the code-interpreter (Python) pool, so the wrapper is
    // always a Python program (it runs bash via subprocess). It is mandatory for
    // bash — raw bash can't run on a Python pool — so `EXEC_WRAPPER=off` only
    // sends raw code for `py`; bash always wraps.
    const useWrapper = config.exec.wrapper === 'full' || lang === 'bash';
    const plan = useWrapper
      ? buildWrapper(lang, body.code, body.args ?? [], movePlan(inputs))
      : null;
    const codeToRun = plan?.wrappedCode ?? body.code;

    const outcome = await deps.aca.execute(sessionId, codeToRun);

    let stdout: string;
    let stderr: string;
    let code: number;
    let truncationRecovered = false;

    const sentinel = plan != null ? parseSentinel(plan.delimiter, outcome.stdout) : null;
    if (sentinel != null) {
      code = sentinel.rc;
      stdout = sentinel.inlineStdout;
      stderr = sentinel.inlineStderr;
      if (sentinel.outBytes > Buffer.byteLength(stdout, 'utf8')) {
        try {
          const full = await deps.aca.fetchFileContent(
            sessionId,
            OUT_LOG,
            config.exec.stdoutMaxBytes,
          );
          stdout = full.toString('utf8');
          truncationRecovered = true;
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'stdout log recovery failed');
        }
      }
      if (sentinel.errBytes > Buffer.byteLength(stderr, 'utf8')) {
        try {
          const full = await deps.aca.fetchFileContent(
            sessionId,
            ERR_LOG,
            config.exec.stderrMaxBytes,
          );
          stderr = full.toString('utf8');
          truncationRecovered = true;
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'stderr log recovery failed');
        }
      }
    } else {
      if (plan != null) {
        metrics.wrapperParseFailures.inc();
        logger.warn({ sessionId }, 'wrapper sentinel missing — falling back to raw output');
      }
      stdout = outcome.stdout;
      stderr = outcome.stderr;
      // Sentinel missing → synthesize from the pool status (no real rc available).
      code = outcome.succeeded ? 0 : 1;
    }

    let files = echoInputs(inputs);
    let overflowNote: string | null = null;
    if (code === 0) {
      const capture = await captureOutputs({
        sessionId,
        inputs,
        auth,
        config,
        deps,
      });
      files = capture.files;
      overflowNote = capture.overflowNote;
    }
    if (overflowNote != null) {
      stderr = stderr === '' ? overflowNote : `${stderr}\n${overflowNote}`;
    }

    metrics.execTotal.inc({ lang, outcome: code === 0 ? 'ok' : 'user_error' });
    metrics.execDuration.observe(
      { pool: lang, outcome: code === 0 ? 'ok' : 'user_error' },
      (Date.now() - startedAt) / 1000,
    );
    logger.info(
      {
        session_id: sessionId,
        lang,
        rc: code,
        exec_ms: outcome.executionMs,
        total_ms: Date.now() - startedAt,
        push_count: inputs.length,
        stdout_bytes: Buffer.byteLength(stdout, 'utf8'),
        stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
        truncation_recovered: truncationRecovered,
        files_returned: files.length,
      },
      'exec completed',
    );

    return { session_id: sessionId, stdout, stderr, code, files };
  };

  try {
    return await runOnce();
  } catch (err) {
    if (err instanceof AcaSessionNotFoundError) {
      logger.info({ sessionId }, 'session expired mid-run — re-running once');
      try {
        return await runOnce();
      } catch (retryErr) {
        if (retryErr instanceof AcaTimeoutError) {
          return fail(TIMEOUT_STDERR, 'timeout');
        }
        if (retryErr instanceof AcaSessionNotFoundError) {
          return fail(TIMEOUT_STDERR, 'session_lost');
        }
        throw retryErr;
      }
    }
    if (err instanceof AcaTimeoutError) {
      return fail(TIMEOUT_STDERR, 'timeout');
    }
    if (err instanceof AcaError && err.statusCode === 429) {
      if (err.retryAfterSeconds != null && err.retryAfterSeconds <= 5) {
        await new Promise((resolve) => setTimeout(resolve, err.retryAfterSeconds! * 1000));
        try {
          return await runOnce();
        } catch {
          return fail(CAPACITY_STDERR, 'capacity');
        }
      }
      return fail(CAPACITY_STDERR, 'capacity');
    }
    if (err instanceof AcaError && err.statusCode === 413) {
      return fail('An input file exceeds the sandbox 128MB limit.', 'payload_too_large');
    }
    throw err;
  }
}
