#!/usr/bin/env node
/**
 * [knauf] KK20-398 — run the document-stack probe (probe-doc-stack.py) in a code sandbox and
 * save its JSON report. Two modes:
 *
 *   Direct to a session pool (no adapter needed; uses your `az login`, which must hold the
 *   "Azure ContainerApps Session Executor" role on the pool):
 *     ACA_POOL_ENDPOINT=https://westeurope.dynamicsessions.io/subscriptions/…/sessionPools/<pool> \
 *       node scripts/probe-doc-stack.mjs > report.json
 *
 *   Through a running adapter (LOCAL_MODE, like smoke.mjs):
 *     ADAPTER_URL=http://localhost:3112 node scripts/probe-doc-stack.mjs > report.json
 *
 * The committed evidence lives in test/fixtures/aca/sandbox-inventory-<date>.json and is
 * summarised in knauf/docs/code-execution/sandbox-inventory.md. Re-run after the pool image
 * changes (Microsoft updates PythonLTS without notice) and diff the reports.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, 'probe-doc-stack.py'), 'utf8');
const REPORT = 'doc-stack-probe.json';
const API = process.env.ACA_API_VERSION ?? '2024-02-02-preview';

async function viaPool(endpoint) {
  const token = execFileSync(
    'az',
    ['account', 'get-access-token', '--resource', 'https://dynamicsessions.io', '--query', 'accessToken', '-o', 'tsv'],
    { encoding: 'utf8' },
  ).trim();
  const id = `karl-probe-${randomBytes(6).toString('hex')}`;
  const auth = { Authorization: `Bearer ${token}` };
  const exec = await fetch(`${endpoint}/code/execute?api-version=${API}&identifier=${id}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { codeInputType: 'inline', executionType: 'synchronous', code },
    }),
  });
  const result = await exec.json();
  if (exec.status !== 200 || result?.properties?.status !== 'Success') {
    throw new Error(`probe exec failed (HTTP ${exec.status}): ${JSON.stringify(result).slice(0, 800)}`);
  }
  const file = await fetch(`${endpoint}/files/content/${REPORT}?api-version=${API}&identifier=${id}`, {
    headers: auth,
  });
  if (file.status !== 200) {
    throw new Error(`report download failed (HTTP ${file.status})`);
  }
  return file.text();
}

async function viaAdapter(base) {
  const exec = await fetch(`${base.replace(/\/+$/, '')}/v1/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: 'py', code: `${code}\nprint(open('/mnt/data/${REPORT}').read())` }),
  });
  const result = await exec.json();
  if (exec.status !== 200 || result.code !== 0) {
    throw new Error(`probe exec failed (HTTP ${exec.status}): ${JSON.stringify(result).slice(0, 800)}`);
  }
  return result.stdout.slice(result.stdout.indexOf('{'));
}

const endpoint = process.env.ACA_POOL_ENDPOINT?.replace(/\/+$/, '');
const adapter = process.env.ADAPTER_URL;
if (!endpoint && !adapter) {
  console.error('Set ACA_POOL_ENDPOINT (direct) or ADAPTER_URL (through the adapter).');
  process.exit(2);
}
const report = endpoint ? await viaPool(endpoint) : await viaAdapter(adapter);
process.stdout.write(`${JSON.stringify(JSON.parse(report), null, 1)}\n`);
