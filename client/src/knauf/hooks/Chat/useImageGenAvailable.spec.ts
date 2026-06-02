/**
 * [knauf] Seam test for the image-gen visibility policy implemented by
 * `useImageGenAvailable`. Pins the three branches:
 *   - global kill switch: `interface.knauf.imageGen === false` → false.
 *   - custom agent (non-ephemeral agent_id): always false — admin-installed
 *     `image_gen_oai` fires unconditionally on this branch, no chip.
 *   - default-spec (ephemeral or absent agent_id): true iff `spec` is set.
 *
 * The component (`KnaufImageGenTools`) and the ChatForm mount predicate
 * both delegate visibility to this hook, so flipping any branch here
 * flips user-facing behaviour.
 */
import { renderHook } from '@testing-library/react';
import { useImageGenAvailable } from './useImageGenAvailable';

const mockUseGetStartupConfig = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
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

describe('[knauf] useImageGenAvailable', () => {
  beforeEach(() => {
    mockUseGetStartupConfig.mockReset();
  });

  describe('kill switch', () => {
    it('returns false when interface.knauf.imageGen === false (custom-agent path)', () => {
      withInterface(false);
      const { result } = renderHook(() =>
        useImageGenAvailable({ agentId: 'agent-x', spec: 'karl' }),
      );
      expect(result.current).toBe(false);
    });

    it('returns false when interface.knauf.imageGen === false (default-spec path)', () => {
      withInterface(false);
      const { result } = renderHook(() => useImageGenAvailable({ agentId: null, spec: 'karl' }));
      expect(result.current).toBe(false);
    });
  });

  describe('custom-agent branch (non-ephemeral agentId)', () => {
    it('returns false regardless of stored tools (no chip on custom agents)', () => {
      withInterface(undefined);
      const { result } = renderHook(() => useImageGenAvailable({ agentId: 'agent-x' }));
      expect(result.current).toBe(false);
    });

    it('returns false even when spec is also set (custom agent wins)', () => {
      withInterface(undefined);
      const { result } = renderHook(() =>
        useImageGenAvailable({ agentId: 'agent-x', spec: 'karl' }),
      );
      expect(result.current).toBe(false);
    });
  });

  describe('default-spec branch (no custom agent)', () => {
    it('returns true when spec is set and agentId is absent', () => {
      withInterface(undefined);
      const { result } = renderHook(() => useImageGenAvailable({ agentId: null, spec: 'karl' }));
      expect(result.current).toBe(true);
    });

    it('returns true when spec is set and agentId is the ephemeral marker', () => {
      withInterface(undefined);
      const { result } = renderHook(() =>
        useImageGenAvailable({ agentId: 'ephemeral', spec: 'karl' }),
      );
      expect(result.current).toBe(true);
    });

    it('returns false when no spec and no custom agent (off-spec chat)', () => {
      withInterface(undefined);
      const { result } = renderHook(() => useImageGenAvailable({ agentId: null, spec: null }));
      expect(result.current).toBe(false);
    });
  });

  describe('interface flag undefined', () => {
    it('treats missing imageGen flag as enabled (default-spec branch)', () => {
      mockUseGetStartupConfig.mockReturnValue({ data: { interface: { knauf: {} } } });
      const { result } = renderHook(() => useImageGenAvailable({ agentId: null, spec: 'karl' }));
      expect(result.current).toBe(true);
    });
  });
});
