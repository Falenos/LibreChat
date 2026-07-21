// [knauf] KK20-195 review R11 (re-review) — the worker's probe surface,
// extracted so the readiness rule and the /metrics mount are unit-testable
// (worker.js is an entry point with heavy side-effecting imports).
//
//   /health   liveness — the process is up.
//   /ready    readiness — Mongo connected AND the claim loop made progress
//             recently. "Progress" = an idle/claim tick OR a live heartbeat
//             during an in-flight claim, so a valid long OCR/embed job does
//             NOT flip readiness to 503 (the R11 first-pass bug).
//   /metrics  the prom scrape endpoint (mounted at /metrics, not /).

const express = require('express');

/**
 * Pure readiness decision.
 * @param {Object} p
 * @param {boolean} p.mongoConnected
 * @param {number} p.lastProgressAgoMs - now - worker.getLastProgressAt()
 * @param {number} p.staleAfterMs - progress older than this ⇒ the loop is wedged
 * @returns {boolean}
 */
function evaluateReadiness({ mongoConnected, lastProgressAgoMs, staleAfterMs }) {
  return mongoConnected && lastProgressAgoMs < staleAfterMs;
}

/**
 * Build the probe Express app.
 * @param {Object} deps
 * @param {() => { ready: boolean, detail: Object }} deps.getReadiness
 * @param {import('express').Router} [deps.metricsRouter] - createMetrics().metricsRouter (serves at its own `/`)
 * @returns {import('express').Express}
 */
function createProbeApp({ getReadiness, metricsRouter }) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => res.status(200).send('ok'));
  app.get('/ready', (_req, res) => {
    const { ready, detail } = getReadiness();
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      ...detail,
    });
  });
  // Mount at /metrics — the router defines GET '/', so use('/metrics', router)
  // serves GET /metrics (mounting at root would expose it at '/' and 404 /metrics).
  if (metricsRouter) {
    app.use('/metrics', metricsRouter);
  }
  return app;
}

module.exports = { evaluateReadiness, createProbeApp };
// End [knauf]
