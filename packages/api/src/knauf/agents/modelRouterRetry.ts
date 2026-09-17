type RetryConfig = Record<string, unknown> & {
  fallbacks?: unknown;
  maxRetries?: unknown;
};

type StreamFailure = {
  code?: unknown;
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
  item?: { type?: unknown };
  response?: { error?: StreamFailure | null };
};

type RetryDecision = 'retry' | 'not_retryable' | 'unsafe_after_output' | 'cancelled';

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
  /^response\.(?:code_interpreter|file_search|function_call|image_generation|local_shell|mcp|shell|tool_search|web_search)_/;
const VISIBLE_DELTA_TYPES = new Set([
  'response.output_text.delta',
  'response.reasoning_summary.delta',
  'response.reasoning_summary_text.delta',
  'response.refusal.delta',
]);
const VISIBLE_DONE_FIELDS = new Map([
  ['response.output_text.done', 'text'],
  ['response.reasoning_summary_text.done', 'text'],
  ['response.refusal.done', 'refusal'],
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

const isUnsafeEvent = (event: StreamEvent): boolean => {
  const type = typeof event.type === 'string' ? event.type : '';
  if (VISIBLE_DELTA_TYPES.has(type)) {
    return typeof event.delta !== 'string' || event.delta.length > 0;
  }
  const doneField = VISIBLE_DONE_FIELDS.get(type);
  if (doneField != null) {
    const value = event[doneField as keyof StreamEvent];
    return typeof value !== 'string' || value.length > 0;
  }
  if (SIDE_EFFECT_EVENT_PATTERN.test(type)) {
    return true;
  }
  return (
    (type === 'response.output_item.added' || type === 'response.output_item.done') &&
    typeof event.item?.type === 'string' &&
    !['message', 'reasoning'].includes(event.item.type)
  );
};

const getFailure = (event: StreamEvent): StreamFailure =>
  event.type === 'response.failed' ? (event.response?.error ?? {}) : (event.error ?? event);

const getDecision = (failure: StreamFailure, unsafe: boolean): RetryDecision => {
  if (unsafe) {
    return 'unsafe_after_output';
  }
  const identifier = boundedIdentifier(failure.code) ?? boundedIdentifier(failure.type);
  return identifier != null && RETRYABLE_STREAM_CODES.has(identifier) ? 'retry' : 'not_retryable';
};

const errorFrame = (
  encoder: TextEncoder,
  failure: StreamFailure,
  decision: RetryDecision,
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
      },
    })}\n\n`,
  );
};

const markRetryDecision = (error: unknown, decision: RetryDecision): Error => {
  if (error instanceof Error) {
    Object.assign(error, { knaufRetryDecision: decision });
    return error;
  }
  return Object.assign(new Error(SAFE_FAILURE_MESSAGE), {
    type: 'server_error',
    knaufRetryDecision: decision,
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
  unsafe: boolean;
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
  if (state.unsafe) {
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
    unsafe: false,
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
      state.unsafe ||= isUnsafeEvent(event);
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        state.terminalSeen = true;
        state.finalResponseSeen = true;
      } else if (event.type === 'response.failed' || event.type === 'error') {
        state.terminalSeen = true;
        const failure = getFailure(event);
        const decision = getDecision(failure, state.unsafe);
        if (decision !== 'retry') {
          disableRetry();
        }
        controller.enqueue(errorFrame(encoder, failure, decision));
        return;
      }
    } catch {
      // Preserve non-JSON SSE frames unchanged.
    }
    controller.enqueue(encoder.encode(`${frame}\n\n`));
  };

  const finishStream = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (!state.terminalSeen) {
      const decision = state.unsafe ? 'unsafe_after_output' : 'retry';
      if (decision !== 'retry') {
        disableRetry();
      }
      controller.enqueue(
        errorFrame(encoder, { code: 'stream_terminated', type: 'server_error' }, decision),
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
          disableRetry();
          controller.close();
          return;
        }
        const decision = getTransportDecision(error, state, isCallerAborted, isTransportTimedOut);
        if (decision !== 'retry') {
          disableRetry();
        }
        controller.error(markRetryDecision(error, decision));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}
