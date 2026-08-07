import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AcaPyResponse, AcaShellResponse } from '../../src/types/aca.js';

/**
 * Pins the response parsers against REAL fixtures captured from live West
 * Europe pools during the KK20-108 spike (Aug 2026). If a future
 * api-version bump changes the shape, refresh test/fixtures/aca/ and these
 * assertions together — this suite is the api-version-churn tripwire.
 *
 * The parse logic lives in src/azure/acaClient.ts (dialects.{py,bash}.parse);
 * here we assert the *fixtures* still match the fields those parsers read, so
 * the tripwire fires without needing to construct a live client.
 */
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'aca');
const load = (name: string): unknown => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

describe('Python pool response shape (/code/execute @ 2024-02-02-preview)', () => {
  it('success: properties.status="Success" + stdout', () => {
    const r = load('execution-success.json') as AcaPyResponse;
    expect(r.properties?.status).toBe('Success');
    expect(r.properties?.stdout).toBe('42\n');
    expect(r.properties?.stderr).toBe('');
  });

  it('failure: properties.status="Failure" + stderr (IPython swallows the real exit code)', () => {
    const r = load('execution-nonzero.json') as AcaPyResponse;
    expect(r.properties?.status).toBe('Failure');
    expect(r.properties?.stderr).toContain('SystemExit');
    // Confirms the design premise: no usable numeric exit code here → the
    // subprocess sentinel wrapper is what recovers it.
  });
});

describe('Shell pool response shape (/executions @ 2025-02-02-preview)', () => {
  it('S1 gate: the Shell image carries python3 + base64 + head + wc + bash', () => {
    const r = load('shell-s1.json') as AcaShellResponse;
    expect(r.status).toBe('0');
    expect(r.result?.stdout).toMatch(/Python 3/);
    expect(r.result?.stdout).toContain('S1-OK');
    for (const tool of ['base64', 'head', 'wc', 'bash']) {
      expect(r.result?.stdout).toContain(`/${tool}`);
    }
  });

  it('native exit code: status carries the real code as a string', () => {
    const r = load('shell-nonzero.json') as AcaShellResponse;
    expect(r.status).toBe('7');
    expect(r.result?.stdout).toBe('out\n');
    expect(r.result?.stderr).toBe('err\n');
    expect(Number(r.status)).toBe(7);
  });

  it('python3 heredoc via shellCommand (the bash_tool traffic pattern) works', () => {
    const r = load('shell-python-heredoc.json') as AcaShellResponse;
    expect(r.status).toBe('0');
    expect(r.result?.stdout).toBe('42\n');
  });
});
