/**
 * `undici` (transitive dep of `@librechat/agents` and others) references
 * `globalThis.File` from `node:buffer`. Node 20+ exposes it as a global;
 * Node 18 / certain WSL toolchains do not, which surfaces as a
 * `ReferenceError: File is not defined` at module-load time the first
 * time a test imports `@librechat/agents`. Jest under those Node
 * versions blows up before the suite can even start.
 *
 * Pull `File` from `node:buffer` (available since Node 18.x) and assign
 * it onto `globalThis` if missing. Production code never depends on
 * this — the polyfill only activates inside Jest.
 */
if (typeof globalThis.File === 'undefined') {
  try {
    const { File } = require('node:buffer');
    if (File != null) {
      globalThis.File = File;
    }
  } catch {
    // Older Node versions without `node:buffer.File`. LibreChat doesn't
    // support those anyway; let the test fail loudly rather than mask a
    // real environment issue.
  }
}

// [knauf] KK20-257 — represent a correctly-configured code environment by default.
/**
 *
 * `isKnaufCodeExecutionEnabled` (src/knauf/code/codeEnvGuard.ts) strips the
 * `execute_code` capability unless the explicit flag is true and
 * `LIBRECHAT_CODE_BASEURL` points at a host we control, because upstream otherwise
 * defaults the Code API to LibreChat's hosted SaaS. Suites that use `execute_code`
 * as an incidental example of capability
 * plumbing (e.g. endpoints.spec.ts `checkCapability`) would otherwise fail for a
 * reason unrelated to what they assert. `??=` keeps a real value if one is
 * exported; the guard's negative branch is covered explicitly by
 * src/knauf/code/codeEnvGuard.knauf.spec.ts, which sets this var itself.
 */
// Must be an in-cluster shape: the guard is an allowlist, so a `*.test.invalid` host
// would read as external and strip the capability — the very thing this line prevents.
process.env.LIBRECHAT_CODE_BASEURL ??=
  'http://agentic-karl-code-adapter.agentic-karl-test.svc.cluster.local/v1';
process.env.KNAUF_CODE_EXECUTION_ENABLED ??= 'true';
// End [knauf]
