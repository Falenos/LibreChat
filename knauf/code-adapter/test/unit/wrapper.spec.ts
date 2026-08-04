import { describe, expect, it } from 'vitest';
import { buildWrapper, parseSentinel, OUT_LOG } from '../../src/exec/wrapper.js';

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

  it('shell-quotes args and move targets', () => {
    const plan = buildWrapper(
      'bash',
      'true',
      ["a'$(rm)'b"],
      [{ from: '.karl_in_0', to: 'dir with space/$(evil).png' }],
    );
    expect(plan.wrappedCode).toContain(`'a'\\''$(rm)'\\''b'`);
    expect(plan.wrappedCode).toContain(
      `mv '/mnt/data/.karl_in_0' '/mnt/data/dir with space/$(evil).png'`,
    );
    expect(plan.wrappedCode).toContain(`mkdir -p '/mnt/data/dir with space'`);
  });

  it('python wrapper runs the program as a subprocess with args', () => {
    const plan = buildWrapper('py', 'print(42)', ['--x', '1'], []);
    expect(plan.wrappedCode).toContain('subprocess.run');
    expect(plan.wrappedCode).toContain('karl_user.py');
    expect(plan.wrappedCode).not.toContain('print(42)');
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
  });
});
