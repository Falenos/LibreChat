import { randomBytes } from 'node:crypto';
import { ACA_FILE_MANIFEST_NAME } from '../types/aca.js';
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
const FILE_MANIFEST_MAX_ENTRIES = 100;

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
    'import base64, json, os, pathlib, stat, subprocess, sys, time',
    `os.chdir('/mnt/data')`,
    `for _src, _dst in json.loads(${movesJson}):`,
    `    _p = pathlib.Path('/mnt/data') / _dst`,
    '    _p.parent.mkdir(parents=True, exist_ok=True)',
    `    pathlib.Path('/mnt/data', _src).rename(_p)`,
    `pathlib.Path(${JSON.stringify(userFile)}).write_bytes(base64.b64decode(${JSON.stringify(encoded)}))`,
    `_r = subprocess.run(${argvPrefix} + json.loads(${argsJson}), capture_output=True, cwd='/mnt/data')`,
    `pathlib.Path('/mnt/data/${OUT_LOG}').write_bytes(_r.stdout)`,
    `pathlib.Path('/mnt/data/${ERR_LOG}').write_bytes(_r.stderr)`,
    'try:',
    `    _manifest_path = pathlib.Path('/mnt/data/${ACA_FILE_MANIFEST_NAME}')`,
    '    if _manifest_path.exists() or _manifest_path.is_symlink():',
    '        _manifest_path.unlink()',
    '    _manifest_files = []',
    '    _manifest_truncated = False',
    '    _manifest_deadline = time.monotonic() + 2.0',
    `    for _root, _dirs, _files in os.walk('/mnt/data', followlinks=False):`,
    '        if time.monotonic() > _manifest_deadline:',
    '            _manifest_truncated = True',
    '            break',
    '        _dirs[:] = [d for d in _dirs if not pathlib.Path(_root, d).is_symlink()]',
    '        for _name in _files:',
    `            if len(_manifest_files) >= ${FILE_MANIFEST_MAX_ENTRIES} or time.monotonic() > _manifest_deadline:`,
    '                _manifest_truncated = True',
    '                break',
    '            _path = pathlib.Path(_root, _name)',
    '            try:',
    '                _stat = os.lstat(_path)',
    '            except OSError:',
    '                continue',
    '            if not stat.S_ISREG(_stat.st_mode):',
    '                continue',
    `            _relative = _path.relative_to('/mnt/data').as_posix()`,
    `            if _relative.startswith('.karl_'):`,
    '                continue',
    '            _manifest_files.append({',
    `                'name': _relative,`,
    `                'type': 'File',`,
    `                'sizeInBytes': _stat.st_size,`,
    `                'lastModifiedAt': str(_stat.st_mtime_ns),`,
    '            })',
    '        if _manifest_truncated:',
    '            break',
    `    _manifest_path.write_text(`,
    `        json.dumps({'version': 1, 'truncated': _manifest_truncated, 'files': _manifest_files}),`,
    `        encoding='utf-8',`,
    '    )',
    'except Exception:',
    '    pass',
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
