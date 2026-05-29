/**
 * [knauf] Seam test for the image-gen visibility policy implemented by
 * `useImageGenAvailable`. Pins the three branches:
 *   - global kill switch: `interface.knauf.imageGen === false` → false.
 *   - custom agent: returns whether the agent's `tools` includes
 *     `image_gen_oai`.
 *   - default-spec (ephemeral or absent agent_id): true iff `spec` is set.
 *
 * The component (`KnaufImageGenTools`) and the ChatForm mount predicate
 * both delegate visibility to this hook, so flipping any branch here
 * flips user-facing behaviour.
 */
import { renderHook } from '@testing-library/react';
import { useImageGenAvailable } from './useImageGenAvailable';

const mockUseGetStartupConfig = jest.fn();
const mockUseGetAgentByIdQuery = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
  useGetAgentByIdQuery: (id: unknown) => mockUseGetAgentByIdQuery(id),
}));

jest.mock('librechat-data-provider', () => ({
  isEphemeralAgentId: (id: string | null | undefined) =>
    typeof id === 'string' && id.startsWith('ephemeral'),
}));

function withInterface(imageGen: boolean | undefined) {
  mockUseGetStartupConfig.mockReturnValue({
    data: imageGen === undefined ? {} : { interface: { knauf: { imageGen } } },
  });
}

function withAgent(tools?: string[]) {
  mockUseGetAgentByIdQuery.mockReturnValue({
    data: tools === undefined ? undefined : { id: 'agent-x', tools },
  });
}

describe('[knauf] useImageGenAvailable', () => {
  beforeEach(() => {
    mockUseGetStartupConfig.mockReset();
    mockUseGetAgentByIdQuery.mockReset();
  });

  describe('kill switch', () => {
    it('returns false when interface.knauf.imageGen === false (custom agent path)', () => {
      withInterface(false);
      withAgent(['image_gen_oai']);
      const { result } = renderHook(() =>
        useImageGenAvailable({ agentId: 'agent-x', spec: 'karl' }),
      );
      expect(result.current).toBe(false);
    });

    it('returns false when interface.knauf.imageGen === false (default-spec path)', () => {
      withInterface(false);
      withAgent();
      const { result } = renderHook(() => useImageGenAvailable({ agentId: null, spec: 'karl' }));
      expect(result.current).toBe(false);
    });
  });

  describe('custom-agent branch (non-ephemeral agentId)', () => {
    it('returns true when the agent has image_gen_oai in tools', () => {
      withInterface(undefined);
      withAgent(['file_search', 'image_gen_oai']);
      const { result } = renderHook(() => useImageGenAvailable({ agentId: 'agent-x' }));
      expect(result.current).toBe(true);
    });

    it('returns false when the agent has tools but not image_gen_oai', () => {
      withInterface(undefined);
      withAgent(['file_search', 'web_search']);
      const { result } = renderHook(() => useImageGenAvailable({ agentId: 'agent-x' }));
      expect(result.current).toBe(false);
    });

    it('returns false when the agent record has not loaded yet', () => {
      withInterface(undefined);
      withAgent();
      const { result } = renderHook(() => useImageGenAvailable({ agentId: 'agent-x' }));
      expect(result.current).toBe(false);
    });
  });

  describe('default-spec branch (no custom agent)', () => {
    it('returns true when spec is set and agentId is absent', () => {
      withInterface(undefined);
      withAgent();
      const { result } = renderHook(() => useImageGenAvailable({ agentId: null, spec: 'karl' }));
      expect(result.current).toBe(true);
    });

    it('returns true when spec is set and agentId is the ephemeral marker', () => {
      withInterface(undefined);
      withAgent();
      const { result } = renderHook(() =>
        useImageGenAvailable({ agentId: 'ephemeral', spec: 'karl' }),
      );
      expect(result.current).toBe(true);
    });

    it('returns false when no spec and no custom agent (off-spec chat)', () => {
      withInterface(undefined);
      withAgent();
      const { result } = renderHook(() => useImageGenAvailable({ agentId: null, spec: null }));
      expect(result.current).toBe(false);
    });
  });

  describe('interface flag undefined', () => {
    it('treats missing imageGen flag as enabled (default-spec branch)', () => {
      mockUseGetStartupConfig.mockReturnValue({ data: { interface: { knauf: {} } } });
      withAgent();
      const { result } = renderHook(() => useImageGenAvailable({ agentId: null, spec: 'karl' }));
      expect(result.current).toBe(true);
    });

    it('treats missing imageGen flag as enabled (custom-agent branch)', () => {
      mockUseGetStartupConfig.mockReturnValue({ data: { interface: { knauf: {} } } });
      withAgent(['image_gen_oai']);
      const { result } = renderHook(() => useImageGenAvailable({ agentId: 'agent-x' }));
      expect(result.current).toBe(true);
    });
  });
});
