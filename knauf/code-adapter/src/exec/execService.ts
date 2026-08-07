import { AcaError, AcaSessionNotFoundError, AcaTimeoutError } from '../types/aca.js';
import { isValidSessionId, mintSessionId } from '../validate.js';
import { buildWrapper, parseSentinel, OUT_LOG, ERR_LOG } from './wrapper.js';
import type { WrapperPlan } from './wrapper.js';
import { resolveInputs, movePlan, pushInputs, StagedFileMissingError } from './stagePush.js';
import { captureOutputs, echoInputs, baselineFrom } from './capture.js';
import type { SupportedLang } from '../validate.js';
import type { AuthContext, ExecRequest, ExecResponse } from '../types/contract.js';
import type { AcaClient } from '../azure/acaClient.js';
import type { AcaExecOutcome } from '../types/aca.js';
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

/** stdout/stderr/exit-code resolved from a pool execution. */
interface ResolvedOutput {
  stdout: string;
  stderr: string;
  code: number;
  truncationRecovered: boolean;
}

/**
 * The /exec orchestration: session resolution → staged-file push →
 * baseline snapshot → wrapped execution → output resolution → capture. All
 * user-code failures (non-zero rc, timeout, capacity, expired inputs) return
 * HTTP 200 with code:1 and a model-actionable stderr — never 5xx; infra faults
 * throw AcaError and are mapped by the route/errorHandler.
 */
export async function runExec(
  body: ExecRequest,
  lang: SupportedLang,
  auth: AuthContext,
  deps: ExecDeps,
): Promise<ExecResponse> {
  const { logger, metrics } = deps;

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

  const runOnce = () => executeOnce(body, lang, auth, sessionId, inputs, deps);
  return runWithRecovery(runOnce, { sessionId, logger, fail });
}

/**
 * Run an exec attempt, recovering from the two retryable infra faults —
 * cooldown-expired session (re-mint + retry once) and short-`Retry-After`
 * capacity (sleep + retry once) — and mapping the rest to friendly results.
 */
async function runWithRecovery(
  runOnce: () => Promise<ExecResponse>,
  ctx: {
    sessionId: string;
    logger: Logger;
    fail: (stderr: string, outcome: string) => ExecResponse;
  },
): Promise<ExecResponse> {
  const { sessionId, logger, fail } = ctx;
  try {
    return await runOnce();
  } catch (err) {
    if (err instanceof AcaSessionNotFoundError) {
      logger.info({ sessionId }, 'session expired mid-run — re-running once');
      try {
        return await runOnce();
      } catch (retryErr) {
        return retryErr instanceof AcaSessionNotFoundError
          ? fail(TIMEOUT_STDERR, 'session_lost')
          : mapTerminalError(retryErr, fail);
      }
    }
    if (err instanceof AcaError && err.statusCode === 429 && (err.retryAfterSeconds ?? 99) <= 5) {
      await sleep((err.retryAfterSeconds ?? 0) * 1000);
      try {
        return await runOnce();
      } catch {
        return fail(CAPACITY_STDERR, 'capacity');
      }
    }
    return mapTerminalError(err, fail);
  }
}

/** One execution attempt (push → snapshot → run → resolve → capture). */
async function executeOnce(
  body: ExecRequest,
  lang: SupportedLang,
  auth: AuthContext,
  sessionId: string,
  inputs: Awaited<ReturnType<typeof resolveInputs>>,
  deps: ExecDeps,
): Promise<ExecResponse> {
  const { config, logger, metrics } = deps;
  const startedAt = Date.now();

  if (inputs.length > 0) {
    await pushInputs(inputs, sessionId, deps);
  }

  const baseline = await snapshotBaseline(sessionId, body.session_id, deps);

  // Everything runs on the code-interpreter (Python) pool, so the wrapper is
  // always a Python program (it runs bash via subprocess). It is mandatory for
  // bash — raw bash can't run on a Python pool — so `EXEC_WRAPPER=off` only
  // sends raw code for `py`; bash always wraps.
  const useWrapper = config.exec.wrapper === 'full' || lang === 'bash';
  const plan = useWrapper ? buildWrapper(lang, body.code, body.args ?? [], movePlan(inputs)) : null;

  const outcome = await deps.aca.execute(sessionId, plan?.wrappedCode ?? body.code);
  const out = await resolveOutput(outcome, plan, sessionId, deps);

  let files = echoInputs(inputs);
  let stderr = out.stderr;
  if (out.code === 0) {
    const capture = await captureOutputs({ sessionId, inputs, baseline, auth, config, deps });
    files = capture.files;
    if (capture.overflowNote != null) {
      stderr = stderr === '' ? capture.overflowNote : `${stderr}\n${capture.overflowNote}`;
    }
  }

  const outcomeLabel = out.code === 0 ? 'ok' : 'user_error';
  metrics.execTotal.inc({ lang, outcome: outcomeLabel });
  metrics.execDuration.observe({ lang, outcome: outcomeLabel }, (Date.now() - startedAt) / 1000);
  logger.info(
    {
      session_id: sessionId,
      lang,
      rc: out.code,
      exec_ms: outcome.executionMs,
      total_ms: Date.now() - startedAt,
      push_count: inputs.length,
      stdout_bytes: Buffer.byteLength(out.stdout, 'utf8'),
      stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
      truncation_recovered: out.truncationRecovered,
      files_returned: files.length,
    },
    'exec completed',
  );

  return { session_id: sessionId, stdout: out.stdout, stderr, code: out.code, files };
}

/**
 * Snapshot the sandbox's files before running user code, so capture returns only
 * this exec's new/changed files — not everything accumulated in a reused session.
 * A freshly minted session_id has no prior files (skip the call); a supplied
 * (reused) id might, and may also not exist yet (→ empty baseline).
 */
async function snapshotBaseline(
  sessionId: string,
  suppliedSessionId: string | undefined,
  deps: ExecDeps,
): Promise<Map<string, string>> {
  if (!isValidSessionId(suppliedSessionId)) {
    return new Map();
  }
  try {
    return baselineFrom(await deps.aca.listFiles(sessionId));
  } catch (err) {
    deps.logger.debug({ err: (err as Error).message }, 'baseline snapshot skipped');
    return new Map();
  }
}

/**
 * Turn a raw pool outcome into stdout/stderr/exit-code. Prefers the wrapper
 * sentinel (real exit code + truncation recovery from /mnt/data logs); falls
 * back to raw output + 0/1 synthesis when the sentinel is missing.
 */
async function resolveOutput(
  outcome: AcaExecOutcome,
  plan: WrapperPlan | null,
  sessionId: string,
  deps: ExecDeps,
): Promise<ResolvedOutput> {
  const sentinel = plan != null ? parseSentinel(plan.delimiter, outcome.stdout) : null;
  if (sentinel == null) {
    if (plan != null) {
      deps.metrics.wrapperParseFailures.inc();
      deps.logger.warn({ sessionId }, 'wrapper sentinel missing — falling back to raw output');
    }
    return {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      code: outcome.succeeded ? 0 : 1,
      truncationRecovered: false,
    };
  }

  let truncationRecovered = false;
  let stdout = sentinel.inlineStdout;
  let stderr = sentinel.inlineStderr;
  if (sentinel.outBytes > Buffer.byteLength(stdout, 'utf8')) {
    const full = await recoverLog(sessionId, OUT_LOG, deps.config.exec.stdoutMaxBytes, deps);
    if (full != null) {
      stdout = full;
      truncationRecovered = true;
    }
  }
  if (sentinel.errBytes > Buffer.byteLength(stderr, 'utf8')) {
    const full = await recoverLog(sessionId, ERR_LOG, deps.config.exec.stderrMaxBytes, deps);
    if (full != null) {
      stderr = full;
      truncationRecovered = true;
    }
  }
  return { stdout, stderr, code: sentinel.rc, truncationRecovered };
}

/** Fetch a full tee'd log from /mnt/data when inline output was truncated. */
async function recoverLog(
  sessionId: string,
  logName: string,
  maxBytes: number,
  deps: ExecDeps,
): Promise<string | null> {
  try {
    const full = await deps.aca.fetchFileContent(sessionId, logName, maxBytes);
    return full.toString('utf8');
  } catch (err) {
    deps.logger.warn({ err: (err as Error).message, logName }, 'output log recovery failed');
    return null;
  }
}

/** Map an infra error to a friendly 200 where the contract wants one, else rethrow. */
function mapTerminalError(
  err: unknown,
  fail: (stderr: string, outcome: string) => ExecResponse,
): ExecResponse {
  if (err instanceof AcaTimeoutError) {
    return fail(TIMEOUT_STDERR, 'timeout');
  }
  if (err instanceof AcaError && err.statusCode === 429) {
    return fail(CAPACITY_STDERR, 'capacity');
  }
  if (err instanceof AcaError && err.statusCode === 413) {
    return fail('An input file exceeds the sandbox 128MB limit.', 'payload_too_large');
  }
  throw err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
