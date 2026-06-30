import type { ReactNode } from 'react';
import SubRow from '~/components/Chat/Messages/SubRow';
import { KARL_CHAT_ASSISTANT_NAME, isKarlSpecName } from '~/knauf/common/constants';
import { KnaufMessageCost } from '~/knauf/components/Chat/KnaufCostDisplay';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type KnaufTimestampValue = string | Date | null | undefined;

export function KnaufMessageHeading({
  isCreatedByUser,
  isAgent,
  isAssistant,
  label,
  fontSize,
  poweredByModel,
  spec,
  screenReaderPrefix,
}: Readonly<{
  isCreatedByUser?: boolean;
  isAgent?: boolean;
  isAssistant?: boolean;
  label?: string;
  fontSize?: string;
  poweredByModel?: string | null;
  spec?: string | null;
  screenReaderPrefix: string;
}>) {
  const localize = useLocalize();
  const visibleLabel = label?.trim() || KARL_CHAT_ASSISTANT_NAME;
  const runtimeModel = poweredByModel?.trim();
  const isAssistantTurn = isCreatedByUser !== true;
  const isDefaultKarlTurn =
    isAssistantTurn && isAgent !== true && isAssistant !== true && isKarlSpecName(spec);
  const assistantLabel = isDefaultKarlTurn ? KARL_CHAT_ASSISTANT_NAME : visibleLabel;
  const modelTooltip =
    isDefaultKarlTurn && runtimeModel
      ? localize('com_knauf_powered_by_model', { 0: runtimeModel })
      : undefined;

  return (
    <h2 className={cn('select-none font-semibold text-text-primary', fontSize)}>
      <span className="sr-only">{screenReaderPrefix}</span>
      <span title={modelTooltip}>{assistantLabel}</span>
    </h2>
  );
}

export function KnaufMessageActionRow({
  children,
  clientTimestamp,
  createdAt,
  messageId,
  updatedAt,
}: Readonly<{
  children: ReactNode;
  clientTimestamp?: KnaufTimestampValue;
  createdAt?: KnaufTimestampValue;
  messageId?: string | null;
  updatedAt?: KnaufTimestampValue;
}>) {
  return (
    <SubRow classes="w-full items-center justify-between text-xs">
      <div className="flex min-w-0 items-center gap-3">{children}</div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <KnaufMessageCost messageId={messageId} />
        <KnaufMessageTimestamp
          clientTimestamp={clientTimestamp}
          createdAt={createdAt}
          updatedAt={updatedAt}
        />
      </div>
    </SubRow>
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
