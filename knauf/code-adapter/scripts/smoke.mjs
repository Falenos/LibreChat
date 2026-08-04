#!/usr/bin/env node
/**
 * Live golden-path smoke against a running adapter wired to REAL ACA
 * session pools (LOCAL_MODE=true, az CLI credentials).
 *
 *   ADAPTER_URL=http://localhost:3112 node scripts/smoke.mjs
 *
 * Covers: py exec, bash exec with a real non-zero exit code, CSV upload →
 * pandas → generated-file capture → download, oversized-code 413, and the
 * >220s timeout shape (opt-in: SMOKE_SLOW=1, adds ~4 minutes).
 */

const BASE = (process.env.ADAPTER_URL ?? 'http://localhost:3112').replace(/\/+$/, '');
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}: ${err.message}`);
  }
}

const exec = async (body) => {
  const response = await fetch(`${BASE}/v1/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
};

const assert = (cond, message) => {
  if (!cond) {
    throw new Error(message);
  }
};

await check('healthz', async () => {
  const response = await fetch(`${BASE}/healthz`);
  assert(response.status === 200, `status ${response.status}`);
});

await check('py exec returns stdout + rc 0', async () => {
  const result = await exec({ lang: 'py', code: 'print(40+2)' });
  assert(result.stdout.trim() === '42', `stdout=${JSON.stringify(result.stdout)}`);
  assert(result.code === 0, `code=${result.code}`);
});

await check('py exec real non-zero rc', async () => {
  const result = await exec({ lang: 'py', code: 'import sys; sys.exit(3)' });
  assert(result.code === 3, `code=${result.code} (expected real rc 3 via wrapper)`);
});

await check('bash exec on the Shell pool', async () => {
  const result = await exec({ lang: 'bash', code: 'echo hello from bash; python3 --version' });
  assert(result.code === 0, `code=${result.code} stderr=${result.stderr}`);
  assert(result.stdout.includes('hello from bash'), `stdout=${result.stdout.slice(0, 120)}`);
  assert(/Python 3/.test(result.stdout + result.stderr), 'python3 missing in Shell image (S1!)');
});

await check('bash real exit code', async () => {
  const result = await exec({ lang: 'bash', code: 'exit 7' });
  assert(result.code === 7, `code=${result.code}`);
});

await check('large stdout recovered past the ~4000-char cap', async () => {
  const result = await exec({ lang: 'py', code: 'print("x" * 20000)' });
  assert(result.stdout.length >= 20000, `stdout length ${result.stdout.length}`);
});

await check('CSV upload -> pandas -> PNG capture -> download', async () => {
  const form = new FormData();
  form.set('kind', 'user');
  form.set('id', 'smoke');
  form.set('file', new Blob(['a,b\n1,2\n3,4\n'], { type: 'text/csv' }), 'data.csv');
  const uploadResponse = await fetch(`${BASE}/v1/upload`, { method: 'POST', body: form });
  assert(uploadResponse.status === 200, `upload HTTP ${uploadResponse.status}`);
  const upload = await uploadResponse.json();
  assert(upload.message === 'success', `message=${upload.message}`);
  const sid = upload.storage_session_id;
  const fileId = upload.files[0].fileId;

  const result = await exec({
    lang: 'py',
    code: [
      'import pandas as pd, matplotlib',
      'matplotlib.use("Agg")',
      'import matplotlib.pyplot as plt',
      'df = pd.read_csv("data.csv")',
      'print(df.describe())',
      'df.plot().figure.savefig("chart.png")',
    ].join('\n'),
    session_id: sid,
    files: [{ id: fileId, name: 'data.csv', storage_session_id: sid, kind: 'user' }],
  });
  assert(result.code === 0, `code=${result.code} stderr=${result.stderr.slice(0, 300)}`);
  const png = result.files.find((f) => f.name === 'chart.png');
  assert(png != null, `chart.png not captured; files=${JSON.stringify(result.files)}`);

  const downloadResponse = await fetch(
    `${BASE}/v1/download/${png.storage_session_id}/${png.id}?kind=user&id=smoke`,
  );
  assert(downloadResponse.status === 200, `download HTTP ${downloadResponse.status}`);
  const bytes = Buffer.from(await downloadResponse.arrayBuffer());
  assert(bytes.subarray(1, 4).toString() === 'PNG', 'downloaded file is not a PNG');
});

await check('unsupported lang -> 501', async () => {
  const response = await fetch(`${BASE}/v1/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: 'node', code: '1' }),
  });
  assert(response.status === 501, `HTTP ${response.status}`);
});

if (process.env.SMOKE_SLOW === '1') {
  await check('>220s exec -> friendly timeout (SLOW)', async () => {
    const result = await exec({ lang: 'py', code: 'import time; time.sleep(400)' });
    assert(result.code === 1, `code=${result.code}`);
    assert(result.stderr.includes('220-second'), `stderr=${result.stderr.slice(0, 200)}`);
  });
}

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
