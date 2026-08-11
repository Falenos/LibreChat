import { randomBytes } from 'node:crypto';
import type { SupportedLang } from '../validate.js';

/**
 * The exec wrapper. Both languages run on the ONE code-interpreter pool
 * (which has bash + python3 + the data-science stack), so the wrapper is
 * always a **Python** program that runs the user's code — python or bash —
 * as a subprocess. That single shape solves three things at once:
 *  1. no numeric exit code from the pool → the subprocess `returncode` carries it;
 *  2. ~4000-char stdout truncation → full output teed to /mnt/data/.karl_out.log /
 *     .karl_err.log, inline heads stay under the cap, the adapter fetches the logs
 *     when the byte counts say more exists;
 *  3. bash on a Python pool → `subprocess.run(['bash', script])` (the pool has bash).
 *
 * User code and args enter the sandbox base64-encoded only (no quoting/heredoc
 * collisions); the sentinel delimiter is per-request random so user output can't
 * spoof it. Everything runs with cwd=/mnt/data so relative paths resolve.
 */
export const OUT_LOG = '.karl_out.log';
export const ERR_LOG = '.karl_err.log';
const INLINE_OUT_BYTES = 3000;
const INLINE_ERR_BYTES = 700;

export interface WrapperPlan {
  delimiter: string;
  wrappedCode: string;
}

export interface MoveInstruction {
  /** flat name the file was pushed under */
  from: string;
  /** nested relative path the code expects under /mnt/data */
  to: string;
}

export interface SentinelResult {
  rc: number;
  outBytes: number;
  errBytes: number;
  inlineStdout: string;
  inlineStderr: string;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * Build the Python wrapper. `lang` only selects the inner interpreter and the
 * user-code file extension; the wrapper itself is Python for both, submitted to
 * the code-interpreter pool's /code/execute.
 */
export function buildWrapper(
  lang: SupportedLang,
  code: string,
  args: string[],
  moves: MoveInstruction[],
): WrapperPlan {
  const delimiter = `KARL_${randomBytes(6).toString('hex')}`;
  const encoded = b64(code);
  const userFile = lang === 'bash' ? '/tmp/karl_user.sh' : '/tmp/karl_user.py';
  // argv prefix as a Python expression: bash script vs the pool's own python3.
  const argvPrefix =
    lang === 'bash'
      ? `['bash', ${JSON.stringify(userFile)}]`
      : `[sys.executable, ${JSON.stringify(userFile)}]`;
  const argsJson = JSON.stringify(JSON.stringify(args));
  const movesJson = JSON.stringify(JSON.stringify(moves.map((m) => [m.from, m.to])));

  const wrappedCode = [
    'import base64, json, os, pathlib, subprocess, sys',
    `os.chdir('/mnt/data')`,
    `for _src, _dst in json.loads(${movesJson}):`,
    `    _p = pathlib.Path('/mnt/data') / _dst`,
    '    _p.parent.mkdir(parents=True, exist_ok=True)',
    `    pathlib.Path('/mnt/data', _src).rename(_p)`,
    `pathlib.Path(${JSON.stringify(userFile)}).write_bytes(base64.b64decode(${JSON.stringify(encoded)}))`,
    `_r = subprocess.run(${argvPrefix} + json.loads(${argsJson}), capture_output=True, cwd='/mnt/data')`,
    `pathlib.Path('/mnt/data/${OUT_LOG}').write_bytes(_r.stdout)`,
    `pathlib.Path('/mnt/data/${ERR_LOG}').write_bytes(_r.stderr)`,
    `print(f"${delimiter} RC={_r.returncode} OUT={len(_r.stdout)} ERR={len(_r.stderr)}")`,
    `sys.stdout.write(_r.stdout[:${INLINE_OUT_BYTES}].decode('utf-8', 'replace'))`,
    `print("${delimiter}_ERR")`,
    `sys.stdout.write(_r.stderr[:${INLINE_ERR_BYTES}].decode('utf-8', 'replace'))`,
  ].join('\n');
  return { delimiter, wrappedCode };
}

const SENTINEL_RE = (delimiter: string) =>
  new RegExp(`${delimiter} RC=(\\d+) OUT=(\\d+) ERR=(\\d+)\\n?`);

/**
 * Parse the wrapper sentinel out of the pool's stdout. Returns null when
 * the sentinel is missing (wrapper degraded / API drift) — caller falls
 * back to raw stdout + 0/1 synthesis and bumps wrapper_parse_failures.
 */
export function parseSentinel(delimiter: string, poolStdout: string): SentinelResult | null {
  const match = SENTINEL_RE(delimiter).exec(poolStdout);
  if (match == null) {
    return null;
  }
  const after = poolStdout.slice((match.index ?? 0) + match[0].length);
  const errMarker = `${delimiter}_ERR\n`;
  const errMarkerNoNl = `${delimiter}_ERR`;
  let inlineStdout: string;
  let inlineStderr: string;
  const errIdx = after.indexOf(errMarker);
  if (errIdx >= 0) {
    inlineStdout = after.slice(0, errIdx);
    inlineStderr = after.slice(errIdx + errMarker.length);
  } else {
    const errIdx2 = after.indexOf(errMarkerNoNl);
    inlineStdout = errIdx2 >= 0 ? after.slice(0, errIdx2) : after;
    inlineStderr = errIdx2 >= 0 ? after.slice(errIdx2 + errMarkerNoNl.length) : '';
  }
  return {
    rc: Number(match[1]),
    outBytes: Number(match[2]),
    errBytes: Number(match[3]),
    inlineStdout,
    inlineStderr,
  };
}
