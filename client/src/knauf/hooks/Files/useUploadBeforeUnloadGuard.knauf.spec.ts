import { renderHook } from '@testing-library/react';
import { useUploadBeforeUnloadGuard } from './useUploadBeforeUnloadGuard';

// [knauf] KK20-227 seam test — the beforeunload guard must register only while an
// upload is in flight and clean up when it settles, so an accidental refresh
// mid-upload is caught (avoids stranding in-memory upload state).

describe('useUploadBeforeUnloadGuard', () => {
  let addSpy: jest.SpyInstance;
  let removeSpy: jest.SpyInstance;

  beforeEach(() => {
    addSpy = jest.spyOn(window, 'addEventListener');
    removeSpy = jest.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('registers no beforeunload handler while inactive', () => {
    renderHook(() => useUploadBeforeUnloadGuard(false));
    expect(addSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('registers a beforeunload handler while active', () => {
    renderHook(() => useUploadBeforeUnloadGuard(true));
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('removes the handler when uploads settle (active → inactive)', () => {
    const { rerender } = renderHook(({ active }) => useUploadBeforeUnloadGuard(active), {
      initialProps: { active: true },
    });
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    rerender({ active: false });
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
  });

  it('prevents the unload (preventDefault + returnValue) so the browser prompts', () => {
    renderHook(() => useUploadBeforeUnloadGuard(true));
    const handler = addSpy.mock.calls.find((call) => call[0] === 'beforeunload')?.[1] as (event: {
      preventDefault: () => void;
      returnValue: unknown;
    }) => void;
    const event = { preventDefault: jest.fn(), returnValue: undefined as unknown };
    handler(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe('');
  });
});
