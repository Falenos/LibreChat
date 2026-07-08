import React from 'react';
import { render, screen } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { TMessageIcon } from '~/common';

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  getEndpointField: jest.fn(() => ''),
}));
jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(() => ({ data: {} })),
}));
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default:
    () =>
    (key: string, values?: Record<number, string>): string =>
      key === 'com_knauf_powered_by_model' ? `Powered by ${values?.[0]}` : key,
}));
jest.mock('~/utils', () => ({
  getIconEndpoint: jest.fn(() => 'agents'),
}));

const iconRenderCount = { current: 0 };

jest.mock('~/components/Endpoints/ConvoIconURL', () => {
  const ConvoIconURL = (props: Record<string, unknown>) => {
    iconRenderCount.current += 1;
    return <div data-testid="convo-icon-url" data-icon-url={props.iconURL as string} />;
  };
  ConvoIconURL.displayName = 'ConvoIconURL';
  return { __esModule: true, default: ConvoIconURL };
});
jest.mock('~/components/Endpoints/Icon', () => {
  const Icon = (props: Record<string, unknown>) => {
    iconRenderCount.current += 1;
    return <div data-testid="icon" data-icon-url={props.iconURL as string} />;
  };
  Icon.displayName = 'Icon';
  return { __esModule: true, default: Icon };
});

import MessageIcon from '../MessageIcon';

const makeAgent = (overrides?: Partial<Agent>): Agent =>
  ({
    id: 'agent_123',
    name: 'GitHub Agent',
    avatar: { filepath: '/images/agent-avatar.png' },
    ...overrides,
  }) as Agent;

const baseIconData: TMessageIcon = {
  endpoint: EModelEndpoint.agents,
  model: 'agent_123',
  iconURL: undefined,
  modelLabel: 'GitHub Agent',
  isCreatedByUser: false,
};

describe('MessageIcon render cycles', () => {
  beforeEach(() => {
    iconRenderCount.current = 0;
  });

  it('renders once on initial mount', () => {
    render(<MessageIcon iconData={baseIconData} agent={makeAgent()} />);
    expect(iconRenderCount.current).toBe(1);
  });

  // [knauf] Pin default Karl message icons to the local Knauf logo asset.
  it('renders the Knauf logo for default Karl assistant messages without a custom avatar', () => {
    const iconData: TMessageIcon = {
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'azure-gpt-runtime',
      iconURL: undefined,
      modelLabel: 'Karl',
      isCreatedByUser: false,
    };

    const { getByTestId, queryByTestId } = render(<MessageIcon iconData={iconData} />);

    expect(getByTestId('convo-icon-url')).toHaveAttribute(
      'data-icon-url',
      '/assets/knauf-logo.png',
    );
    expect(getByTestId('convo-icon-url').parentElement).toHaveAttribute(
      'title',
      'Powered by azure-gpt-runtime',
    );
    expect(queryByTestId('icon')).not.toBeInTheDocument();
  });

  it('does not infer Karl identity from runtime model labels', () => {
    const iconData: TMessageIcon = {
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'azure-deployment-name',
      iconURL: 'https://example.test/chatgpt-icon.svg',
      modelLabel: 'GPT-5.4',
      isCreatedByUser: false,
    };

    const { getByTestId, queryByTestId } = render(<MessageIcon iconData={iconData} />);

    expect(getByTestId('convo-icon-url')).toHaveAttribute(
      'data-icon-url',
      'https://example.test/chatgpt-icon.svg',
    );
    expect(getByTestId('convo-icon-url').parentElement).not.toHaveAttribute('title');
    expect(queryByTestId('icon')).not.toBeInTheDocument();
  });

  it('routes local asset icon URLs through ConvoIconURL', () => {
    const iconData: TMessageIcon = {
      endpoint: EModelEndpoint.azureOpenAI,
      model: 'azure-gpt-runtime',
      iconURL: '/assets/knauf-logo.png',
      modelLabel: 'Karl',
      isCreatedByUser: false,
    };

    const { getByTestId, queryByTestId } = render(<MessageIcon iconData={iconData} />);

    expect(getByTestId('convo-icon-url')).toHaveAttribute(
      'data-icon-url',
      '/assets/knauf-logo.png',
    );
    expect(getByTestId('convo-icon-url').parentElement).toHaveAttribute(
      'title',
      'Powered by azure-gpt-runtime',
    );
    expect(queryByTestId('icon')).not.toBeInTheDocument();
  });

  it('renders the Knauf logo for agent messages without an uploaded avatar', () => {
    const iconData: TMessageIcon = {
      endpoint: EModelEndpoint.agents,
      model: 'agent_123',
      iconURL: undefined,
      modelLabel: 'No Avatar Agent',
      isCreatedByUser: false,
    };

    const { getByTestId, queryByTestId } = render(
      <MessageIcon
        iconData={iconData}
        agent={makeAgent({ name: 'No Avatar Agent', avatar: undefined })}
      />,
    );

    expect(getByTestId('convo-icon-url')).toHaveAttribute(
      'data-icon-url',
      '/assets/knauf-logo.png',
    );
    expect(getByTestId('convo-icon-url').parentElement).not.toHaveAttribute('title');
    expect(queryByTestId('icon')).not.toBeInTheDocument();
  });

  it('keeps legacy string agent avatars instead of treating them as missing', () => {
    const iconData: TMessageIcon = {
      endpoint: EModelEndpoint.agents,
      model: 'agent_123',
      iconURL: undefined,
      modelLabel: 'Legacy Avatar Agent',
      isCreatedByUser: false,
    };

    const { getByTestId, queryByTestId } = render(
      <MessageIcon
        iconData={iconData}
        agent={makeAgent({
          name: 'Legacy Avatar Agent',
          // Legacy string avatar (pre-AgentAvatar-object) — this test asserts it still renders.
          avatar: '/images/legacy-avatar.png' as unknown as Agent['avatar'],
        })}
      />,
    );

    expect(getByTestId('icon')).toHaveAttribute('data-icon-url', '/images/legacy-avatar.png');
    expect(queryByTestId('convo-icon-url')).not.toBeInTheDocument();
  });
  // End [knauf]

  it('renders same-origin absolute model spec icon URLs directly', () => {
    render(
      <MessageIcon
        iconData={{
          ...baseIconData,
          iconURL: '/assets/clickhouse-logo.svg',
        }}
      />,
    );

    expect(screen.getByTestId('convo-icon-url')).toHaveAttribute(
      'data-icon-url',
      '/assets/clickhouse-logo.svg',
    );
  });

  it('does not re-render when parent re-renders with same field values but new object references', () => {
    const agent = makeAgent();
    const { rerender } = render(<MessageIcon iconData={baseIconData} agent={agent} />);
    iconRenderCount.current = 0;

    rerender(<MessageIcon iconData={{ ...baseIconData }} agent={makeAgent()} />);

    expect(iconRenderCount.current).toBe(0);
  });

  it('does not re-render when agent object reference changes but name and avatar are the same', () => {
    const agent1 = makeAgent();
    const { rerender } = render(<MessageIcon iconData={baseIconData} agent={agent1} />);
    iconRenderCount.current = 0;

    const agent2 = makeAgent({ id: 'agent_456' });
    rerender(<MessageIcon iconData={baseIconData} agent={agent2} />);

    expect(iconRenderCount.current).toBe(0);
  });

  it('re-renders when agent avatar filepath changes', () => {
    const agent1 = makeAgent();
    const { rerender } = render(<MessageIcon iconData={baseIconData} agent={agent1} />);
    iconRenderCount.current = 0;

    const agent2 = makeAgent({ avatar: { filepath: '/images/new-avatar.png', source: 'local' } });
    rerender(<MessageIcon iconData={baseIconData} agent={agent2} />);

    expect(iconRenderCount.current).toBe(1);
  });

  it('re-renders when agent goes from undefined to defined (name changes from undefined to string)', () => {
    const { rerender } = render(<MessageIcon iconData={baseIconData} agent={undefined} />);
    iconRenderCount.current = 0;

    rerender(<MessageIcon iconData={baseIconData} agent={makeAgent()} />);

    expect(iconRenderCount.current).toBe(1);
  });

  describe('simulates message lifecycle', () => {
    it('renders exactly twice during new message + streaming start: initial render + modelLabel update', () => {
      const initialIconData: TMessageIcon = {
        endpoint: EModelEndpoint.agents,
        model: 'agent_123',
        iconURL: undefined,
        modelLabel: '',
        isCreatedByUser: false,
      };
      const agent = makeAgent();

      const { rerender } = render(<MessageIcon iconData={initialIconData} agent={agent} />);

      const streamingIconData: TMessageIcon = {
        ...initialIconData,
        modelLabel: 'GitHub Agent',
      };

      rerender(<MessageIcon iconData={streamingIconData} agent={agent} />);

      expect(iconRenderCount.current).toBe(2);
    });

    it('does NOT re-render on subsequent streaming chunks (content changes, isSubmitting stays true)', () => {
      const iconData: TMessageIcon = {
        endpoint: EModelEndpoint.agents,
        model: 'agent_123',
        iconURL: undefined,
        modelLabel: 'GitHub Agent',
        isCreatedByUser: false,
      };
      const agent = makeAgent();

      const { rerender } = render(<MessageIcon iconData={iconData} agent={agent} />);
      iconRenderCount.current = 0;

      for (let i = 0; i < 5; i++) {
        rerender(<MessageIcon iconData={{ ...iconData }} agent={makeAgent()} />);
      }

      expect(iconRenderCount.current).toBe(0);
    });

    it('does NOT re-render when agentsMap context updates with same agent data', () => {
      const iconData: TMessageIcon = {
        endpoint: EModelEndpoint.agents,
        model: 'agent_123',
        iconURL: undefined,
        modelLabel: 'GitHub Agent',
        isCreatedByUser: false,
      };

      const agent1 = makeAgent();
      const { rerender } = render(<MessageIcon iconData={iconData} agent={agent1} />);
      iconRenderCount.current = 0;

      const agent2 = makeAgent();
      expect(agent1).not.toBe(agent2);
      rerender(<MessageIcon iconData={iconData} agent={agent2} />);

      expect(iconRenderCount.current).toBe(0);
    });
  });
});
