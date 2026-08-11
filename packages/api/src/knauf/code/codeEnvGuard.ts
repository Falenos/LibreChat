/**
 * [knauf] KK20-257 — fail-closed guard for the code-execution environment.
 *
 * WHY THIS EXISTS
 * `@librechat/agents` resolves the Code API base URL as
 * `LIBRECHAT_CODE_BASEURL ?? 'https://api.librechat.ai/v1'`
 * (node_modules/@librechat/agents/dist/cjs/tools/CodeExecutor.cjs). That default is
 * LibreChat's **hosted SaaS**. Nothing upstream warns about it, and the AGK namespace
 * allows egress on TCP 443, so an environment that enables the `execute_code`
 * capability without setting `LIBRECHAT_CODE_BASEURL` would silently POST user files —
 * multipart body plus a `User-Id` header — to a third party. With Knauf's tabular
 * auto-routing (KK20-257) that happens at ATTACH time, before the user sends anything.
 *
 * The documented "fast off-switch" of unsetting `LIBRECHAT_CODE_BASEURL` made this
 * worse rather than better: it does not disable code execution, it redirects it to the
 * hosted default. This guard makes that unreachable — unset (or pointed at the hosted
 * default) now means the capability is stripped, which is what operators already
 * believe the variable does.
 *
 * WHAT IT GUARDS
 * `getEndpointsConfig` filters `execute_code` out of `endpoints.agents.capabilities`
 * when this returns false. That single choke point is deliberately upstream of every
 * consumer, so all of them agree without their own checks:
 *   - the served endpoints config → the client's `capabilities.codeEnabled`, which gates
 *     the attach-menu row and Knauf's tabular auto-routing,
 *   - `checkCapability(execute_code)` → the upload gate in Files/process.js, and
 *   - `codeEnvAvailable` → whether `bash_tool`/`read_file` are registered at all.
 *
 * Deliberately NOT validated here: reachability. A wrong-but-internal URL still fails
 * closed at call time with an adapter error; the risk this addresses is data leaving
 * Knauf, not a broken deployment.
 *
 * WHAT COUNTS AS CONFIGURED (review finding A4)
 * An allowlist of in-cluster shapes — see `isControlledHost`. The first version of this
 * guard excluded only `api.librechat.ai`, which meant any *other* external URL still
 * read as configured; a typo or an injected values entry would have shipped user files
 * off-cluster with the guard reporting success. Enumerating what is ours is the only
 * form of this check that matches the sentence above it.
 */
import { logger } from '@librechat/data-schemas';

/** The upstream fallback. Treated as "not configured" — see the module docblock. */
export const LIBRECHAT_HOSTED_CODE_API_HOST = 'api.librechat.ai';

let warned = false;

/** Parsed base URL, or null when it is absent/unparseable. */
function parse(baseUrl: string | undefined): URL | null {
  if (baseUrl == null || baseUrl.trim() === '') {
    return null;
  }
  try {
    return new URL(baseUrl.trim());
  } catch {
    return null;
  }
}

/**
 * Is this hostname one we actually operate?
 *
 * An ALLOWLIST, not a denylist. Excluding only `api.librechat.ai` was the original shape
 * and it did not deliver what this module claims: any other absolute URL — a typo, a
 * copy-paste from a blog post, a hostile value in a values file — passed as "configured",
 * switching on tool registration and the upload gate and sending user files plus a
 * `User-Id` header wherever it pointed. The threat being addressed is user data leaving
 * Knauf, so the check has to enumerate what is inside, not guess at what is outside.
 *
 * The adapter is only ever reached over in-cluster DNS, so the permitted shapes are:
 *   - a bare service name (`agentic-karl-code-adapter`) — single-label, unresolvable
 *     outside the cluster;
 *   - Kubernetes service DNS (`<svc>.<ns>.svc`, `<svc>.<ns>.svc.cluster.local`);
 *   - loopback, for local development.
 * `KNAUF_CODE_ALLOWED_HOSTS` is the escape hatch, so an unforeseen topology is an ops
 * decision recorded in config rather than a reason to weaken this.
 */
function isControlledHost(host: string, env: NodeJS.ProcessEnv): boolean {
  const extra = (env.KNAUF_CODE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  if (extra.includes(host)) {
    return true;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return true;
  }
  // Single-label names cannot resolve outside the cluster.
  if (!host.includes('.')) {
    return true;
  }
  return host.endsWith('.svc') || host.endsWith('.svc.cluster.local');
}

/**
 * True when `LIBRECHAT_CODE_BASEURL` names a host we control, i.e. code execution may
 * be offered. False when it is unset, unparseable, not http(s), or points anywhere
 * outside the cluster — including, but not limited to, the LibreChat-hosted default.
 * Warns once per process so a misconfiguration is visible in logs without spamming.
 */
export function isKnaufCodeEnvConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const url = parse(env.LIBRECHAT_CODE_BASEURL);
  const host = url?.hostname.toLowerCase() ?? null;
  // Scheme is part of the check: `file:`/`gopher:` and friends parse fine and would
  // otherwise be judged only on their (empty) hostname.
  const schemeOk = url != null && (url.protocol === 'http:' || url.protocol === 'https:');
  const configured = host != null && schemeOk && isControlledHost(host, env);

  if (!configured && !warned) {
    warned = true;
    logger.warn(
      `[knauf][code] \`execute_code\` is disabled: LIBRECHAT_CODE_BASEURL is ${reason(url, host)}` +
        '. Point it at the in-cluster Knauf code-adapter to enable code execution. Files are ' +
        'never sent to a sandbox outside Knauf.',
    );
  }

  return configured;
}

/** The specific misconfiguration, so the log line is actionable rather than generic. */
function reason(url: URL | null, host: string | null): string {
  if (url == null || host == null) {
    return 'unset or invalid';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `not an http(s) URL (${url.protocol})`;
  }
  if (host === LIBRECHAT_HOSTED_CODE_API_HOST) {
    return `the LibreChat-hosted default (${host}), which is a third-party service`;
  }
  return (
    `an external host (${host}) — only in-cluster names are accepted ` +
    '(a bare service name, *.svc, *.svc.cluster.local, or loopback). Set ' +
    'KNAUF_CODE_ALLOWED_HOSTS if this host really is ours'
  );
}

/** Test-only: clear the once-per-process warning latch. */
export function _resetKnaufCodeEnvWarning(): void {
  warned = false;
}
