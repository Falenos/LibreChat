import React, { useEffect, useMemo, useRef } from 'react';
import { Coins } from 'lucide-react';
import type { ConversationCostSummary } from '~/knauf/data-provider/data-service';
import { useKnaufConversationCosts } from './KnaufCostContext';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type CostTitleLabel = 'com_knauf_cost_message' | 'com_knauf_cost_conversation_total';

function hasCostSignal(summary?: ConversationCostSummary | null) {
  return Boolean(summary && (summary.cost > 0 || summary.hasUnsupported));
}

function formatCurrency(value: number, digits = value > 0 && value < 0.01 ? 4 : 2) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatTokens(value: number) {
  return new Intl.NumberFormat(undefined).format(value);
}

function buildCostTitle({
  label,
  summary,
  source,
  localize,
}: {
  label: CostTitleLabel;
  summary: ConversationCostSummary;
  source?: string;
  localize: ReturnType<typeof useLocalize>;
}) {
  const parts = [
    localize(label, { 0: formatCurrency(summary.cost) }),
    `• ${localize('com_knauf_cost_disclaimer')}`,
  ];

  if (summary.inputTokens > 0) {
    parts.push(localize('com_knauf_cost_input', { 0: formatTokens(summary.inputTokens) }));
  }
  if (summary.outputTokens > 0) {
    parts.push(localize('com_knauf_cost_output', { 0: formatTokens(summary.outputTokens) }));
  }
  if (summary.cachedInputTokens > 0) {
    parts.push(
      localize('com_knauf_cost_cached_input', { 0: formatTokens(summary.cachedInputTokens) }),
    );
  }
  if (summary.imageInputTokens > 0 || summary.imageOutputTokens > 0) {
    parts.push(
      localize('com_knauf_cost_image_tokens', {
        0: formatTokens(summary.imageInputTokens),
        1: formatTokens(summary.imageOutputTokens),
      }),
    );
  }
  if (summary.hasUnsupported) {
    parts.push(localize('com_knauf_cost_pricing_pending'));
  }
  if (summary.isEstimated) {
    parts.push(localize('com_knauf_cost_estimated'));
  }
  for (const model of summary.models ?? []) {
    parts.push(
      model.requestedModel && model.requestedModel !== model.returnedModel
        ? localize('com_knauf_cost_model_route', {
            0: model.requestedModel,
            1: model.returnedModel,
            2: formatCurrency(model.cost, 4),
          })
        : localize('com_knauf_cost_model_returned', {
            0: model.returnedModel,
            1: formatCurrency(model.cost, 4),
          }),
    );
  }
  if (source) {
    parts.push(localize('com_knauf_cost_source', { 0: source }));
  }

  return parts.join('\n');
}

export function KnaufMessageCost({ messageId }: Readonly<{ messageId?: string | null }>) {
  const localize = useLocalize();
  const { data, getMessageCost } = useKnaufConversationCosts();
  const summary = getMessageCost(messageId);

  if (!summary || !hasCostSignal(summary)) {
    return null;
  }

  const title = buildCostTitle({
    label: 'com_knauf_cost_message',
    summary,
    source: data?.source,
    localize,
  });

  return (
    <span
      title={title}
      aria-label={title}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary"
    >
      <Coins className="h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

export function KnaufConversationCostTotal({
  className,
  isSubmitting,
}: Readonly<{
  className?: string;
  isSubmitting?: boolean;
}>) {
  const localize = useLocalize();
  const wasSubmitting = useRef(false);
  const { data, refetch } = useKnaufConversationCosts();
  const summary = data?.conversation;

  useEffect(() => {
    if (wasSubmitting.current && !isSubmitting) {
      void refetch();
    }
    wasSubmitting.current = isSubmitting === true;
  }, [isSubmitting, refetch]);

  const title = useMemo(() => {
    if (!summary) {
      return '';
    }
    return buildCostTitle({
      label: 'com_knauf_cost_conversation_total',
      summary,
      source: data?.source,
      localize,
    });
  }, [data?.source, localize, summary]);

  if (!summary) {
    return null;
  }

  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-text-secondary hover:bg-surface-hover hover:text-text-primary',
        className,
      )}
    >
      <Coins className="h-4 w-4" aria-hidden="true" />
      <span className="tabular-nums">
        {summary.isEstimated ? '≤' : ''}
        {formatCurrency(summary.cost)}
        {summary.hasUnsupported ? '+' : ''}
      </span>
    </span>
  );
}
