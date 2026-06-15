/**
 * [knauf] KnaufAccessDenied
 *
 * Full-page screen shown after Okta login when the user's email is not
 * on the migration allowlist, or when the access check itself fails.
 *
 * Props:
 *   errorMode - true when the access check failed (network/DB error).
 *               Shows a "please refresh" message instead of the rollout message.
 */
import React from 'react';

const OLD_KARL_URL = 'https://karl.knauf.com';

interface Props {
  errorMode?: boolean;
}

export default function KnaufAccessDenied({ errorMode = false }: Props) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-primary px-6 text-center">
      <img
        src="/assets/knauf-logo.png"
        alt="Knauf"
        className="mb-10 h-10 w-auto object-contain"
      />

      <h1 className="mb-4 text-2xl font-semibold text-text-primary">
        {errorMode ? 'Unable to verify access' : 'Access not yet available'}
      </h1>

      <p className="mb-8 max-w-md text-text-secondary">
        {errorMode
          ? 'We could not verify your access right now. Please refresh the page or try again shortly.'
          : 'Your account does not have access to the new Agentic Karl platform yet. Access is being rolled out in batches. You will be notified when your account is enabled.'}
      </p>

      {errorMode ? (
        <button
          onClick={() => window.location.reload()}
          className="rounded-md bg-surface-active px-6 py-2.5 text-sm font-medium text-text-primary ring-1 ring-border-medium hover:bg-surface-hover focus:outline-none"
        >
          Refresh
        </button>
      ) : (
        <a
          href={OLD_KARL_URL}
          className="rounded-md bg-surface-active px-6 py-2.5 text-sm font-medium text-text-primary ring-1 ring-border-medium hover:bg-surface-hover focus:outline-none"
        >
          Go to Karl
        </a>
      )}
    </div>
  );
}
// End [knauf]
