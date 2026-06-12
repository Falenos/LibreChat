/**
 * [knauf] KnaufAccessDenied
 *
 * Full-page screen shown after Okta login when the user's email is not
 * on the migration allowlist. Explains that access is not yet available
 * and offers a link back to the current Karl (karl.knauf.com).
 */
import React from 'react';

const OLD_KARL_URL = 'https://karl.knauf.com';

export default function KnaufAccessDenied() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-primary px-6 text-center">
      <img
        src="/assets/knauf-logo.png"
        alt="Knauf"
        className="mb-10 h-10 w-auto object-contain"
      />

      <h1 className="mb-4 text-2xl font-semibold text-text-primary">
        Access not yet available
      </h1>

      <p className="mb-2 max-w-md text-text-secondary">
        Your account does not have access to the new Agentic Karl platform yet.
      </p>
      <p className="mb-8 max-w-md text-text-secondary">
        Access is being rolled out in batches. You will be notified when your account is enabled.
      </p>

      <a
        href={OLD_KARL_URL}
        className="rounded-md bg-surface-active px-6 py-2.5 text-sm font-medium text-text-primary ring-1 ring-border-medium hover:bg-surface-hover focus:outline-none"
      >
        Go to Karl
      </a>
    </div>
  );
}
// End [knauf]
