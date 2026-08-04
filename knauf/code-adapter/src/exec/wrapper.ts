import { randomBytes } from 'node:crypto';
import type { SupportedLang } from '../validate.js';

/**
 * The exec wrapper solves ACA's two contract gaps at once:
 *  1. no numeric exit code in the executions response  → sentinel carries the real rc
 *  2. ~4000-char stdout truncation on code-interpreter pools → full output teed to
 *     /mnt/data/.karl_out.log / .karl_err.log; inline heads stay under the cap and the
 *     adapter fetches the logs when the byte counts say more exists.
 *
 * User code and args enter the sandbox base64-encoded only (no quoting or heredoc
 * collisions); the sentinel delimiter is per-request random so user output can't spoof it.
 *
 * Inline head budgets keep the whole wrapper output under the ~4000-char cap.
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

function shellQuote(value: string): string {
  const escaped = value.replaceAll("'", "'\\''");
  return `'${escaped}'`;
}

function buildMovePreamble(moves: MoveInstruction[]): string {
  if (moves.length === 0) {
    return '';
  }
  return moves
    .map((m) => {
      const dir = m.to.includes('/') ? m.to.slice(0, m.to.lastIndexOf('/')) : '';
      const from = shellQuote('/mnt/data/' + m.from);
      const to = shellQuote('/mnt/data/' + m.to);
      const mkdir = dir !== '' ? 'mkdir -p ' + shellQuote('/mnt/data/' + dir) + ' && ' : '';
      return `${mkdir}mv ${from} ${to}`;
    })
    .join('\n');
}

export function buildWrapper(
  lang: SupportedLang,
  code: string,
  args: string[],
  moves: MoveInstruction[],
): WrapperPlan {
  const delimiter = `KARL_${randomBytes(6).toString('hex')}`;
  const encoded = b64(code);

  if (lang === 'bash') {
    const quotedArgs = args.map(shellQuote).join(' ');
    const wrappedCode = [
      'cd /mnt/data',
      buildMovePreamble(moves),
      `echo ${shellQuote(encoded)} | base64 -d > /tmp/karl_user.sh`,
      `bash /tmp/karl_user.sh ${quotedArgs} > /mnt/data/${OUT_LOG} 2> /mnt/data/${ERR_LOG}`,
      'KARL_RC=$?',
      `KARL_OUT=$(wc -c < /mnt/data/${OUT_LOG})`,
      `KARL_ERR=$(wc -c < /mnt/data/${ERR_LOG})`,
      `echo "${delimiter} RC=$KARL_RC OUT=$KARL_OUT ERR=$KARL_ERR"`,
      `head -c ${INLINE_OUT_BYTES} /mnt/data/${OUT_LOG}`,
      `echo "${delimiter}_ERR"`,
      `head -c ${INLINE_ERR_BYTES} /mnt/data/${ERR_LOG}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
    return { delimiter, wrappedCode };
  }

  const pyArgs = JSON.stringify(args);
  const pyMoves = JSON.stringify(moves.map((m) => [m.from, m.to]));
  const wrappedCode = [
    'import base64, json, os, pathlib, subprocess, sys',
    `os.chdir('/mnt/data')`,
    `for _src, _dst in json.loads(${JSON.stringify(pyMoves)}):`,
    `    _p = pathlib.Path('/mnt/data') / _dst`,
    '    _p.parent.mkdir(parents=True, exist_ok=True)',
    `    pathlib.Path('/mnt/data', _src).rename(_p)`,
    `pathlib.Path('/tmp/karl_user.py').write_bytes(base64.b64decode(${JSON.stringify(encoded)}))`,
    `_r = subprocess.run([sys.executable, '/tmp/karl_user.py', *json.loads(${JSON.stringify(pyArgs)})], capture_output=True)`,
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
