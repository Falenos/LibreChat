import React from 'react';
import { render, screen } from '@testing-library/react';
import AudioRecorder from '~/components/Chat/Input/AudioRecorder';

const mockStartRecording = jest.fn();
const mockStopRecording = jest.fn();

jest.mock('@librechat/client', () => ({
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  ListeningIcon: () => <svg data-testid="listening-icon" />,
  Spinner: () => <svg data-testid="spinner" />,
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useGetAudioSettings: () => ({ speechToTextEndpoint: 'browser' }),
  useLocalize: () => (key: string) => key,
  useSpeechToText: () => ({
    isListening: false,
    isLoading: false,
    startRecording: mockStartRecording,
    stopRecording: mockStopRecording,
  }),
}));

jest.mock('~/utils', () => ({
  cn: (...inputs: Array<string | false | null | undefined>) => inputs.filter(Boolean).join(' '),
}));

describe('AudioRecorder — Knauf mic visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the mic button before the textarea ref is assigned', () => {
    render(
      <AudioRecorder
        disabled={false}
        ask={jest.fn()}
        methods={
          {
            getValues: jest.fn(() => ''),
            reset: jest.fn(),
            setValue: jest.fn(),
          } as never
        }
        isSubmitting={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'com_ui_use_micrphone' })).toBeInTheDocument();
    expect(screen.getByTestId('listening-icon')).toBeInTheDocument();
  });
});
