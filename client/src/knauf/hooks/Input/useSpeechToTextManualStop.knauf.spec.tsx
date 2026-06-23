import { act, renderHook, waitFor } from '@testing-library/react';
import { useRecoilState } from 'recoil';
import SpeechRecognition from 'react-speech-recognition';
import useSpeechToTextBrowser from '~/hooks/Input/useSpeechToTextBrowser';
import useSpeechToTextExternal from '~/hooks/Input/useSpeechToTextExternal';

let mockSpeechToTextEndpoint = 'browser';
type MockSpeechRecognitionState = {
  listening: boolean;
  transcript: string;
  finalTranscript: string;
  resetTranscript: jest.Mock;
  interimTranscript: string;
  isMicrophoneAvailable: boolean;
  browserSupportsSpeechRecognition: boolean;
};

const mockDefaultSpeechRecognitionState = (): MockSpeechRecognitionState => ({
  listening: false,
  transcript: '',
  finalTranscript: '',
  resetTranscript: jest.fn(),
  interimTranscript: '',
  isMicrophoneAvailable: true,
  browserSupportsSpeechRecognition: true,
});

let mockSpeechRecognitionState = mockDefaultSpeechRecognitionState();

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    autoSendText: 'autoSendText',
    autoTranscribeAudio: 'autoTranscribeAudio',
    decibelValue: 'decibelValue',
    languageSTT: 'languageSTT',
    speechToText: 'speechToText',
  },
}));

jest.mock('recoil', () => ({
  useRecoilState: jest.fn(),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/Input/useGetAudioSettings', () => ({
  __esModule: true,
  default: () => ({ speechToTextEndpoint: mockSpeechToTextEndpoint }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useGetCustomConfigSpeechQuery: jest.fn(() => ({ data: {} })),
}));

jest.mock('~/data-provider', () => ({
  useSpeechToTextMutation: jest.fn(() => ({
    mutate: jest.fn(),
    isLoading: false,
  })),
}));

jest.mock('react-speech-recognition', () => ({
  __esModule: true,
  default: {
    startListening: jest.fn(),
    stopListening: jest.fn(),
  },
  useSpeechRecognition: () => ({
    ...mockSpeechRecognitionState,
  }),
}));

describe('speech-to-text manual stop behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpeechRecognitionState = mockDefaultSpeechRecognitionState();
    (useRecoilState as jest.Mock).mockImplementation((atom) => {
      switch (atom) {
        case 'autoSendText':
          return [-1, jest.fn()];
        case 'languageSTT':
          return ['en-US', jest.fn()];
        case 'autoTranscribeAudio':
          return [true, jest.fn()];
        case 'speechToText':
          return [true, jest.fn()];
        case 'decibelValue':
          return [-45, jest.fn()];
        default:
          return [undefined, jest.fn()];
      }
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts browser recognition in continuous mode until the user stops it', () => {
    mockSpeechToTextEndpoint = 'browser';

    const { result } = renderHook(() => useSpeechToTextBrowser(jest.fn(), jest.fn()));

    act(() => {
      result.current.startRecording();
    });

    expect(SpeechRecognition.startListening).toHaveBeenCalledWith({
      language: 'en-US',
      continuous: true,
    });
  });

  it('stops browser recognition after the manual-stop safety cap', () => {
    jest.useFakeTimers();
    mockSpeechToTextEndpoint = 'browser';

    const { result, unmount } = renderHook(() => useSpeechToTextBrowser(jest.fn(), jest.fn()));

    act(() => {
      result.current.startRecording();
      jest.advanceTimersByTime(10 * 60 * 1000);
    });

    expect(SpeechRecognition.stopListening).toHaveBeenCalled();

    unmount();
  });

  it('keeps finalized browser transcript visible while appending interim words', async () => {
    mockSpeechToTextEndpoint = 'browser';
    const setText = jest.fn();
    mockSpeechRecognitionState = {
      ...mockDefaultSpeechRecognitionState(),
      transcript: 'hello',
      finalTranscript: 'hello',
    };

    const { rerender } = renderHook(() => useSpeechToTextBrowser(setText, jest.fn()));

    await waitFor(() => expect(setText).toHaveBeenLastCalledWith('hello'));
    setText.mockClear();

    mockSpeechRecognitionState = {
      ...mockSpeechRecognitionState,
      transcript: 'hello world',
      finalTranscript: 'hello',
      interimTranscript: 'world',
    };
    rerender();

    await waitFor(() => expect(setText).toHaveBeenLastCalledWith('hello world'));
    setText.mockClear();

    mockSpeechRecognitionState = {
      ...mockSpeechRecognitionState,
      finalTranscript: 'hello world',
      interimTranscript: '',
    };
    rerender();

    expect(setText).not.toHaveBeenCalled();
  });

  it('does not arm external silence monitoring after recording starts', async () => {
    mockSpeechToTextEndpoint = 'external';

    const requestAnimationFrameSpy = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(jest.fn());
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(jest.fn());

    const mockTrackStop = jest.fn();
    const mockGetUserMedia = jest.fn().mockResolvedValue({
      getTracks: () => [{ stop: mockTrackStop }],
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: mockGetUserMedia },
    });

    const mediaRecorderInstances: Array<{ start: jest.Mock }> = [];

    class MockMediaRecorder extends EventTarget {
      static isTypeSupported = jest.fn(() => true);

      state = 'inactive';
      start = jest.fn(() => {
        this.state = 'recording';
      });

      constructor() {
        super();
        mediaRecorderInstances.push(this);
      }
    }

    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder,
    });
    Object.defineProperty(global, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder,
    });

    const { result } = renderHook(() => useSpeechToTextExternal(jest.fn(), jest.fn()));

    act(() => {
      result.current.externalStartRecording();
    });

    await waitFor(() => expect(mockGetUserMedia).toHaveBeenCalled());
    await waitFor(() => expect(mediaRecorderInstances[0]?.start).toHaveBeenCalledWith(100));

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
  });
});
