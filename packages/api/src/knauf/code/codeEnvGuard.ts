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
 */
import { logger } from '@librechat/data-schemas';

/** The upstream fallback. Treated as "not configured" — see the module docblock. */
export const LIBRECHAT_HOSTED_CODE_API_HOST = 'api.librechat.ai';

let warned = false;

/** Hostname of a base URL, or null when it is absent/unparseable. */
function hostOf(baseUrl: string | undefined): string | null {
  if (baseUrl == null || baseUrl.trim() === '') {
    return null;
  }
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `LIBRECHAT_CODE_BASEURL` names a host we control, i.e. code execution may
 * be offered. False when it is unset, unparseable, or the LibreChat-hosted default.
 * Warns once per process so a misconfiguration is visible in logs without spamming.
 */
export function isKnaufCodeEnvConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const host = hostOf(env.LIBRECHAT_CODE_BASEURL);
  const configured = host != null && host !== LIBRECHAT_HOSTED_CODE_API_HOST;

  if (!configured && !warned) {
    warned = true;
    logger.warn(
      '[knauf][code] `execute_code` is disabled: LIBRECHAT_CODE_BASEURL is ' +
        (host == null ? 'unset or invalid' : `the LibreChat-hosted default (${host})`) +
        '. Point it at the Knauf code-adapter to enable code execution. Files are never ' +
        'sent to a third-party sandbox.',
    );
  }

  return configured;
}

/** Test-only: clear the once-per-process warning latch. */
export function _resetKnaufCodeEnvWarning(): void {
  warned = false;
}
