import { useEffect } from 'react';

/**
 * [knauf] KK20-227 — warn before a refresh/tab-close while a file upload (and
 * its synchronous server-side RAG/OCR indexing) is still in flight.
 *
 * The chat files Map lives only in in-memory Recoil state (no persistence), so
 * an accidental refresh mid-upload strands that state; the file then re-appears
 * from the server on reload looking uploaded even though its OCR/embedding may
 * have been interrupted or fell back — the confusing "looks OK but processed
 * incomplete" symptom behind KK20-227. The native beforeunload prompt gives the
 * user a chance to cancel the navigation and let uploads finish.
 *
 * `active` should be true whenever any attached file has not reached its
 * terminal (`progress === 1`) state.
 */
export function useUploadBeforeUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy browsers require returnValue to be set to trigger the prompt.
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);
}

export default useUploadBeforeUnloadGuard;
