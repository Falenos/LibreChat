import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const KNAUF_CHAT_ASSISTANT_NAME = 'Karl';

type KnaufTimestampValue = string | Date | null | undefined;

export function KnaufMessageHeading({
  isCreatedByUser,
  label,
  fontSize,
  screenReaderPrefix,
}: Readonly<{
  isCreatedByUser?: boolean;
  label?: string;
  fontSize?: string;
  screenReaderPrefix: string;
}>) {
  const localize = useLocalize();
  const visibleLabel = label?.trim() || KNAUF_CHAT_ASSISTANT_NAME;
  const isAssistantTurn = isCreatedByUser !== true;
  const modelLabel = isAssistantTurn ? visibleLabel : '';
  const assistantLabel = isAssistantTurn ? KNAUF_CHAT_ASSISTANT_NAME : visibleLabel;
  const modelTooltip =
    modelLabel && modelLabel !== KNAUF_CHAT_ASSISTANT_NAME
      ? localize('com_knauf_powered_by_model', { 0: modelLabel })
      : undefined;

  return (
    <h2 className={cn('select-none font-semibold text-text-primary', fontSize)}>
      <span className="sr-only">{screenReaderPrefix}</span>
      <span title={modelTooltip}>{assistantLabel}</span>
    </h2>
  );
}

function buildMessageDate(...values: KnaufTimestampValue[]): Date | null {
  const value = values.find(Boolean);
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function KnaufMessageTimestamp({
  clientTimestamp,
  createdAt,
  updatedAt,
}: Readonly<{
  clientTimestamp?: KnaufTimestampValue;
  createdAt?: KnaufTimestampValue;
  updatedAt?: KnaufTimestampValue;
}>) {
  const date = buildMessageDate(createdAt, updatedAt, clientTimestamp);

  if (!date) {
    return null;
  }

  const formatted = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);

  return (
    <time
      dateTime={date.toISOString()}
      title={formatted}
      className="ml-auto shrink-0 select-none whitespace-nowrap px-1 text-[11px] leading-5 text-text-secondary"
    >
      {formatted}
    </time>
  );
}
