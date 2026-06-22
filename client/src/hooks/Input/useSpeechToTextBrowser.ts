import { useEffect, useRef, useMemo } from 'react';
import { useRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import useGetAudioSettings from './useGetAudioSettings';
import { useLocalize } from '~/hooks';
import store from '~/store';

const useSpeechToTextBrowser = (
  setText: (text: string) => void,
  onTranscriptionComplete: (text: string) => void,
) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { speechToTextEndpoint } = useGetAudioSettings();
  const isBrowserSTTEnabled = speechToTextEndpoint === 'browser';
  const { data: speechConfig } = useGetCustomConfigSpeechQuery({ enabled: true });
  const sttExternal = Boolean(speechConfig?.sttExternal);

  const lastTranscript = useRef<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>();
  const [autoSendText] = useRecoilState(store.autoSendText);
  const [languageSTT] = useRecoilState<string>(store.languageSTT);
  const [autoTranscribeAudio] = useRecoilState<boolean>(store.autoTranscribeAudio);

  // [knauf] Keep microphone capture active until the user presses the mic button again.
  const KNAUF_KEEP_RECORDING_UNTIL_STOP = true;
  // End [knauf]

  const {
    listening,
    transcript,
    finalTranscript,
    resetTranscript,
    isMicrophoneAvailable,
    browserSupportsSpeechRecognition,
  } = useSpeechRecognition();
  const isListening = useMemo(() => listening, [listening]);

  // [knauf] Show the full live browser transcript (final + interim) while the mic
  // stays open. Using only interim text hides the already-finalized words until
  // the next pause, which makes continuous dictation feel like it is replacing text.
  useEffect(() => {
    if (transcript == null || transcript === '') {
      lastTranscript.current = null;
      return;
    }

    if (lastTranscript.current === transcript) {
      return;
    }

    setText(transcript);
    lastTranscript.current = transcript;
  }, [setText, transcript]);
  // End [knauf]

  // [knauf] Text display is handled by the live `transcript` effect above; this
  // effect only owns delayed auto-send once browser STT marks text as final.
  useEffect(() => {
    if (finalTranscript == null || finalTranscript === '') {
      return;
    }

    if (autoSendText > -1 && finalTranscript.length > 0) {
      timeoutRef.current = setTimeout(() => {
        onTranscriptionComplete(finalTranscript);
        resetTranscript();
      }, autoSendText * 1000);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [onTranscriptionComplete, resetTranscript, finalTranscript, autoSendText]);
  // End [knauf]

  const toggleListening = () => {
    if (!browserSupportsSpeechRecognition) {
      showToast({
        message: sttExternal
          ? localize('com_ui_speech_not_supported_use_external')
          : localize('com_ui_speech_not_supported'),
        status: 'error',
      });
      return;
    }

    if (!isMicrophoneAvailable) {
      showToast({
        message: localize('com_ui_microphone_unavailable'),
        status: 'error',
      });
      return;
    }

    if (isListening === true) {
      SpeechRecognition.stopListening();
    } else {
      // [knauf] Silence should not flip the mic off; user owns the stop action.
      const shouldListenContinuously = KNAUF_KEEP_RECORDING_UNTIL_STOP ? true : autoTranscribeAudio;
      // End [knauf]
      SpeechRecognition.startListening({
        language: languageSTT,
        continuous: shouldListenContinuously,
      });
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.altKey && e.code === 'KeyL' && !isBrowserSTTEnabled) {
        toggleListening();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return {
    isListening,
    isLoading: false,
    startRecording: toggleListening,
    stopRecording: toggleListening,
  };
};

export default useSpeechToTextBrowser;
