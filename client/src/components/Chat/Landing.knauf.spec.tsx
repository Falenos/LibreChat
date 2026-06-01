/**
 * [knauf] Seam test for the KK20-159 default-spec landing title/subtitle.
 *
 * Pins the behaviour of the new `[knauf]` block in Landing.tsx that
 * sources `name` from `modelSpec.label` and `description` from
 * `modelSpec.description` when no agent/assistant entity is active AND
 * the conversation is on a modelSpec marked `default: true`. The
 * agent-entity branch must keep winning when an agent is selected (no
 * regression).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import Landing from './Landing';

const mockUseChatContext = jest.fn();
const mockUseAgentsMapContext = jest.fn();
const mockUseAssistantsMapContext = jest.fn();
const mockUseGetStartupConfig = jest.fn();
const mockUseGetEndpointsQuery = jest.fn();
const mockUseAuthContext = jest.fn();
const mockGetEntity = jest.fn();

jest.mock('~/Providers', () => ({
  useChatContext: () => mockUseChatContext(),
  useAgentsMapContext: () => mockUseAgentsMapContext(),
  useAssistantsMapContext: () => mockUseAssistantsMapContext(),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => mockUseGetEndpointsQuery(),
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => mockUseAuthContext(),
}));

jest.mock('~/utils', () => ({
  getIconEndpoint: () => 'azureOpenAI',
  getEntity: (args: unknown) => mockGetEntity(args),
}));

jest.mock('~/components/Endpoints/ConvoIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="convo-icon" />,
}));

jest.mock('@librechat/client', () => ({
  __esModule: true,
  BirthdayIcon: () => null,
  TooltipAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SplitText: ({ text }: { text: string }) => <h1 data-testid="split-title">{text}</h1>,
}));

jest.mock('@react-spring/web', () => ({
  easings: { easeOutCubic: 'easeOutCubic' },
}));

function setStartupConfigWithKarlSpec() {
  mockUseGetStartupConfig.mockReturnValue({
    data: {
      modelSpecs: {
        list: [
          {
            name: 'karl',
            label: 'KARL',
            default: true,
            description: 'Knauf AI Platform',
          },
        ],
      },
      interface: {},
    },
  });
}

describe('[knauf] Landing — KK20-159 default-spec title/subtitle', () => {
  beforeEach(() => {
    mockUseChatContext.mockReset();
    mockUseAgentsMapContext.mockReset();
    mockUseAssistantsMapContext.mockReset();
    mockUseGetStartupConfig.mockReset();
    mockUseGetEndpointsQuery.mockReset();
    mockUseAuthContext.mockReset();
    mockGetEntity.mockReset();
    mockUseAgentsMapContext.mockReturnValue({});
    mockUseAssistantsMapContext.mockReturnValue({});
    mockUseGetEndpointsQuery.mockReturnValue({ data: {} });
    mockUseAuthContext.mockReturnValue({ user: { name: 'Tester' } });
  });

  it('renders KARL as title and "Knauf AI Platform" as subtitle on the default spec when no agent is active', () => {
    mockUseChatContext.mockReturnValue({
      conversation: { endpoint: 'azureOpenAI', spec: 'karl' },
    });
    mockGetEntity.mockReturnValue({ entity: null, isAgent: false, isAssistant: false });
    setStartupConfigWithKarlSpec();

    render(<Landing centerFormOnLanding={false} />);

    expect(screen.getByTestId('split-title')).toHaveTextContent('KARL');
    expect(screen.getByText('Knauf AI Platform')).toBeInTheDocument();
  });

  it('keeps the agent-entity branch winning when an agent is selected (no regression)', () => {
    mockUseChatContext.mockReturnValue({
      conversation: { endpoint: 'agents', spec: 'karl', agent_id: 'agent-x' },
    });
    mockGetEntity.mockReturnValue({
      entity: { name: 'Research Bot', description: 'Helps with literature reviews' },
      isAgent: true,
      isAssistant: false,
    });
    setStartupConfigWithKarlSpec();

    render(<Landing centerFormOnLanding={false} />);

    expect(screen.getByTestId('split-title')).toHaveTextContent('Research Bot');
    expect(screen.getByText('Helps with literature reviews')).toBeInTheDocument();
  });

  it('falls back to the greeting branch when the conversation spec is not marked default', () => {
    mockUseChatContext.mockReturnValue({
      conversation: { endpoint: 'azureOpenAI', spec: 'karl-personality-precise' },
    });
    mockGetEntity.mockReturnValue({ entity: null, isAgent: false, isAssistant: false });
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        modelSpecs: {
          list: [
            {
              name: 'karl-personality-precise',
              label: 'Precise',
              default: false,
              description: 'Sticks to facts',
            },
          ],
        },
        interface: { customWelcome: 'Welcome, traveller.' },
      },
    });

    render(<Landing centerFormOnLanding={false} />);

    // The Knauf override only fires on default-marked specs, so neither
    // the spec's label nor its description should appear as the title /
    // subtitle here.
    expect(screen.queryByText('Precise')).not.toBeInTheDocument();
    expect(screen.queryByText('Sticks to facts')).not.toBeInTheDocument();
    // The customWelcome greeting wins instead.
    expect(screen.getByTestId('split-title')).toHaveTextContent('Welcome, traveller.');
  });
});
