/** SSE streaming event (on_run_step, on_message_delta, etc.) */
export type StreamEvent = {
  event: string;
  data: string | Record<string, unknown>;
};

/** Control event emitted when user message is created and generation starts */
export type CreatedEvent = {
  created: true;
  message: {
    messageId: string;
    parentMessageId?: string;
    conversationId?: string;
    text?: string;
    sender: string;
    isCreatedByUser: boolean;
    /** Quoted excerpts referenced on this turn, carried through resumable job
     *  metadata so reconstructed user messages keep their `MessageQuotes`. */
    quotes?: string[];
  };
  streamId: string;
};

export type FinalMessageFields = {
  messageId?: string;
  parentMessageId?: string;
  conversationId?: string;
  text?: string;
  content?: unknown[];
  sender?: string;
  isCreatedByUser?: boolean;
  unfinished?: boolean;
  /** Per-message error flag — matches TMessage.error (boolean or error text) */
  error?: boolean | string;
  [key: string]: unknown;
};

/** Terminal event emitted when generation completes or is aborted */
export type FinalEvent = {
  final: true;
  requestMessage?: FinalMessageFields | null;
  responseMessage?: FinalMessageFields | null;
  conversation?: { conversationId?: string; [key: string]: unknown } | null;
  title?: string;
  aborted?: boolean;
  earlyAbort?: boolean;
  /** [knauf] KK20-338 — who triggered an aborted final event ('user' Stop button vs.
   *  'system' lifecycle cleanup), so SSE-route telemetry can record system_abort vs
   *  user_abort instead of always assuming user_abort. Only meaningful when aborted
   *  is true; internal-only field, safe for the client to ignore. */
  initiatedBy?: 'user' | 'system';
  runMessages?: FinalMessageFields[];
  /** Top-level event error (abort-during-completion edge case) */
  error?: { message: string };
};

export type ServerSentEvent = StreamEvent | CreatedEvent | FinalEvent;
