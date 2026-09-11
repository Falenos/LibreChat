import React from 'react';
import { render, screen } from '@testing-library/react';
import { KnaufConversationCostTotal, KnaufMessageCost } from './KnaufCostDisplay';

const mockUseKnaufConversationCosts = jest.fn();

jest.mock('./KnaufCostContext', () => ({
  useKnaufConversationCosts: () => mockUseKnaufConversationCosts(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) => {
    const strings: Record<string, string> = {
      com_knauf_cost_cached_input: 'Cached input tokens: {{0}}',
      com_knauf_cost_conversation_total: 'Conversation total: {{0}}',
      com_knauf_cost_disclaimer:
        'For information only — you are not charged for this usage now or in the future.',
      com_knauf_cost_estimated:
        'Upper-bound estimate using the highest configured Model Router rate.',
      com_knauf_cost_image_tokens: 'Image tokens: {{0}} input / {{1}} output',
      com_knauf_cost_input: 'Input tokens: {{0}}',
      com_knauf_cost_message: 'Message cost: {{0}}',
      com_knauf_cost_model_route: 'Requested → returned: {{0}} → {{1}} — {{2}}',
      com_knauf_cost_model_returned: 'Returned model: {{0}} — {{1}}',
      com_knauf_cost_output: 'Output tokens: {{0}}',
      com_knauf_cost_pricing_pending:
        'Pricing is unavailable for some tokens; the displayed total excludes them.',
      com_knauf_cost_source: 'Rate source: {{0}}',
    };
    return (strings[key] ?? key).replace(/{{(\d+)}}/g, (_, index) => values?.[Number(index)] ?? '');
  },
}));

const summary = {
  cost: 0.1234,
  inputTokens: 1,
  outputTokens: 2,
  cachedInputTokens: 3,
  imageInputTokens: 0,
  imageOutputTokens: 0,
  unsupportedTokens: 0,
  hasUnsupported: false,
  models: [
    {
      cost: 0.1234,
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 3,
      imageInputTokens: 0,
      imageOutputTokens: 0,
      unsupportedTokens: 0,
      hasUnsupported: false,
      returnedModel: 'gpt-5.5-2026-04-24',
      requestedModel: 'model-router-chat',
      pricingModel: 'gpt-5.5',
    },
  ],
};

const data = {
  currency: 'EUR' as const,
  source: 'azure-cost-management-actual-mtd-2026-06-26',
  rates: {},
  conversation: summary,
  messages: {
    message_1: summary,
  },
};

describe('[knauf] KnaufCostDisplay', () => {
  beforeEach(() => {
    mockUseKnaufConversationCosts.mockReset();
  });

  it('renders a per-message cost icon with token split details in the hover label', () => {
    mockUseKnaufConversationCosts.mockReturnValue({
      data,
      refetch: jest.fn(),
      getMessageCost: (messageId: string) => data.messages[messageId] ?? null,
    });

    render(<KnaufMessageCost messageId="message_1" />);

    const icon = screen.getByLabelText(/Message cost:/);
    expect(icon).toHaveAttribute('title', expect.stringContaining('Input tokens: 1'));
    expect(icon).toHaveAttribute(
      'title',
      expect.stringContaining(
        '• For information only — you are not charged for this usage now or in the future.',
      ),
    );
    expect(icon).toHaveAttribute('title', expect.stringContaining('Output tokens: 2'));
    expect(icon).toHaveAttribute(
      'title',
      expect.stringContaining(
        'Requested → returned: model-router-chat → gpt-5.5-2026-04-24 — €0.1234',
      ),
    );
    expect(icon).toHaveAttribute('title', expect.stringContaining(data.source));
  });

  it('renders nothing when a message has no cost signal', () => {
    mockUseKnaufConversationCosts.mockReturnValue({
      data,
      refetch: jest.fn(),
      getMessageCost: () => null,
    });

    const { container } = render(<KnaufMessageCost messageId="missing" />);

    expect(container.innerHTML).toBe('');
  });

  it('shows the conversation total and refreshes after a submission finishes', () => {
    const refetch = jest.fn();
    mockUseKnaufConversationCosts.mockReturnValue({
      data,
      refetch,
      getMessageCost: () => null,
    });

    const { rerender } = render(<KnaufConversationCostTotal isSubmitting={true} />);
    expect(screen.getByLabelText(/Conversation total:/)).toBeInTheDocument();

    rerender(<KnaufConversationCostTotal isSubmitting={false} />);

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a zero conversation total when the cost API has no ledger rows yet', () => {
    mockUseKnaufConversationCosts.mockReturnValue({
      data: {
        ...data,
        conversation: {
          ...summary,
          cost: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
        },
      },
      refetch: jest.fn(),
      getMessageCost: () => null,
    });

    render(<KnaufConversationCostTotal />);

    expect(screen.getByLabelText(/Conversation total:/)).toBeInTheDocument();
    expect(screen.getByText('€0.00')).toBeInTheDocument();
  });

  it('marks totals with unsupported token pricing as partial', () => {
    mockUseKnaufConversationCosts.mockReturnValue({
      data: {
        ...data,
        conversation: {
          ...summary,
          imageInputTokens: 10,
          hasUnsupported: true,
        },
      },
      refetch: jest.fn(),
      getMessageCost: () => null,
    });

    render(<KnaufConversationCostTotal />);

    expect(screen.getByLabelText(/Conversation total:/)).toHaveAttribute(
      'title',
      expect.stringContaining(
        'Pricing is unavailable for some tokens; the displayed total excludes them.',
      ),
    );
    expect(screen.getByText(/\+$/)).toBeInTheDocument();
  });

  it('shows routed-model fallback totals as upper-bound estimates', () => {
    mockUseKnaufConversationCosts.mockReturnValue({
      data: {
        ...data,
        conversation: {
          ...summary,
          isEstimated: true,
        },
      },
      refetch: jest.fn(),
      getMessageCost: () => null,
    });

    render(<KnaufConversationCostTotal />);

    expect(screen.getByText('≤€0.12')).toBeInTheDocument();
    expect(screen.getByLabelText(/Conversation total:/)).toHaveAttribute(
      'title',
      expect.stringContaining('Upper-bound estimate'),
    );
  });
});
