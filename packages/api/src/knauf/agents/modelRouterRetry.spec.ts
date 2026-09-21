import { Stream } from 'openai/streaming';
import {
  applyKnaufRetryFallback,
  guardModelRouterResponsesStream,
  preserveRetryForHttpStatus,
} from './modelRouterRetry';

const streamOf = (frames: unknown[]): ReadableStream<Uint8Array> => {
  const encoded = new TextEncoder().encode(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
  );
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
};

describe('Model Router bounded retry', () => {
  it('uses one graph fallback and disables nested SDK retries', () => {
    const configuration = { fetch: jest.fn() };
    const config: Record<string, unknown> = {
      provider: 'openAI',
      model: 'model-router',
      maxRetries: 1,
      configuration,
    };

    applyKnaufRetryFallback(config, 'openAI');

    expect(config.maxRetries).toBe(0);
    expect(config.fallbacks).toEqual([
      {
        provider: 'openAI',
        clientOptions: expect.objectContaining({
          model: 'model-router',
          maxRetries: 0,
          configuration,
        }),
      },
    ]);
  });

  it('honors a disabled retry budget and preserves explicit fallbacks', () => {
    const disabled = { model: 'model-router', maxRetries: 0 };
    applyKnaufRetryFallback(disabled, 'openAI');
    expect(disabled).not.toHaveProperty('fallbacks');

    const fallbacks = [{ provider: 'azureOpenAI' }];
    const explicit = { model: 'model-router', maxRetries: 1, fallbacks };
    applyKnaufRetryFallback(explicit, 'openAI');
    expect(explicit.fallbacks).toBe(fallbacks);
    expect(explicit.maxRetries).toBe(1);
  });

  it('keeps non-Model-Router fallback behavior unchanged', () => {
    const config = { provider: 'openAI', model: 'gpt-5.5', maxRetries: 1 };
    applyKnaufRetryFallback(config, 'openAI');

    expect(config.maxRetries).toBe(1);
    expect(config.fallbacks).toHaveLength(1);
  });

  it('disables fallback for deterministic HTTP failures', () => {
    const config = { fallbacks: [{ provider: 'openAI' }] };
    preserveRetryForHttpStatus(config, 400);
    expect(config.fallbacks).toEqual([]);

    for (const status of [408, 429, 500, 503]) {
      const retryable = { fallbacks: [{ provider: 'openAI' }] };
      preserveRetryForHttpStatus(retryable, status);
      expect(retryable.fallbacks).toHaveLength(1);
    }
  });

  it('turns response.failed before output into a retryable stream error', async () => {
    const disableRetry = jest.fn();
    const stream = guardModelRouterResponsesStream(
      streamOf([
        { type: 'response.created', response: { id: 'response-1' } },
        {
          type: 'response.failed',
          response: { error: { code: 'server_error', message: 'private provider detail' } },
        },
      ]),
      { disableRetry },
    );

    const output = await new Response(stream).text();

    expect(disableRetry).not.toHaveBeenCalled();
    expect(output).toContain('"code":"server_error"');
    expect(output).toContain('"knauf_retry_decision":"retry"');
    expect(output).toContain('"knauf_output_state":"none"');
    expect(output).not.toContain('private provider detail');
  });

  it('matches the installed OpenAI stream error contract', async () => {
    const disableRetry = jest.fn();
    const guarded = guardModelRouterResponsesStream(
      streamOf([
        {
          type: 'response.failed',
          response: { error: { code: 'server_error', message: 'private provider detail' } },
        },
      ]),
      { disableRetry },
    );
    const stream = Stream.fromSSEResponse(
      new Response(guarded, { headers: { 'x-request-id': 'azure-request-1' } }),
      new AbortController(),
    );
    const consume = async () => {
      for await (const _event of stream) {
        // The injected error must reject before yielding a successful terminal event.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: 'server_error',
      requestID: 'azure-request-1',
      error: { knauf_retry_decision: 'retry', knauf_output_state: 'none' },
    });
    expect(disableRetry).not.toHaveBeenCalled();
  });

  it('blocks retry when response.failed follows visible output', async () => {
    const disableRetry = jest.fn();
    const stream = guardModelRouterResponsesStream(
      streamOf([
        { type: 'response.output_text.delta', delta: 'Visible answer' },
        {
          type: 'response.failed',
          response: { error: { code: 'server_error', message: 'private provider detail' } },
        },
      ]),
      { disableRetry },
    );

    const output = await new Response(stream).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).toContain('"knauf_retry_decision":"unsafe_after_output"');
    expect(output).toContain('"knauf_output_state":"answer_text"');
  });

  it('blocks retry for deterministic streamed failures', async () => {
    const disableRetry = jest.fn();
    const stream = guardModelRouterResponsesStream(
      streamOf([
        {
          type: 'response.failed',
          response: { error: { code: 'invalid_prompt', message: 'private provider detail' } },
        },
      ]),
      { disableRetry },
    );

    const output = await new Response(stream).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).toContain('"knauf_retry_decision":"not_retryable"');
    expect(output).toContain('"knauf_output_state":"none"');
  });

  it('fails closed when a streamed failure has no allow-listed class', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          {
            type: 'response.failed',
            response: { error: { message: 'private provider detail' } },
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).toContain('"knauf_retry_decision":"not_retryable"');
  });

  it('turns an explicit stream error event into a retryable error', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          {
            type: 'error',
            code: 'server_error',
            message: 'private provider detail',
            param: null,
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).not.toHaveBeenCalled();
    expect(output).toContain('"code":"server_error"');
    expect(output).toContain('"knauf_retry_decision":"retry"');
    expect(output).toContain('"knauf_output_state":"none"');
    expect(output).not.toContain('private provider detail');
  });

  it('turns a terminal-less stream into a bounded retryable error', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([{ type: 'response.created', response: { id: 'response-1' } }]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).not.toHaveBeenCalled();
    expect(output).toContain('"code":"stream_terminated"');
    expect(output).toContain('"knauf_retry_decision":"retry"');
    expect(output).toContain('"knauf_output_state":"none"');
  });

  it('preserves a completed stream without adding an error', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([{ type: 'response.completed', response: { id: 'response-1' } }]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).not.toHaveBeenCalled();
    expect(output).toContain('response.completed');
    expect(output).not.toContain('"error"');
  });

  it('does not replay a completed response after a trailing transport failure', async () => {
    const disconnect = Object.assign(new Error('private socket detail'), { code: 'ECONNRESET' });
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1;
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: 'response.completed',
                response: { id: 'response-1' },
              })}\n\n`,
            ),
          );
          return;
        }
        controller.error(disconnect);
      },
    });
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(body, { disableRetry }),
    ).text();

    expect(output).toContain('response.completed');
    expect(output).not.toContain('"error"');
    expect(disableRetry).not.toHaveBeenCalled();
  });

  it('preserves max-output retry after a trailing transport failure', async () => {
    const disconnect = Object.assign(new Error('private socket detail'), { code: 'ECONNRESET' });
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1;
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: 'response.incomplete',
                response: { incomplete_details: { reason: 'max_output_tokens' } },
              })}\n\n`,
            ),
          );
          return;
        }
        controller.error(disconnect);
      },
    });
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(body, { disableRetry }),
    ).text();

    expect(output).toContain('"type":"response.incomplete"');
    expect(output).not.toContain('"knauf_retry_decision"');
    expect(disableRetry).not.toHaveBeenCalled();
  });

  it('blocks retry when the connection terminates after visible output', async () => {
    const disconnect = Object.assign(new Error('private socket detail'), { code: 'ECONNRESET' });
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1;
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: 'response.output_text.delta',
                delta: 'Visible answer',
              })}\n\n`,
            ),
          );
          return;
        }
        controller.error(disconnect);
      },
    });
    const disableRetry = jest.fn();
    const guarded = guardModelRouterResponsesStream(body, { disableRetry });

    await expect(new Response(guarded).text()).rejects.toMatchObject({
      code: 'ECONNRESET',
      knaufRetryDecision: 'unsafe_after_output',
      knaufOutputState: 'answer_text',
    });
    expect(disableRetry).toHaveBeenCalledTimes(1);
  });

  it('preserves transport output state through the installed OpenAI stream parser', async () => {
    const disconnect = Object.assign(new Error('private socket detail'), { code: 'ECONNRESET' });
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) {
          pullCount += 1;
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: 'response.output_text.delta',
                delta: 'Visible answer',
              })}\n\n`,
            ),
          );
          return;
        }
        controller.error(disconnect);
      },
    });
    const disableRetry = jest.fn();
    const stream = Stream.fromSSEResponse(
      new Response(guardModelRouterResponsesStream(body, { disableRetry })),
      new AbortController(),
    );
    const consume = async () => {
      for await (const _event of stream) {
        // The transport failure must keep the guard's bounded state.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: 'ECONNRESET',
      knaufRetryDecision: 'unsafe_after_output',
      knaufOutputState: 'answer_text',
    });
    expect(disableRetry).toHaveBeenCalledTimes(1);
  });

  it('retries a known transport failure before output', async () => {
    const disconnect = Object.assign(new TypeError('private socket detail'), {
      cause: { code: 'UND_ERR_SOCKET' },
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(disconnect);
      },
    });
    const disableRetry = jest.fn();

    await expect(
      new Response(guardModelRouterResponsesStream(body, { disableRetry })).text(),
    ).rejects.toMatchObject({ knaufRetryDecision: 'retry' });
    expect(disableRetry).not.toHaveBeenCalled();
  });

  it('blocks retry for an unknown transport failure before output', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new SyntaxError('private parse detail'));
      },
    });
    const disableRetry = jest.fn();

    await expect(
      new Response(guardModelRouterResponsesStream(body, { disableRetry })).text(),
    ).rejects.toMatchObject({ knaufRetryDecision: 'not_retryable' });
    expect(disableRetry).toHaveBeenCalledTimes(1);
  });

  it('does not retry caller cancellation', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException('cancelled', 'AbortError'));
      },
    });
    const disableRetry = jest.fn();

    await expect(
      new Response(
        guardModelRouterResponsesStream(body, {
          disableRetry,
          isCallerAborted: () => true,
        }),
      ).text(),
    ).rejects.toMatchObject({ knaufRetryDecision: 'cancelled' });
    expect(disableRetry).toHaveBeenCalledTimes(1);
  });

  it('blocks retry after a provider-side tool starts', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          {
            type: 'response.output_item.added',
            item: { type: 'web_search_call' },
          },
          {
            type: 'response.failed',
            response: { error: { code: 'server_error', message: 'private provider detail' } },
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).toContain('"knauf_retry_decision":"unsafe_after_output"');
    expect(output).toContain('"knauf_output_state":"activity_only"');
  });

  it('keeps done-only text replay-unsafe without calling it persisted answer text', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          { type: 'response.output_text.done', text: 'Visible answer' },
          {
            type: 'response.failed',
            response: { error: { code: 'server_error', message: 'private provider detail' } },
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).toContain('"knauf_retry_decision":"unsafe_after_output"');
    expect(output).toContain('"knauf_output_state":"activity_only"');
  });

  it('keeps terminal message text replay-unsafe unless a delta was persisted', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          {
            type: 'response.output_item.done',
            item: { type: 'message', content: [{ type: 'output_text', text: 'Visible answer' }] },
          },
          {
            type: 'response.failed',
            response: { error: { code: 'server_error', message: 'private provider detail' } },
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).toContain('"knauf_retry_decision":"unsafe_after_output"');
    expect(output).toContain('"knauf_output_state":"activity_only"');
  });

  it.each([
    {
      label: 'reasoning only',
      event: { type: 'response.reasoning_summary.delta', delta: 'Internal reasoning' },
    },
    {
      label: 'reasoning content',
      event: { type: 'response.reasoning.delta', delta: 'Encrypted reasoning' },
    },
    {
      label: 'reasoning summary part',
      event: {
        type: 'response.reasoning_summary_part.added',
        part: { type: 'summary_text', text: 'Reasoning summary' },
      },
    },
    {
      label: 'content part added',
      event: {
        type: 'response.content_part.added',
        part: { type: 'output_text', text: '' },
      },
    },
    {
      label: 'content part done',
      event: {
        type: 'response.content_part.done',
        part: { type: 'output_text', text: 'Terminal answer text' },
      },
    },
    {
      label: 'reasoning output item',
      event: { type: 'response.output_item.added', item: { type: 'reasoning' } },
    },
    {
      label: 'refusal only',
      event: { type: 'response.refusal.delta', delta: 'I cannot help with that.' },
    },
    {
      label: 'malformed answer delta',
      event: { type: 'response.output_text.delta', delta: { unexpected: true } },
    },
    {
      label: 'terminal refusal item',
      event: {
        type: 'response.output_item.done',
        item: { type: 'message', content: [{ type: 'refusal', refusal: 'Cannot answer' }] },
      },
    },
    {
      label: 'custom tool input',
      event: { type: 'response.custom_tool_call_input.delta', delta: '{"query":"bounded"}' },
    },
  ])('keeps $label non-replayable without classifying answer text', async ({ event }) => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          event,
          {
            type: 'response.failed',
            response: { error: { code: 'server_error', message: 'private provider detail' } },
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).toContain('"knauf_retry_decision":"unsafe_after_output"');
    expect(output).toContain('"knauf_output_state":"activity_only"');
  });

  it('does not treat whitespace-only answer events as visible output', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          { type: 'response.output_text.delta', delta: '   ' },
          {
            type: 'response.failed',
            response: { error: { code: 'server_error', message: 'private provider detail' } },
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).not.toHaveBeenCalled();
    expect(output).toContain('"knauf_retry_decision":"retry"');
    expect(output).toContain('"knauf_output_state":"none"');
  });

  it('keeps a clean EOF after tool activity non-replayable', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([{ type: 'response.output_item.added', item: { type: 'web_search_call' } }]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).toContain('"knauf_retry_decision":"unsafe_after_output"');
    expect(output).toContain('"knauf_output_state":"activity_only"');
  });

  it('turns content-filter incomplete output into a bounded terminal failure', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          { type: 'response.output_text.delta', delta: 'Visible answer' },
          {
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'content_filter' } },
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).not.toContain('"type":"response.incomplete"');
    expect(output).toContain('"code":"response_incomplete"');
    expect(output).toContain('"knauf_retry_decision":"unsafe_after_output"');
    expect(output).toContain('"knauf_output_state":"answer_text"');
    expect(output).toContain('"knauf_incomplete_reason":"content_filter"');
  });

  it('keeps content-filter incomplete without answer text on the generic-error path', async () => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          {
            type: 'response.incomplete',
            response: { incomplete_details: { reason: 'content_filter' } },
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).toHaveBeenCalledTimes(1);
    expect(output).toContain('"knauf_retry_decision":"not_retryable"');
    expect(output).toContain('"knauf_output_state":"none"');
    expect(output).toContain('"knauf_incomplete_reason":"content_filter"');
  });

  it.each([
    { label: 'max output', reason: 'max_output_tokens' },
    { label: 'unknown', reason: 'provider_extension' },
    { label: 'absent', reason: undefined },
  ])('preserves $label incomplete events for downstream handling', async ({ reason }) => {
    const disableRetry = jest.fn();
    const output = await new Response(
      guardModelRouterResponsesStream(
        streamOf([
          {
            type: 'response.incomplete',
            response: {
              incomplete_details: reason == null ? null : { reason },
            },
          },
        ]),
        { disableRetry },
      ),
    ).text();

    expect(disableRetry).not.toHaveBeenCalled();
    expect(output).toContain('"type":"response.incomplete"');
    expect(output).not.toContain('"knauf_retry_decision"');
  });
});
