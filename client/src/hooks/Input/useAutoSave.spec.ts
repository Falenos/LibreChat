jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: jest.fn(),
}));

jest.mock('~/store', () => ({
  saveDrafts: { key: 'saveDrafts', default: true },
}));

jest.mock('~/Providers', () => ({
  useChatFormContext: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetFiles: jest.fn(),
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  getDraft: jest.fn(),
  setDraft: jest.fn(),
  clearDraft: jest.fn(),
  clearAllDrafts: jest.fn(),
}));

import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useRecoilValue } from 'recoil';
import { useChatFormContext } from '~/Providers';
import { useGetFiles } from '~/data-provider';
import { getDraft, setDraft } from '~/utils';
import store from '~/store';
import { useAutoSave } from '~/hooks';

const mockSetValue = jest.fn();
const mockGetDraft = getDraft as jest.Mock;
const mockSetDraft = setDraft as jest.Mock;

const makeTextAreaRef = (value = '') =>
  ({
    current: { value, addEventListener: jest.fn(), removeEventListener: jest.fn() },
  }) as unknown as React.RefObject<HTMLTextAreaElement>;

beforeEach(() => {
  (useRecoilValue as jest.Mock).mockImplementation((atom) => {
    if (atom === store.saveDrafts) return true;
    return undefined;
  });
  (useChatFormContext as jest.Mock).mockReturnValue({ setValue: mockSetValue });
  (useGetFiles as jest.Mock).mockReturnValue({ data: [] });
  mockGetDraft.mockReturnValue('');
});

describe('useAutoSave — conversation switching', () => {
  it('clears the textarea when switching to a conversation with no draft', () => {
    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useAutoSave({
          conversationId,
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { conversationId: 'convo-1' } },
    );

    act(() => {
      rerender({ conversationId: 'convo-2' });
    });

    expect(mockSetValue).toHaveBeenLastCalledWith('text', '');
  });

  it('restores the saved draft when switching to a conversation with one', () => {
    mockGetDraft.mockImplementation((id: string) => (id === 'convo-2' ? 'Hello, world!' : ''));

    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useAutoSave({
          conversationId,
          textAreaRef: makeTextAreaRef(),
          files: new Map(),
          setFiles: jest.fn(),
        }),
      { initialProps: { conversationId: 'convo-1' } },
    );

    act(() => {
      rerender({ conversationId: 'convo-2' });
    });

    expect(mockSetValue).toHaveBeenLastCalledWith('text', 'Hello, world!');
  });

  it('saves the current textarea content before switching away', () => {
    const textAreaRef = makeTextAreaRef('draft in progress');

    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useAutoSave({ conversationId, textAreaRef, files: new Map(), setFiles: jest.fn() }),
      { initialProps: { conversationId: 'convo-1' } },
    );

    act(() => {
      rerender({ conversationId: 'convo-2' });
    });

    expect(mockSetDraft).toHaveBeenCalledWith({ id: 'convo-1', value: 'draft in progress' });
  });

  // [knauf] KK20-227 — reproduce the response-completion race for a next-turn upload.
  it('preserves files uploaded while the current response is still streaming', () => {
    localStorage.clear();
    const setFiles = jest.fn();
    const pendingFiles = new Map([
      ['pending-file', { file_id: 'pending-file', size: 1024, progress: 0.2 }],
    ]);
    const { rerender } = renderHook(
      ({ isSubmitting, files }) =>
        useAutoSave({
          isSubmitting,
          conversationId: 'convo-1',
          textAreaRef: makeTextAreaRef(),
          files,
          setFiles,
        }),
      { initialProps: { isSubmitting: true, files: new Map() } },
    );

    act(() => {
      rerender({ isSubmitting: true, files: pendingFiles });
    });
    setFiles.mockClear();

    act(() => {
      rerender({ isSubmitting: false, files: pendingFiles });
    });

    expect(setFiles).not.toHaveBeenCalled();
  });
  // End [knauf]
});
