/**
 * Knauf seam test — SharePoint picker count limit is optional.
 *
 * Pins the `[knauf]` block inside `client/src/hooks/Files/useSharePointPicker.ts`:
 * FileSearch callers can omit `maxSelectionCount`, which omits the Picker v8
 * `selection.maximumCount` field from the generated picker config.
 */
import { act, renderHook } from '@testing-library/react';
import useSharePointPicker from '~/hooks/Files/useSharePointPicker';

const mockShowToast = jest.fn();

jest.mock('recoil', () => ({
  useRecoilState: () => ['en-US'],
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({
    showToast: mockShowToast,
  }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({
    user: {
      provider: 'openid',
    },
  }),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: {
      sharePointBaseUrl: 'https://contoso.sharepoint.com',
      sharePointFilePickerEnabled: true,
    },
  }),
}));

jest.mock('~/hooks/Files/useSharePointToken', () => ({
  __esModule: true,
  default: () => ({
    token: {
      access_token: 'token-1',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'AllSites.Read',
    },
    isLoading: false,
    error: null,
  }),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    lang: { key: 'lang' },
  },
}));

async function openPickerAndReadConfig(maxSelectionCount?: number) {
  const containerNode = document.createElement('div');
  document.body.appendChild(containerNode);
  let submittedAction = '';
  const submitSpy = jest
    .spyOn(HTMLFormElement.prototype, 'submit')
    .mockImplementation(function submit(this: HTMLFormElement) {
      submittedAction = this.action;
    });

  const { result, unmount } = renderHook(() =>
    useSharePointPicker({
      containerNode,
      maxSelectionCount,
    }),
  );

  await act(async () => {
    await result.current.openSharePointPicker();
  });

  const iframe = containerNode.querySelector('iframe') as HTMLIFrameElement;
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: {
      document: document.implementation.createHTMLDocument('sharepoint-picker'),
    },
  });
  act(() => {
    iframe.onload?.call(iframe, new Event('load'));
  });

  const url = new URL(submittedAction);
  const pickerConfig = JSON.parse(url.searchParams.get('filePicker') ?? '{}');

  unmount();
  submitSpy.mockRestore();
  containerNode.remove();

  return pickerConfig;
}

describe('useSharePointPicker — Knauf optional maximumCount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('omits selection.maximumCount when no maxSelectionCount is provided', async () => {
    const pickerConfig = await openPickerAndReadConfig();

    expect(pickerConfig.selection).toEqual({ mode: 'multiple' });
    expect(pickerConfig.selection.maximumCount).toBeUndefined();
  });

  it('keeps selection.maximumCount when a caller explicitly provides one', async () => {
    const pickerConfig = await openPickerAndReadConfig(7);

    expect(pickerConfig.selection.maximumCount).toBe(7);
  });
});
