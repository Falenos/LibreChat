import { useLocalize } from '~/hooks';

const INCOMPLETE_RESPONSE_ERROR = '{"type":"incomplete_response"}';

export const isIncompleteResponseError = (text: string): boolean =>
  text === INCOMPLETE_RESPONSE_ERROR;

export default function IncompleteResponseWarning() {
  const localize = useLocalize();

  return (
    <div
      role="status"
      aria-live="polite"
      className="my-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100"
    >
      {localize('com_knauf_incomplete_response_warning')}
    </div>
  );
}
