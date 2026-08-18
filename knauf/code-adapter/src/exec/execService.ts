import { AcaError, AcaSessionNotFoundError, AcaTimeoutError } from '../types/aca.js';
import { deriveSessionId, isValidSessionId, mintSessionId, sessionBelongsTo } from '../validate.js';
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

  // Session resolution, most specific first:
  //   1. an explicit valid `session_id` — honoured, but note the current client never
  //      sends one (it reads ToolNode's session id and drops it before the POST), so this
  //      is really for direct API callers and our own smoke script;
  //   2. `runtime_session_hint` — the one continuity field `@librechat/agents` 3.2.65 does
  //      put on the wire, and only when the host enables
  //      `toolExecution.sandbox.statefulSessions`. Same hint ⇒ same sandbox, so a
  //      conversation keeps its /mnt/data across turns instead of starting cold;
  //   3. otherwise a fresh id, i.e. a fresh sandbox for this execution.
  const hint = typeof body.runtime_session_hint === 'string' ? body.runtime_session_hint : '';
  const secret = deps.config.sessionHintSecret;
  // A supplied id must be well-formed AND bear the caller's own owner tag. Without the
  // second half, `session_id` is an unauthenticated pointer at any sandbox in the pool —
  // the sandbox is the isolation boundary, and nothing else in the request binds it to a
  // user. Foreign ids are ignored rather than rejected: the contract is to run the code,
  // and running it in a fresh sandbox of the caller's own is both safe and useful.
  const suppliedIsOwn =
    isValidSessionId(body.session_id) && sessionBelongsTo(body.session_id, auth.userId, secret);
  let sessionId: string;
  let derivedFromHint = false;
  if (suppliedIsOwn && isValidSessionId(body.session_id)) {
    sessionId = body.session_id;
  } else if (hint !== '') {
    sessionId = deriveSessionId(hint, secret, auth.userId);
    derivedFromHint = true;
  } else {
    sessionId = mintSessionId(auth.userId, secret);
  }
  if (body.session_id != null && !isValidSessionId(body.session_id)) {
    logger.warn({ supplied: String(body.session_id).slice(0, 64) }, 'invalid session_id ignored');
  } else if (isValidSessionId(body.session_id) && !suppliedIsOwn) {
    // Worth a louder line than a malformed id: well-formed but not the caller's means
    // either a client bug or someone probing another user's sandbox.
    logger.warn(
      { supplied: body.session_id.slice(0, 16), userId: auth.userId },
      'session_id does not belong to the caller — ignored, fresh session allocated',
    );
  }

  const fail = (stderr: string, outcome: string): ExecResponse => {
    metrics.execTotal.inc({ lang, outcome });
    return {
      session_id: sessionId,
      stdout: '',
      stderr,
      code: 1,
      files: [],
      ...(derivedFromHint ? { runtime_session_id: sessionId } : {}),
    };
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

  const runOnce = () =>
    executeOnce(body, lang, auth, sessionId, inputs, deps, {
      derivedFromHint,
      reused: suppliedIsOwn,
    });
  return runWithRecovery(runOnce, { sessionId, logger, fail });
}

/**
 * Run an exec attempt, recovering from the two retryable infra faults — a vanished session
 * and short-`Retry-After` capacity (sleep + retry once) — and mapping the rest to friendly
 * results.
 *
 * The vanished-session retry deliberately reuses the SAME identifier rather than minting a
 * new one, which is the opposite of what earlier comments here claimed. An ACA identifier
 * is just a key: posting to one that has no live session allocates a fresh sandbox, so the
 * retry gets exactly the clean sandbox a re-mint would have produced, and `executeOnce`
 * re-pushes the staged inputs into it. Keeping the identifier also keeps the contract the
 * caller sees — the `session_id` in the response is the one it asked for, and a
 * hint-derived session stays stable for the conversation instead of silently forking.
 * If the second attempt also reports the session missing we stop and return the friendly
 * timeout message rather than looping.
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
      logger.info(
        { sessionId },
        'session vanished mid-run — retrying once with the same identifier',
      );
      return retryOnce(runOnce, (retryErr) =>
        retryErr instanceof AcaSessionNotFoundError
          ? fail(TIMEOUT_STDERR, 'session_lost')
          : mapTerminalError(retryErr, fail),
      );
    }
    if (isRetryableCapacity(err)) {
      await sleep((err.retryAfterSeconds ?? 0) * 1000);
      return retryOnce(runOnce, () => fail(CAPACITY_STDERR, 'capacity'));
    }
    return mapTerminalError(err, fail);
  }
}

/** Run the attempt once more, funnelling whatever it throws through one handler. */
async function retryOnce(
  runOnce: () => Promise<ExecResponse>,
  onFailure: (err: unknown) => ExecResponse,
): Promise<ExecResponse> {
  try {
    return await runOnce();
  } catch (err) {
    return onFailure(err);
  }
}

/**
 * A 429 worth waiting for. A long `Retry-After` is not retried inline — the caller has its
 * own timeout and would rather hear "at capacity" than block.
 */
function isRetryableCapacity(err: unknown): err is AcaError {
  return err instanceof AcaError && err.statusCode === 429 && (err.retryAfterSeconds ?? 99) <= 5;
}

/** How this attempt's session id was arrived at — drives the baseline and the echo. */
interface SessionOrigin {
  /** From `runtime_session_hint`; echoed back as `runtime_session_id`. */
  derivedFromHint: boolean;
  /** The caller supplied one of its own — it may already hold files from earlier execs. */
  reused: boolean;
}

/** One execution attempt (push → snapshot → run → resolve → capture). */
async function executeOnce(
  body: ExecRequest,
  lang: SupportedLang,
  auth: AuthContext,
  sessionId: string,
  inputs: Awaited<ReturnType<typeof resolveInputs>>,
  deps: ExecDeps,
  origin: SessionOrigin,
): Promise<ExecResponse> {
  const { derivedFromHint, reused: reusedSession } = origin;
  const { config, logger, metrics } = deps;
  const startedAt = Date.now();

  if (inputs.length > 0) {
    await pushInputs(inputs, sessionId, deps);
  }

  const baseline = await snapshotBaseline(sessionId, reusedSession, inputs.length > 0, deps);

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
  const notes: string[] = [];
  if (out.code === 0) {
    const capture = await captureOutputs({ sessionId, inputs, baseline, auth, config, deps });
    files = capture.files;
    if (capture.overflowNote != null) {
      notes.push(capture.overflowNote);
    }
    // A file the code demonstrably wrote but we could not persist must not vanish
    // silently: the caller formats stdout/stderr only, so without this the model is told
    // the run succeeded and simply never sees the deliverable it just produced.
    if (capture.failedNote != null) {
      notes.push(capture.failedNote);
    }
  } else if (stderr === '') {
    // The exit code is real, but the caller drops it: `@librechat/agents` (3.2.65,
    // and 3.2.46 before it) formats only `stdout`/`stderr` and never reads `result.code`.
    // A silent `exit 7` therefore renders as "stdout: Empty" and reads as success, so the
    // model retries nothing and reports a non-existent result. Put the failure somewhere
    // it will actually be shown.
    notes.push(
      `Command failed with exit status ${out.code} and produced no error output. ` +
        'Nothing was written to stdout or stderr, so treat this as a failure, not an empty result.',
    );
  }
  if (notes.length > 0) {
    stderr = [stderr, ...notes].filter((part) => part !== '').join('\n');
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

  return {
    session_id: sessionId,
    stdout: out.stdout,
    stderr,
    code: out.code,
    files,
    // Echoed only for a hint-derived session. The client puts it on the tool artifact, so
    // continuity is visible in traces instead of having to be inferred.
    ...(derivedFromHint ? { runtime_session_id: sessionId } : {}),
  };
}

/**
 * Snapshot the sandbox's files before running user code (but AFTER inputs are pushed), so
 * capture can tell this exec's work from what was already there.
 *
 * Taken in two cases, for two different reasons:
 *  - a supplied (reused) session id may carry files from earlier execs, which must not be
 *    re-returned as if this exec produced them;
 *  - THIS exec pushed input files, and the baseline is the only way to notice that user
 *    code rewrote one of them. Size alone cannot: `abc` → `xyz` keeps the byte count, and
 *    without a baseline that edit is reported as `inherited` and the modified content is
 *    thrown away. Since the current client never sends a session id, this is the case that
 *    actually fires in production.
 *
 * Skipped when there is neither — a fresh session with no inputs has nothing to compare
 * against, and skipping keeps one ACA round-trip out of the latency-sensitive pure-read
 * path (`readSandboxFile` has a 15s client budget).
 */
async function snapshotBaseline(
  sessionId: string,
  reusedSession: boolean,
  hasInputs: boolean,
  deps: ExecDeps,
): Promise<Map<string, string>> {
  if (!reusedSession && !hasInputs) {
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
    deps.metrics.truncationRecoveries.inc();
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
