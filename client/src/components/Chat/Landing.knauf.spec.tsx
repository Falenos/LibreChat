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
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
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

jest.mock('lucide-react', () => ({
  EarthIcon: () => <svg data-testid="earth-icon" />,
  FileText: () => <svg data-testid="file-icon" />,
  ImageIcon: () => <svg data-testid="image-icon" />,
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

  it('renders the modelSpec greeting as the title with the Knauf wordmark above it on the default-spec landing', () => {
    mockUseChatContext.mockReturnValue({
      conversation: {
        endpoint: 'azureOpenAI',
        spec: 'karl',
        greeting: 'Hello! I am KARL, your CorporateGPT for the Knauf Group.',
      },
    });
    mockGetEntity.mockReturnValue({ entity: null, isAgent: false, isAssistant: false });
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
        interface: { customWelcome: 'Welcome to Agentic Karl! Enjoy your experience.' },
      },
    });

    render(<Landing centerFormOnLanding={false} />);

    // The preset greeting (long Knauf intro) is the title — customWelcome
    // is suppressed on the default-spec landing.
    expect(screen.getByTestId('split-title')).toHaveTextContent(
      'Hello! I am KARL, your CorporateGPT for the Knauf Group.',
    );
    expect(screen.queryByText(/Welcome to Agentic Karl/)).not.toBeInTheDocument();
    // Knauf wordmark renders above the title (bypasses ConvoIcon).
    const logo = screen.getByAltText('Knauf');
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute('src', '/assets/knauf-logo.png');
    // The capability tiles render below the title, including direct web browsing.
    expect(screen.getByText('com_knauf_landing_capability_files_title')).toBeInTheDocument();
    expect(screen.getByText('com_knauf_landing_capability_images_title')).toBeInTheDocument();
    expect(screen.getByText('com_knauf_landing_capability_web_title')).toBeInTheDocument();
    expect(screen.getByText('com_knauf_landing_capability_web_description')).toBeInTheDocument();
    const capabilityCards = screen.getAllByRole('listitem');
    expect(capabilityCards[0]).toHaveTextContent('com_knauf_landing_capability_web_title');
    expect(capabilityCards[1]).toHaveTextContent('com_knauf_landing_capability_files_title');
    expect(capabilityCards[2]).toHaveTextContent('com_knauf_landing_capability_images_title');
  });

  it('keeps the agent-entity branch winning when an agent is selected (no regression) and does NOT render the Knauf tips', () => {
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
    // Tips are default-spec-only — agent landings shouldn't see them.
    expect(screen.queryByText('com_knauf_landing_capability_files_title')).not.toBeInTheDocument();
    // Knauf wordmark is also default-spec-only — agent landings use ConvoIcon.
    expect(screen.queryByAltText('Knauf')).not.toBeInTheDocument();
  });

  it('does not render the Knauf tips on a non-default spec (e.g. a personality preset)', () => {
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

    // The customWelcome still renders as title via the upstream path.
    expect(screen.getByTestId('split-title')).toHaveTextContent('Welcome, traveller.');
    // The Knauf tips only fire on default-marked specs.
    expect(screen.queryByText('com_knauf_landing_capability_files_title')).not.toBeInTheDocument();
  });
});
