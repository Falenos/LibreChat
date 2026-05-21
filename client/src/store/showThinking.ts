import { createStorageAtom } from './jotai-utils';

// [knauf] Default reasoning blocks to expanded on first load (KK20-128). The
// Settings > Chat > Show Thinking toggle still wins via localStorage on
// subsequent visits; this only changes the value users see if they've never
// touched the setting before.
const DEFAULT_SHOW_THINKING = true;
// End [knauf]

/**
 * This atom controls whether AI reasoning/thinking content is expanded by default.
 */
export const showThinkingAtom = createStorageAtom<boolean>('showThinking', DEFAULT_SHOW_THINKING);
