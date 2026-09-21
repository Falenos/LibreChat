type RetryConfig = Record<string, unknown> & {
  fallbacks?: unknown;
  maxRetries?: unknown;
};

type StreamFailure = {
  code?: unknown;
  knauf_incomplete_reason?: unknown;
  knauf_output_state?: unknown;
  message?: unknown;
  param?: unknown;
  type?: unknown;
};

type StreamEvent = {
  type?: unknown;
  delta?: unknown;
  refusal?: unknown;
  text?: unknown;
  error?: StreamFailure | null;
  item?: { type?: unknown; content?: unknown };
  part?: { text?: unknown };
  response?: {
    error?: StreamFailure | null;
    incomplete_details?: { reason?: unknown } | null;
  };
};

type RetryDecision = 'retry' | 'not_retryable' | 'unsafe_after_output' | 'cancelled';
type OutputState = 'none' | 'answer_text' | 'activity_only';

const MODEL_ROUTER = 'model-router';
const SAFE_FAILURE_MESSAGE = 'Responses API stream failed';
const RETRYABLE_STREAM_CODES = new Set([
  'rate_limit_exceeded',
  'server_error',
  'vector_store_timeout',
]);
const RETRYABLE_TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const RETRYABLE_TRANSPORT_NAMES = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'TimeoutError',
]);
const SIDE_EFFECT_EVENT_PATTERN =
  /^response\.(?:code_interpreter|custom_tool_call|file_search|function_call|image_generation|local_shell|mcp|shell|tool_search|web_search)_/;
const ANSWER_DELTA_TYPES = new Set(['response.output_text.delta']);
const ACTIVITY_DELTA_TYPES = new Set([
  'response.reasoning.delta',
  'response.reasoning_summary.delta',
  'response.reasoning_summary_text.delta',
  'response.refusal.delta',
]);
const ACTIVITY_DONE_FIELDS = new Map([
  ['response.output_text.done', 'text'],
  ['response.reasoning.done', 'text'],
  ['response.reasoning_summary.done', 'text'],
  ['response.reasoning_summary_text.done', 'text'],
  ['response.refusal.done', 'refusal'],
]);
const ACTIVITY_EVENT_TYPES = new Set(['response.content_part.added', 'response.content_part.done']);
const ACTIVITY_PART_TYPES = new Set([
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
]);

const isModelRouter = (config: RetryConfig): boolean =>
  typeof config.model === 'string' && config.model.toLowerCase().includes(MODEL_ROUTER);

const boundedIdentifier = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

const boundedParameter = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.:[\]-]{1,256}$/.test(value) ? value : undefined;

export function applyKnaufRetryFallback(config: RetryConfig, provider: unknown): void {
  if (Array.isArray(config.fallbacks) && config.fallbacks.length > 0) {
    return;
  }

  const modelRouter = isModelRouter(config);
  if (modelRouter && (typeof config.maxRetries !== 'number' || config.maxRetries <= 0)) {
    return;
  }

  const { provider: _provider, fallbacks: _fallbacks, ...retryClientOptions } = config;
  if (modelRouter) {
    config.maxRetries = 0;
    retryClientOptions.maxRetries = 0;
  }
  config.fallbacks = [{ provider, clientOptions: retryClientOptions }];
}

export function disableKnaufRetryFallback(config: RetryConfig): void {
  if (Array.isArray(config.fallbacks)) {
    config.fallbacks.splice(0);
  }
}

export function preserveRetryForHttpStatus(config: RetryConfig, status: number): void {
  if (status >= 200 && status < 300) {
    return;
  }
  if (status === 408 || status === 429 || status >= 500) {
    return;
  }
  disableKnaufRetryFallback(config);
}

const getData = (frame: string): string | undefined =>
  frame
    .split(/\r?\n/)
    .find((line) => line.startsWith('data:'))
    ?.slice(5)
    .trim();

const hasNonblankItemContent = (content: unknown): boolean => {
  if (!Array.isArray(content)) {
    return true;
  }
  return content.some((part) => {
    if (part == null || typeof part !== 'object') {
      return true;
    }
    if ('text' in part) {
      return typeof part.text !== 'string' || part.text.trim().length > 0;
    }
    if ('refusal' in part) {
      return typeof part.refusal !== 'string' || part.refusal.trim().length > 0;
    }
    return true;
  });
};

const classifyOutputItem = (item: StreamEvent['item']): OutputState => {
  if (item?.type === 'message') {
    // The installed LangChain adapter persists output_text.delta, but not message
    // output_item.done content. Terminal text is replay-unsafe activity unless a
    // preceding delta already established answer_text.
    return hasNonblankItemContent(item.content) ? 'activity_only' : 'none';
  }
  return typeof item?.type === 'string' ? 'activity_only' : 'none';
};

const mergeOutputState = (current: OutputState, next: OutputState): OutputState => {
  if (current === 'answer_text' || next === 'answer_text') {
    return 'answer_text';
  }
  return current === 'activity_only' || next === 'activity_only' ? 'activity_only' : 'none';
};

const classifyTextValue = (
  value: unknown,
  nonblankState: Exclude<OutputState, 'none'>,
): OutputState => {
  if (typeof value !== 'string') {
    return 'activity_only';
  }
  return value.trim().length === 0 ? 'none' : nonblankState;
};

const classifyAddedOutputItem = (item: StreamEvent['item']): OutputState =>
  typeof item?.type === 'string' && item.type !== 'message' ? 'activity_only' : 'none';

const classifyEventOutput = (event: StreamEvent): OutputState => {
  const type = typeof event.type === 'string' ? event.type : '';
  if (ANSWER_DELTA_TYPES.has(type)) {
    return classifyTextValue(event.delta, 'answer_text');
  }
  if (ACTIVITY_DELTA_TYPES.has(type)) {
    return classifyTextValue(event.delta, 'activity_only');
  }
  const activityDoneField = ACTIVITY_DONE_FIELDS.get(type);
  if (activityDoneField != null) {
    return classifyTextValue(event[activityDoneField as keyof StreamEvent], 'activity_only');
  }
  if (ACTIVITY_EVENT_TYPES.has(type)) {
    return 'activity_only';
  }
  if (ACTIVITY_PART_TYPES.has(type)) {
    return classifyTextValue(event.part?.text, 'activity_only');
  }
  if (type === 'response.output_item.done') {
    return classifyOutputItem(event.item);
  }
  if (SIDE_EFFECT_EVENT_PATTERN.test(type)) {
    return 'activity_only';
  }
  if (type === 'response.output_item.added') {
    return classifyAddedOutputItem(event.item);
  }
  return 'none';
};

const getIncompleteReason = (
  event: StreamEvent,
): 'max_output_tokens' | 'content_filter' | 'other' => {
  const reason = event.response?.incomplete_details?.reason;
  if (reason === 'max_output_tokens' || reason === 'content_filter') {
    return reason;
  }
  return 'other';
};

const getFailure = (event: StreamEvent): StreamFailure =>
  event.type === 'response.failed' ? (event.response?.error ?? {}) : (event.error ?? event);

const getDecision = (failure: StreamFailure, replayUnsafe: boolean): RetryDecision => {
  if (replayUnsafe) {
    return 'unsafe_after_output';
  }
  const identifier = boundedIdentifier(failure.code) ?? boundedIdentifier(failure.type);
  return identifier != null && RETRYABLE_STREAM_CODES.has(identifier) ? 'retry' : 'not_retryable';
};

const errorFrame = (
  encoder: TextEncoder,
  failure: StreamFailure,
  decision: RetryDecision,
  outputState: OutputState,
  incompleteReason?: 'content_filter',
): Uint8Array => {
  const code = boundedIdentifier(failure.code) ?? 'stream_terminated';
  const type = boundedIdentifier(failure.type) ?? 'server_error';
  const param = boundedParameter(failure.param);
  return encoder.encode(
    `data: ${JSON.stringify({
      error: {
        message: SAFE_FAILURE_MESSAGE,
        code,
        type,
        ...(param != null && { param }),
        knauf_retry_decision: decision,
        knauf_output_state: outputState,
        ...(incompleteReason != null && { knauf_incomplete_reason: incompleteReason }),
      },
    })}\n\n`,
  );
};

const markRetryDecision = (
  error: unknown,
  decision: RetryDecision,
  outputState: OutputState,
): Error => {
  if (error instanceof Error) {
    Object.assign(error, { knaufRetryDecision: decision, knaufOutputState: outputState });
    return error;
  }
  return Object.assign(new Error(SAFE_FAILURE_MESSAGE), {
    type: 'server_error',
    knaufRetryDecision: decision,
    knaufOutputState: outputState,
  });
};

const getTransportCode = (error: unknown): string | undefined => {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  const value = error as { code?: unknown; cause?: unknown };
  return boundedIdentifier(value.code) ?? getTransportCode(value.cause);
};

const isRetryableTransportError = (error: unknown): boolean => {
  if (error == null || typeof error !== 'object') {
    return false;
  }
  const name = boundedIdentifier((error as { name?: unknown }).name);
  const code = getTransportCode(error);
  return (
    (name != null && RETRYABLE_TRANSPORT_NAMES.has(name)) ||
    (code != null && RETRYABLE_TRANSPORT_CODES.has(code))
  );
};

type StreamGuardState = {
  buffer: string;
  terminalSeen: boolean;
  finalResponseSeen: boolean;
  replayUnsafe: boolean;
  outputState: OutputState;
  deferredDone?: string;
};

type StreamReadResult = {
  done: boolean;
  frames: string[];
};

const readStreamFrames = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  state: StreamGuardState,
): Promise<StreamReadResult> => {
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      state.buffer += decoder.decode();
      const frames = state.buffer === '' ? [] : [state.buffer];
      state.buffer = '';
      return { done: true, frames };
    }

    state.buffer += decoder.decode(chunk.value, { stream: true });
    const frames = state.buffer.split(/\r?\n\r?\n/);
    state.buffer = frames.pop() ?? '';
    if (frames.length > 0) {
      return { done: false, frames };
    }
  }
};

const getTransportDecision = (
  error: unknown,
  state: StreamGuardState,
  isCallerAborted: () => boolean,
  isTransportTimedOut: () => boolean,
): RetryDecision => {
  if (isCallerAborted()) {
    return 'cancelled';
  }
  if (state.replayUnsafe) {
    return 'unsafe_after_output';
  }
  if (isTransportTimedOut() || isRetryableTransportError(error)) {
    return 'retry';
  }
  return 'not_retryable';
};

export function guardModelRouterResponsesStream(
  body: ReadableStream<Uint8Array>,
  {
    disableRetry,
    isCallerAborted = () => false,
    isTransportTimedOut = () => false,
  }: {
    disableRetry: () => void;
    isCallerAborted?: () => boolean;
    isTransportTimedOut?: () => boolean;
  },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: StreamGuardState = {
    buffer: '',
    terminalSeen: false,
    finalResponseSeen: false,
    replayUnsafe: false,
    outputState: 'none',
  };

  const emitFrame = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    frame: string,
  ): void => {
    const data = getData(frame);
    if (data === '[DONE]') {
      state.deferredDone ??= frame;
      return;
    }
    if (data == null) {
      controller.enqueue(encoder.encode(`${frame}\n\n`));
      return;
    }

    try {
      const event = JSON.parse(data) as StreamEvent;
      const eventOutputState = classifyEventOutput(event);
      state.replayUnsafe ||= eventOutputState !== 'none';
      state.outputState = mergeOutputState(state.outputState, eventOutputState);
      if (event.type === 'response.completed') {
        state.terminalSeen = true;
        state.finalResponseSeen = true;
      } else if (event.type === 'response.incomplete') {
        state.terminalSeen = true;
        const incompleteReason = getIncompleteReason(event);
        if (incompleteReason === 'content_filter') {
          state.finalResponseSeen = true;
          const decision = state.replayUnsafe ? 'unsafe_after_output' : 'not_retryable';
          disableRetry();
          controller.enqueue(
            errorFrame(
              encoder,
              { code: 'response_incomplete', type: 'content_filter' },
              decision,
              state.outputState,
              incompleteReason,
            ),
          );
          return;
        }
        state.finalResponseSeen = true;
      } else if (event.type === 'response.failed' || event.type === 'error') {
        state.terminalSeen = true;
        const failure = getFailure(event);
        const decision = getDecision(failure, state.replayUnsafe);
        if (decision !== 'retry') {
          disableRetry();
        }
        controller.enqueue(errorFrame(encoder, failure, decision, state.outputState));
        return;
      }
    } catch {
      // Preserve non-JSON SSE frames unchanged.
    }
    controller.enqueue(encoder.encode(`${frame}\n\n`));
  };

  const finishStream = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (!state.terminalSeen) {
      const decision = state.replayUnsafe ? 'unsafe_after_output' : 'retry';
      if (decision !== 'retry') {
        disableRetry();
      }
      controller.enqueue(
        errorFrame(
          encoder,
          { code: 'stream_terminated', type: 'server_error' },
          decision,
          state.outputState,
        ),
      );
    }
    if (state.deferredDone != null) {
      controller.enqueue(encoder.encode(`${state.deferredDone}\n\n`));
    }
    controller.close();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await readStreamFrames(reader, decoder, state);
        for (const frame of result.frames) {
          emitFrame(controller, frame);
        }
        if (result.done) {
          finishStream(controller);
        }
      } catch (error) {
        if (state.finalResponseSeen) {
          controller.close();
          return;
        }
        const decision = getTransportDecision(error, state, isCallerAborted, isTransportTimedOut);
        if (decision !== 'retry') {
          disableRetry();
        }
        controller.error(markRetryDecision(error, decision, state.outputState));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
