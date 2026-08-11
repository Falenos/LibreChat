import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * [knauf] KK20-257 review F5/F6 — a tripwire on the code CLIENT, not on our code.
 *
 * Two adapter behaviours exist only because of what `@librechat/agents` does and does not
 * do, and a version bump could quietly invalidate either:
 *
 *  - it reads a `session_id` from ToolNode but never puts it in the `/exec` body, so every
 *    execution reaches us without one and gets a fresh sandbox. `runtime_session_hint`
 *    (3.2.65+) is the only continuity field on the wire, and it is sent only when the host
 *    sets `toolExecution.sandbox.statefulSessions = true`;
 *  - it formats `stdout`/`stderr` only and never reads `result.code`, which is why the
 *    adapter writes an explanatory line into stderr for a silent non-zero exit
 *    (`executeOnce`). Remove that and a failing command reads as an empty success.
 *
 * Asserted against the INSTALLED package, so `npm ci` drift surfaces here. The adapter is
 * a standalone package whose own CI does not install the client, so the suite degrades to
 * a loud skip in that context rather than failing for an unrelated reason.
 */
describe('[knauf] locked @librechat/agents code client', () => {
  // Resolved by walking up to the monorepo's node_modules rather than with
  // `require.resolve`: the package's `exports` map does not expose `dist/**`, so subpath
  // resolution fails even though the file is right there.
  const findInNodeModules = (relative: string): string | null => {
    let dir = resolve(process.cwd());
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, 'node_modules', '@librechat', 'agents', relative);
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return null;
  };

  const clientPath = findInNodeModules(join('dist', 'cjs', 'tools', 'CodeExecutor.cjs'));
  const pkgPath = findInNodeModules('package.json');
  const available = clientPath != null && pkgPath != null;

  const src = (): string => readFileSync(clientPath as string, 'utf8');
  const version = (): string =>
    (JSON.parse(readFileSync(pkgPath as string, 'utf8')) as { version: string }).version;

  /** Numeric compare so the 3.2.65 gate does not become a string comparison. */
  const atLeast = (target: string): boolean => {
    const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const [a, b, c] = parse(version());
    const [x, y, z] = parse(target);
    return a! * 1e6 + b! * 1e3 + c! >= x! * 1e6 + y! * 1e3 + z!;
  };

  /**
   * Review finding A6/#7. Every assertion below is `skipIf(!available)`, and the client is
   * NOT a dependency of this package — it resolves out of the monorepo root. So in the
   * adapter's own CI job the whole suite silently skipped and still reported green: the one
   * test written to catch client drift was guarding nothing, which is indistinguishable
   * from it passing. Worse, the 3.2.65 gate below *inverts* its assertion on an older
   * install, so a stale tree made the skip look like a pass.
   *
   * Locally the skip is correct — the adapter is standalone and you may not have the root
   * installed. `KNAUF_REQUIRE_LOCKED_CLIENT=true` is how CI says "the tripwire must be
   * armed"; build-code-adapter.yaml installs the client and sets it.
   */
  it('is armed when CI requires it', () => {
    if (process.env.KNAUF_REQUIRE_LOCKED_CLIENT !== 'true') {
      return;
    }
    expect(
      available,
      '@librechat/agents is not resolvable — install it before running this suite, or the ' +
        'drift assertions below all skip and the suite passes without testing anything',
    ).toBe(true);
    expect(
      atLeast('3.2.65'),
      `installed @librechat/agents is ${version()}, which predates runtime_session_hint ` +
        '(3.2.65) — the continuity assertion would run inverted',
    ).toBe(true);
  });

  it.skipIf(!available)('is inspectable, and reports which build is asserted', () => {
    // eslint-disable-next-line no-console
    console.info(`[knauf] asserting against @librechat/agents ${version()}`);
    expect(src().length).toBeGreaterThan(0);
  });

  it.skipIf(!available)('does NOT send session_id in the /exec body', () => {
    const code = src();
    // It destructures a session id from the tool call...
    expect(code).toMatch(/session_id/);
    // ...but the POST body is assembled without it, which is why the adapter mints a fresh
    // sandbox per execution. A version that starts including it would fail here — at which
    // point session continuity works and `runExec`'s branch order should be revisited.
    const postData = /const postData = \{([\s\S]*?)\};/.exec(code)?.[1] ?? '';
    expect(postData, 'postData block not found — CodeExecutor was restructured').not.toBe('');
    expect(postData).not.toMatch(/session_id/);
  });

  it.skipIf(!available)('never reads result.code — hence the synthesized stderr', () => {
    const code = src();
    expect(code).not.toMatch(/result\.code/);
    // It does format both streams, which is where the adapter's note has to land.
    expect(code).toMatch(/result\.stdout/);
    expect(code).toMatch(/result\.stderr/);
  });

  it.skipIf(!available)('sends runtime_session_hint from 3.2.65 onwards', () => {
    const code = src();
    if (!atLeast('3.2.65')) {
      // Not a silent pass: the installed tree predates the field, so the adapter's
      // continuity path cannot be exercised here. package.json declares ^3.2.65, so this
      // means the local install lags the lockfile — `npm ci` at the repo root fixes it.
      // eslint-disable-next-line no-console
      console.warn(
        `[knauf] installed @librechat/agents ${version()} predates runtime_session_hint ` +
          '(3.2.65); continuity assertion skipped — run `npm ci` at the repo root',
      );
      expect(code).not.toMatch(/postData\.runtime_session_hint/);
      return;
    }
    expect(code).toMatch(/postData\.runtime_session_hint\s*=/);
  });
});
