import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TConversation, TEndpointsConfig } from 'librechat-data-provider';
import ConvoIconURL from '~/components/Endpoints/ConvoIconURL';
import EndpointIcon from '~/components/Endpoints/EndpointIcon';

jest.mock('librechat-data-provider', () => ({
  getEndpointField: jest.fn(() => undefined),
  isAssistantsEndpoint: jest.fn(() => false),
}));

jest.mock('~/components/Endpoints/MinimalIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="minimal-icon" />,
}));

jest.mock('~/hooks/Endpoint/Icons', () => ({
  icons: {
    unknown: () => <div data-testid="unknown-icon" />,
  },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getIconEndpoint: jest.fn(({ endpoint }) => endpoint ?? 'azureOpenAI'),
}));

describe('[knauf] conversation avatars', () => {
  const endpointsConfig = {} as TEndpointsConfig;

  it('renders the local Knauf logo URL as a contained brand avatar', () => {
    render(<ConvoIconURL iconURL="/assets/knauf-logo.png" modelLabel="Karl" />);

    const logo = screen.getByAltText('Knauf');
    expect(logo).toHaveAttribute('src', '/assets/knauf-logo.png');
    expect(logo).toHaveClass('object-contain');
  });

  it('uses the Knauf logo for default-spec conversations in history', () => {
    const conversation = {
      endpoint: 'azureOpenAI',
      spec: 'karl',
    } as TConversation;

    render(<EndpointIcon conversation={conversation} endpointsConfig={endpointsConfig} />);

    const logo = screen.getByAltText('Knauf');
    expect(logo).toHaveAttribute('src', '/assets/knauf-logo.png');
    expect(logo).toHaveClass('h-3');
    expect(logo).toHaveClass('w-7');
    expect(screen.queryByTestId('minimal-icon')).not.toBeInTheDocument();
  });

  it('uses the Knauf logo for agent conversations without a custom icon URL', () => {
    const conversation = {
      endpoint: 'agents',
      agent_id: 'agent-karl',
    } as TConversation;

    render(<EndpointIcon conversation={conversation} endpointsConfig={endpointsConfig} />);

    const logo = screen.getByAltText('Knauf');
    expect(logo).toHaveAttribute('src', '/assets/knauf-logo.png');
    expect(logo).toHaveClass('h-3');
    expect(logo).toHaveClass('w-7');
    expect(screen.queryByTestId('minimal-icon')).not.toBeInTheDocument();
  });

  it('keeps upstream endpoint icons for conversations without a Knauf spec marker', () => {
    const conversation = {
      endpoint: 'azureOpenAI',
    } as TConversation;

    render(<EndpointIcon conversation={conversation} endpointsConfig={endpointsConfig} />);

    expect(screen.getByTestId('minimal-icon')).toBeInTheDocument();
    expect(screen.queryByAltText('Knauf')).not.toBeInTheDocument();
  });
});
