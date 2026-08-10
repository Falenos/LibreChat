// [knauf] KK20-195 WP4a — the dedicated indexing worker's claim loop
// (hardened plan §5). DI-style: `db` (createMethods surface), `ragClient`
// (the §7 generation-safe contract), `resolveScope` and `markFilesEmbedded`
// are injected so the loop unit-tests against a real Mongo and a fake RAG.
//
// Invariants enforced here (the WP2b methods carry the CAS/token fencing):
//   §5.1 one atomic claim at a time, oldest-due-first, fresh execution
//        token + incremented target generation per claim.
//   §5.2 heartbeats extend the lease while local execution is active; a
//        heartbeat CAS miss means ownership is lost — the worker must not
//        update asset state afterwards, only clean ITS OWN generation.
//   §5.3 retry classification: retryable → requeue with full-jitter backoff
//        honoring Retry-After; permanent input → failed; auth/config →
//        limited retry + alert-level log, then failed; ownership lost /
//        tombstone → no state update beyond cleaning this generation.
//   §7.4 activation is one CAS on (token, generation, profile, no
//        tombstone); a miss deletes only the generation this worker wrote —
//        never the active generation, never all vectors.
//
// Knobs are env-tunable defaults (assumption ledger #4): final values come
// from WP0 measurements and fault tests before production enablement.

const crypto = require('crypto');

/** @param {string | undefined} raw @param {number} fallback @returns {number} */
const envInt = (raw, fallback) => {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** @returns {Object} worker knobs, read at call time */
const getWorkerConfig = () => ({
  leaseMs: envInt(process.env.KNAUF_WORKER_LEASE_MS, 5 * 60 * 1000),
  heartbeatMs: envInt(process.env.KNAUF_WORKER_HEARTBEAT_MS, 30 * 1000),
  pollMs: envInt(process.env.KNAUF_WORKER_POLL_MS, 5 * 1000),
  queueMetricsMs: envInt(process.env.KNAUF_WORKER_QUEUE_METRICS_MS, 30 * 1000),
  attemptCap: envInt(process.env.KNAUF_WORKER_ATTEMPT_CAP, 5),
  authAttemptCap: envInt(process.env.KNAUF_WORKER_AUTH_ATTEMPT_CAP, 2),
  backoffBaseMs: envInt(process.env.KNAUF_WORKER_BACKOFF_BASE_MS, 10 * 1000),
  backoffMaxMs: envInt(process.env.KNAUF_WORKER_BACKOFF_MAX_MS, 10 * 60 * 1000),
});

/**
 * Periodically records queue pressure without coupling it to the 15-minute
 * reconciler. Slow samples never overlap and telemetry failures never stop the
 * worker claim loop.
 */
function createQueueMetricsSampler({ sample, record, logger, intervalMs }) {
  let timer;
  let inFlight;
  const runOnce = () => {
    if (inFlight) {
      return inFlight;
    }
    inFlight = Promise.resolve()
      .then(sample)
      .then(({ queued, oldestAgeSeconds }) => record(queued, oldestAgeSeconds))
      .catch((error) =>
        logger.warn(`[indexingWorker][metrics] queue sample failed: ${error?.message}`),
      )
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  const start = () => {
    if (timer) {
      return;
    }
    void runOnce();
    timer = setInterval(() => void runOnce(), intervalMs ?? getWorkerConfig().queueMetricsMs);
    timer.unref?.();
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  return { runOnce, start, stop };
}

/**
 * §5.3 error classes.
 * @param {any} error
 * @returns {'retryable' | 'auth' | 'permanent'}
 */
function classifyWorkerError(error) {
  const status = error?.status ?? error?.response?.status;
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
    return 'retryable';
  }
  if (status >= 400 && status < 500) {
    return 'permanent'; // unsupported/corrupt input, validation failure
  }
  const code = error?.code;
  if (
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN'].includes(code)
  ) {
    return 'retryable';
  }
  // Unknown/transient internal errors stay retryable — bounded by the
  // attempt cap, never silently permanent.
  return 'retryable';
}

/** Parse a Retry-After header (seconds or HTTP date) into ms, else 0. */
function retryAfterMs(error) {
  const raw = error?.response?.headers?.['retry-after'];
  if (raw == null) {
    return 0;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(raw) - Date.now();
  return Number.isFinite(dateMs) && dateMs > 0 ? dateMs : 0;
}

/**
 * §5.3 backoff: Retry-After is a floor plus full-jitter bounded exponential;
 * otherwise use full jitter alone. attempt is the CURRENT attempt count (≥1
 * after a claim).
 * @param {{ attempt: number, retryAfter?: number, baseMs: number, maxMs: number, now?: Date }} params
 * @returns {Date}
 */
function computeNextAttemptAt({ attempt, retryAfter = 0, baseMs, maxMs, now = new Date() }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(crypto.randomInt(0, Math.max(1, ceiling)));
  // Cap the provider's Retry-After at the backoff max: a hostile/bogus value
  // (e.g. `Retry-After: 86400`) must not park a claimed asset a day out.
  const cappedRetryAfter = Math.min(Math.max(0, retryAfter), maxMs);
  const delay = cappedRetryAfter ? Math.min(maxMs, cappedRetryAfter + jitter) : jitter;
  return new Date(now.getTime() + delay);
}

/**
 * KK20-195 review R9 (re-review, F8) — every generation that may hold vectors
 * in RAG for this asset: the active one, the in-flight target, and all recorded
 * cleanup debt. Generation 0 is REAL: the sync/migration path activates as
 * generation 0 (rag_api wrote vectors with no `generation` field), so a final
 * deletion MUST clean it — the earlier `g > 0` filter leaked those vectors.
 * Only null (never written) is excluded; deleting a never-written generation is
 * a harmless no-op because §7.6 delete is idempotent.
 * @param {{ active_generation?: number|null, target_generation?: number|null, stale_generations?: number[] }} asset
 * @returns {number[]}
 */
const generationsToClean = (asset) => [
  ...new Set(
    [asset.active_generation, asset.target_generation, ...(asset.stale_generations ?? [])].filter(
      (g) => g != null,
    ),
  ),
];

/**
 * @param {Object} deps
 * @param {Object} deps.db - createMethods surface
 * @param {{ embedGeneration: Function, deleteGeneration: Function }} deps.ragClient - §7 contract
 * @param {(claim: Object) => Promise<{ userId: string, entityId: string } | null>} deps.resolveScope
 *   - persisted retrieval scope (plan §9.1: never reconstructed from a request)
 * @param {(asset_id: string) => Promise<unknown>} deps.markFilesEmbedded
 *   - flips File.embedded=true in lockstep with activation (WP2c projection rule)
 * @param {{ info: Function, warn: Function, error: Function }} deps.logger
 * @param {string} [deps.workerId]
 * @returns {{ processNextDue: Function, executeClaim: Function, start: Function, stop: Function }}
 */
function createIndexingWorker({
  db,
  ragClient,
  resolveScope,
  markFilesEmbedded,
  logger,
  workerId,
  // KK20-195 review R11 — optional claim-outcome recorder (prom counter).
  recordClaimOutcome,
}) {
  const id = workerId ?? `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  let stopped = false;

  // KK20-195 review R11 (re-review) — loop liveness for /ready. Progress is
  // EITHER an idle/claim loop tick OR a successful heartbeat during an
  // in-flight claim, so a valid long-running embed/OCR (which blocks the loop
  // in `await processNextDue` but keeps its lease alive) stays healthy instead
  // of flipping /ready to 503. Both go stale only when the loop is truly wedged.
  let lastTickAt = Date.now();
  let lastHeartbeatAt = 0;
  const getLastProgressAt = () => Math.max(lastTickAt, lastHeartbeatAt);

  /**
   * Best-effort: delete ONLY the generation this claim wrote (§7.4/§5.3).
   * KK20-195 review R9 — a failed delete is no longer forgotten: it is
   * persisted as cleanup DEBT (`stale_generations`, token-less additive), so
   * a retry claim's generation bump can't orphan the partial write — the
   * reconciler drains the debt, and final deletion removes listed
   * generations too.
   */
  const cleanupGeneration = async (claim, userId) => {
    try {
      await ragClient.deleteGeneration({
        asset_id: claim.asset_id,
        generation: claim.target_generation,
        vector_backend: claim.vector_backend,
        userId,
      });
      return;
    } catch (error) {
      logger.warn(
        `[indexingWorker:${id}] generation cleanup failed for ${claim.asset_id}:${claim.target_generation}; recording debt: ${error?.message}`,
      );
    }
    // KK20-195 review R9 (re-review, F8) — the delete failed, so persist the
    // generation as cleanup debt for the reconciler to drain. A FALSE return
    // (the asset row is gone ⇒ the update matched nothing) loses that debt just
    // as a throw does: the generation's vectors are then orphaned in RAG with
    // no ledger entry pointing at them. Treat both as failure and alert.
    try {
      const recorded = await db.recordStaleGeneration({
        asset_id: claim.asset_id,
        generation: claim.target_generation,
      });
      if (!recorded) {
        logger.error(
          `[indexingWorker:${id}][alert][cleanup_debt_unrecorded] ${claim.asset_id}:${claim.target_generation}: asset row absent — orphaned generation not recorded`,
        );
      }
    } catch (debtError) {
      logger.error(
        `[indexingWorker:${id}][alert][cleanup_debt_unrecorded] ${claim.asset_id}:${claim.target_generation}: ${debtError?.message}`,
      );
    }
  };

  /** §5.3 failure handling for one claimed asset. Token-fenced throughout. */
  const handleEmbedFailure = async (claim, error, userId) => {
    const config = getWorkerConfig();
    await cleanupGeneration(claim, userId);
    const kind = classifyWorkerError(error);
    const fenced = {
      asset_id: claim.asset_id,
      execution_token: claim.execution_token,
    };
    if (kind === 'permanent') {
      await db.failClaim({
        ...fenced,
        error_code: 'embed_permanent',
        error_detail: error?.message,
      });
      return { outcome: 'failed', kind };
    }
    const cap = kind === 'auth' ? config.authAttemptCap : config.attemptCap;
    if (kind === 'auth') {
      // Configuration/authorization failures page a human immediately —
      // retrying forever would just mask a broken deployment.
      logger.error(
        `[indexingWorker:${id}] auth/config failure embedding ${claim.asset_id} (attempt ${claim.attempt_count}): ${error?.message}`,
      );
    }
    if (claim.attempt_count >= cap) {
      await db.failClaim({
        ...fenced,
        error_code: kind === 'auth' ? 'embed_auth_config' : 'embed_attempts_exhausted',
        error_detail: error?.message,
      });
      return { outcome: 'failed', kind };
    }
    await db.requeueClaim({
      ...fenced,
      error_code: kind === 'auth' ? 'embed_auth_config' : 'embed_retryable',
      next_attempt_at: computeNextAttemptAt({
        attempt: claim.attempt_count,
        retryAfter: retryAfterMs(error),
        baseMs: config.backoffBaseMs,
        maxMs: config.backoffMaxMs,
      }),
    });
    return { outcome: 'requeued', kind };
  };

  /**
   * Execute ONE claimed asset end-to-end: heartbeat → tombstone re-check →
   * RAG write → activation CAS → File.embedded lockstep.
   * @param {Object} claim - the asset document returned by claimNextDue
   * @returns {Promise<{ outcome: string }>}
   */
  const executeClaim = async (claim) => {
    const config = getWorkerConfig();
    let ownershipLost = false;
    const heartbeat = setInterval(() => {
      db.heartbeatClaim({
        asset_id: claim.asset_id,
        execution_token: claim.execution_token,
        leaseMs: config.leaseMs,
      })
        .then((ok) => {
          if (ok) {
            // R11 (re-review) — a live heartbeat is loop progress; it keeps
            // /ready green through a valid long claim that outlasts the
            // idle-tick window.
            lastHeartbeatAt = Date.now();
          } else {
            ownershipLost = true;
          }
        })
        .catch((error) =>
          logger.warn(
            `[indexingWorker:${id}] heartbeat error for ${claim.asset_id}: ${error?.message}`,
          ),
        );
    }, config.heartbeatMs);
    heartbeat.unref?.();

    try {
      // Tombstone re-check before RAG (§5.3 "delete requested"): deletion may
      // have landed between eligibility and now. The tombstone already
      // cleared our token, so no state update is possible or wanted.
      const fresh = await db.getAssetByAssetId(claim.asset_id);
      if (!fresh || fresh.delete_requested_at != null) {
        return { outcome: 'delete_requested' };
      }

      const scope = await resolveScope(claim);
      if (!scope) {
        // KK20-195 review — a null scope is almost always the brief window
        // between markQueued (which makes the asset claimable) and the File-row
        // insert, NOT a true orphan. Requeue with backoff for a bounded number
        // of attempts so that window can close; only a persistently
        // reference-less asset is failed (then owned by the reconciler's
        // orphan-assets case). Permanently failing on the first miss would kill
        // healthy uploads the worker simply claimed too early.
        if (claim.attempt_count < config.attemptCap) {
          await db.requeueClaim({
            asset_id: claim.asset_id,
            execution_token: claim.execution_token,
            error_code: 'scope_unresolved',
            next_attempt_at: computeNextAttemptAt({
              attempt: claim.attempt_count,
              baseMs: config.backoffBaseMs,
              maxMs: config.backoffMaxMs,
            }),
          });
          return { outcome: 'requeued' };
        }
        await db.failClaim({
          asset_id: claim.asset_id,
          execution_token: claim.execution_token,
          error_code: 'scope_unresolved',
        });
        return { outcome: 'failed' };
      }

      try {
        await ragClient.embedGeneration({
          asset_id: claim.asset_id,
          generation: claim.target_generation,
          index_profile: claim.target_index_profile,
          embed_route: claim.embed_route,
          vector_backend: claim.vector_backend,
          blob: claim.blob,
          scope,
        });
      } catch (error) {
        return await handleEmbedFailure(claim, error, scope.userId);
      }

      if (ownershipLost) {
        // §5.2: a lost heartbeat forbids ANY state update; the vectors this
        // worker wrote are staging data under its own generation — remove them.
        await cleanupGeneration(claim, scope.userId);
        return { outcome: 'ownership_lost' };
      }

      let activated;
      try {
        activated = await db.activateGeneration({
          asset_id: claim.asset_id,
          execution_token: claim.execution_token,
          target_generation: claim.target_generation,
          target_index_profile: claim.target_index_profile,
        });
      } catch (error) {
        // KK20-195 review R9 (re-review, F8) — activation threw AFTER embed
        // wrote vectors: without this the written generation leaks (never
        // activated, never cleaned). Clean it (debt-on-failure) before letting
        // the error propagate, so the lease-expiry reclaim starts a fresh
        // generation without orphaning this one.
        await cleanupGeneration(claim, scope.userId);
        throw error;
      }
      if (!activated) {
        // §7.4 activation miss (stale token / tombstone / reclaim): delete
        // only what THIS worker wrote.
        await cleanupGeneration(claim, scope.userId);
        return { outcome: 'activation_miss' };
      }

      // WP2c lockstep: legacy consumers (getToolFilesByIds filters embedded:true)
      // key readiness off File.embedded, so a failed flip leaves a READY asset
      // whose files are silently absent from file_search. Retry a few times;
      // escalate to an alert marker if it persists so a monitor catches the drift.
      let embeddedFlagged = false;
      for (let attempt = 1; attempt <= 3 && !embeddedFlagged; attempt++) {
        try {
          await markFilesEmbedded(claim.asset_id);
          embeddedFlagged = true;
        } catch (error) {
          if (attempt === 3) {
            logger.error(
              `[indexingWorker:${id}][alert][embedded_lockstep_failed] asset ${claim.asset_id} is ready but the File.embedded flip failed after ${attempt} attempts: ${error?.message}`,
            );
          }
        }
      }
      return { outcome: 'ready' };
    } finally {
      clearInterval(heartbeat);
    }
  };

  /** Claim and execute at most one due asset. @returns {Promise<{ outcome: string }>} */
  const processNextDue = async () => {
    const config = getWorkerConfig();
    const claim = await db.claimNextDue({ workerId: id, leaseMs: config.leaseMs });
    if (!claim) {
      return { outcome: 'idle' };
    }
    logger.info(
      `[indexingWorker:${id}] claimed ${claim.asset_id} (attempt ${claim.attempt_count}, generation ${claim.target_generation})`,
    );
    const result = await executeClaim(claim);
    logger.info(`[indexingWorker:${id}] ${claim.asset_id} → ${result.outcome}`);
    return result;
  };

  /**
   * The loop: claim-execute until stopped; idle polls sleep pollMs. SIGTERM
   * semantics (§5.2): `stop()` halts NEW claims immediately; the returned
   * promise resolves once in-flight work finishes. Leases are never released
   * mid-RAG — an unfinished claim simply expires and is reclaimed.
   */
  const start = async () => {
    while (!stopped) {
      lastTickAt = Date.now();
      let outcome = 'idle';
      try {
        ({ outcome } = await processNextDue());
        // R11 — claim outcomes feed the knauf_file_index_worker_claims_total
        // counter (no-op recorder unless the entry wired one).
        if (outcome !== 'idle') {
          recordClaimOutcome?.(outcome);
        }
      } catch (error) {
        logger.error(`[indexingWorker:${id}] loop iteration failed: ${error?.message}`);
      }
      if (stopped) {
        break;
      }
      if (outcome === 'idle') {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, getWorkerConfig().pollMs);
          t.unref?.();
        });
      }
    }
    lastTickAt = Date.now();
    logger.info(`[indexingWorker:${id}] stopped`);
  };

  const stop = () => {
    stopped = true;
  };

  return { processNextDue, executeClaim, start, stop, getLastProgressAt, workerId: id };
}

module.exports = {
  createQueueMetricsSampler,
  createIndexingWorker,
  classifyWorkerError,
  computeNextAttemptAt,
  generationsToClean,
  getWorkerConfig,
};
// End [knauf]
