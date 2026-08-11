import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AcaExecutionResponse } from '../../src/types/aca.js';

/**
 * Pins the code-interpreter response parser against REAL fixtures captured from
 * live West Europe pools during the KK20-108 spike (Aug 2026). KARL runs
 * everything on the one code-interpreter pool, so the only response shape the
 * adapter parses at runtime is this one. If a future api-version bump changes
 * it, refresh test/fixtures/aca/ and these assertions together — this suite is
 * the api-version-churn tripwire.
 */
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'aca');
const load = (name: string): AcaExecutionResponse =>
  JSON.parse(readFileSync(join(FIX, name), 'utf8')) as AcaExecutionResponse;

describe('code-interpreter response shape (/code/execute @ 2024-02-02-preview)', () => {
  it('success: properties.status="Success" + stdout', () => {
    const r = load('execution-success.json');
    expect(r.properties?.status).toBe('Success');
    expect(r.properties?.stdout).toBe('42\n');
    expect(r.properties?.stderr).toBe('');
  });

  it('failure: properties.status="Failure" + stderr (IPython swallows the real exit code)', () => {
    const r = load('execution-nonzero.json');
    expect(r.properties?.status).toBe('Failure');
    expect(r.properties?.stderr).toContain('SystemExit');
    // Confirms the design premise: no usable numeric exit code from the pool →
    // the subprocess sentinel wrapper is what recovers it.
  });
});

describe('consolidation proof — the one pool runs both bash and pandas', () => {
  it('the code-interpreter pool has /usr/bin/bash and pandas, reachable from a bash subprocess', () => {
    // This is why we route BOTH lang=py and lang=bash to this single pool and
    // drop the Shell pool (which had no pandas). Captured live via a
    // subprocess.run(['bash', …]) that imports pandas.
    const r = load('code-interpreter-runs-bash-and-pandas.json');
    expect(r.properties?.status).toBe('Success');
    const stdout = r.properties?.stdout ?? '';
    expect(stdout).toContain('/usr/bin/bash');
    expect(stdout).toMatch(/\d+\.\d+\.\d+/); // pandas version printed by the bash->python3 subprocess
  });
});
