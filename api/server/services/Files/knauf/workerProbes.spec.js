// [knauf] KK20-195 review R11 (re-review) — the readiness rule and the exact
// /metrics route, unit-tested (worker.js entry is not).
const express = require('express');
const request = require('supertest');
const { evaluateReadiness, createProbeApp } = require('./workerProbes');

describe('evaluateReadiness', () => {
  const staleAfterMs = 90_000; // e.g. max(5*poll, 3*heartbeat)

  test('mongo up + fresh progress → ready', () => {
    expect(
      evaluateReadiness({ mongoConnected: true, lastProgressAgoMs: 1_000, staleAfterMs }),
    ).toBe(true);
  });

  test('a long claim whose heartbeat is recent stays ready (the re-review case)', () => {
    // Loop blocked in embed for 40s, but a heartbeat landed 5s ago.
    expect(
      evaluateReadiness({ mongoConnected: true, lastProgressAgoMs: 5_000, staleAfterMs }),
    ).toBe(true);
  });

  test('mongo down → not ready even if the loop ticked', () => {
    expect(evaluateReadiness({ mongoConnected: false, lastProgressAgoMs: 0, staleAfterMs })).toBe(
      false,
    );
  });

  test('genuinely wedged loop (no progress past the window) → not ready', () => {
    expect(
      evaluateReadiness({ mongoConnected: true, lastProgressAgoMs: 120_000, staleAfterMs }),
    ).toBe(false);
  });
});

describe('createProbeApp routes', () => {
  const metricsRouter = express.Router();
  metricsRouter.get('/', (_req, res) => res.status(200).type('text/plain').send('knauf_metric 1'));

  const build = (ready) =>
    createProbeApp({ getReadiness: () => ({ ready, detail: { mongo: ready } }), metricsRouter });

  test('/health is always 200', async () => {
    const res = await request(build(false)).get('/health');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });

  test('/ready reflects the readiness decision', async () => {
    expect((await request(build(true)).get('/ready')).status).toBe(200);
    const notReady = await request(build(false)).get('/ready');
    expect(notReady.status).toBe(503);
    expect(notReady.body.status).toBe('not_ready');
  });

  test('/metrics serves the router (the exact route — not /)', async () => {
    const app = build(true);
    const metrics = await request(app).get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('knauf_metric');
    // Root is NOT the metrics endpoint (the original mount bug).
    expect((await request(app).get('/')).status).toBe(404);
  });

  test('unknown route → 404', async () => {
    expect((await request(build(true)).get('/nope')).status).toBe(404);
  });
});
// End [knauf]
