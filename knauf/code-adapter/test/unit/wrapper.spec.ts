import { describe, expect, it } from 'vitest';
import { buildWrapper, parseSentinel, OUT_LOG } from '../../src/exec/wrapper.js';
import { ACA_FILE_MANIFEST_NAME } from '../../src/types/aca.js';

describe('buildWrapper', () => {
  it('embeds user code base64-only (no raw code in the wrapper)', () => {
    const code = `echo "dangerous 'quote' \`backtick\`"`;
    const plan = buildWrapper('bash', code, [], []);
    expect(plan.wrappedCode).not.toContain('backtick');
    expect(plan.wrappedCode).toContain(Buffer.from(code, 'utf8').toString('base64'));
  });

  it('mints a fresh delimiter per request', () => {
    const a = buildWrapper('bash', 'true', [], []);
    const b = buildWrapper('bash', 'true', [], []);
    expect(a.delimiter).not.toBe(b.delimiter);
    expect(a.delimiter).toMatch(/^KARL_[0-9a-f]{12}$/);
  });

  it('is always a Python wrapper; bash runs via a bash subprocess on the same pool', () => {
    const bash = buildWrapper('bash', 'grep x /etc/hosts', [], []);
    // Python wrapper (goes to /code/execute), not a raw bash script.
    expect(bash.wrappedCode).toContain(
      'import base64, json, os, pathlib, stat, subprocess, sys, time',
    );
    expect(bash.wrappedCode).toContain('[\'bash\', "/tmp/karl_user.sh"]');
    const py = buildWrapper('py', 'print(1)', [], []);
    expect(py.wrappedCode).toContain('[sys.executable, "/tmp/karl_user.py"]');
  });

  it('passes args as a JSON list appended to the argv (subprocess data path, not a shell string)', () => {
    const plan = buildWrapper('bash', 'true', ["a'$(rm -rf /)'b"], []);
    // The adversarial arg reaches the program only as an element of the argv
    // list (subprocess.run(argv) passes it directly to execve) — never
    // interpolated into a shell command line. It rides inside json.loads(...).
    expect(plan.wrappedCode).toContain('json.loads(');
    expect(plan.wrappedCode).toMatch(/subprocess\.run\([^)]*\+ json\.loads\(/);
    // No bash-script redirection syntax — this is a Python wrapper, so the arg
    // is never on a `bash -c` line where $(...) would expand.
    expect(plan.wrappedCode).not.toContain('> /mnt/data/');
  });

  it('streams subprocess output to files and reads only bounded inline heads', () => {
    const plan = buildWrapper('py', 'print("x")', [], []);

    expect(plan.wrappedCode).not.toContain('capture_output=True');
    expect(plan.wrappedCode).toContain('stdout=_out_file, stderr=_err_file');
    expect(plan.wrappedCode).toContain('_out_file.read(3000)');
    expect(plan.wrappedCode).toContain('_err_file.read(700)');
    expect(plan.wrappedCode).not.toContain('.read_bytes()');
  });

  it('renders staged-file moves as python pathlib.rename (works for nested/space paths)', () => {
    const plan = buildWrapper(
      'bash',
      'true',
      [],
      [{ from: '.karl_in_0', to: 'dir with space/out.png' }],
    );
    expect(plan.wrappedCode).toContain('.rename(');
    expect(plan.wrappedCode).toContain('mkdir(parents=True, exist_ok=True)');
    expect(plan.wrappedCode).toContain('dir with space/out.png');
  });
});

describe('parseSentinel', () => {
  const delim = 'KARL_abcdef123456';

  it('parses rc + byte counts + inline heads', () => {
    const poolStdout = `${delim} RC=3 OUT=11 ERR=5\nhello world${delim}_ERR\noops!`;
    const result = parseSentinel(delim, poolStdout);
    expect(result).not.toBeNull();
    expect(result!.rc).toBe(3);
    expect(result!.outBytes).toBe(11);
    expect(result!.errBytes).toBe(5);
    expect(result!.inlineStdout).toBe('hello world');
    expect(result!.inlineStderr).toBe('oops!');
  });

  it('returns null when the sentinel is missing (wrapper degraded)', () => {
    expect(parseSentinel(delim, 'plain output, no sentinel')).toBeNull();
  });

  it('is not spoofable by user output with a different delimiter', () => {
    const poolStdout = `KARL_000000000000 RC=0 OUT=0 ERR=0\n${delim} RC=7 OUT=2 ERR=0\nhi${delim}_ERR\n`;
    const result = parseSentinel(delim, poolStdout);
    expect(result!.rc).toBe(7);
  });

  it('signals truncation via byte counts larger than the inline head', () => {
    const inline = 'x'.repeat(10);
    const poolStdout = `${delim} RC=0 OUT=50000 ERR=0\n${inline}${delim}_ERR\n`;
    const result = parseSentinel(delim, poolStdout)!;
    expect(result.outBytes).toBeGreaterThan(Buffer.byteLength(result.inlineStdout, 'utf8'));
  });
});

describe('log names', () => {
  it('wrapper writes logs the capture layer excludes', () => {
    const plan = buildWrapper('bash', 'true', [], []);
    expect(plan.wrappedCode).toContain(OUT_LOG);
    expect(plan.wrappedCode).toContain(ACA_FILE_MANIFEST_NAME);
    expect(plan.wrappedCode).toContain("os.walk('/mnt/data', followlinks=False)");
    expect(plan.wrappedCode).toContain('stat.S_ISREG');
  });
});
