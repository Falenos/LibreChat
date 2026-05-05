import { renderHook } from '@testing-library/react';
import { useGetStartupConfig } from '~/data-provider';
import { usePersonalities } from './usePersonalities';

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(),
}));

const mockUseGetStartupConfig = useGetStartupConfig as jest.MockedFunction<
  typeof useGetStartupConfig
>;

describe('usePersonalities', () => {
  it('returns an empty array when startup config has no modelSpecs', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: undefined } as any);
    const { result } = renderHook(() => usePersonalities());
    expect(result.current).toEqual([]);
  });

  it('returns only specs whose name starts with karl-personality-', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        modelSpecs: {
          list: [
            { name: 'karl', label: 'Karl', preset: {} },
            { name: 'karl-personality-balanced', label: 'Balanced', preset: { model: 'gpt-4o' } },
            { name: 'karl-personality-precise', label: 'Precise', preset: {} },
          ],
        },
      },
    } as any);

    const { result } = renderHook(() => usePersonalities());
    expect(result.current).toHaveLength(2);
    expect(result.current.map((p) => p.name)).toEqual([
      'karl-personality-balanced',
      'karl-personality-precise',
    ]);
  });

  it('silently skips specs that fail Zod validation (e.g. missing label)', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        modelSpecs: {
          list: [
            { name: 'karl-personality-valid', label: 'Valid', preset: {} },
            { name: 'karl-personality-no-label', preset: {} },
          ],
        },
      },
    } as any);

    const { result } = renderHook(() => usePersonalities());
    expect(result.current).toHaveLength(1);
    expect(result.current[0].name).toBe('karl-personality-valid');
  });
});
