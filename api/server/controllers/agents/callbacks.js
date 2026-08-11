const { nanoid } = require('nanoid');
const { logger } = require('@librechat/data-schemas');
const { BaseCallbackHandler } = require('@langchain/core/callbacks/base');
const {
  ContentTypes,
  Tools,
  StepTypes,
  FileContext,
  ErrorTypes,
  UsageEvents,
} = require('librechat-data-provider');
const {
  GraphEvents,
  GraphNodeKeys,
  ToolEndHandler,
  createContentAggregator,
  // [knauf] NO-TICKET — Model Router needs the SDK's existing orphan-pair
  // sanitizer too; the SDK currently invokes it only for Anthropic-like models.
  sanitizeOrphanToolBlocks,
  // End [knauf]
} = require('@librechat/agents');
const {
  sendEvent,
  computeUsageCostUSD,
  GenerationJobManager,
  writeAttachmentEvent,
  createToolExecuteHandler,
  HOST_FILE_AUTHORING_ARTIFACT_KEY,
  isCodeSessionToolName,
} = require('@librechat/api');
const { processFileCitations } = require('~/server/services/Files/Citations');
const { processCodeOutput, runPreviewFinalize } = require('~/server/services/Files/Code/process');
const { saveBase64Image } = require('~/server/services/Files/process');
// [knauf] KK20-194 — preserve the authoritative final native-search phase.
const { getFinalWebSearchResponseText } = require('~/server/knauf/nativeWebSearchOutput');
// End [knauf]

// [knauf] KK20-194 — bounded model refusal and output-limit recovery.
// Model Router can occasionally return this gateway-style
// response with zero usage instead of raising an error. Output-limit stops also
// need one clean replacement instead of persisting a partial answer. Convert
// both into model failures so the SDK fallback retries only the current call.
const { HumanMessage } = require('@librechat/agents/langchain/messages');

const GENERIC_ZERO_USAGE_REFUSAL = "i'm sorry, but i cannot assist with that request.";
const OUTPUT_LIMIT_VALUES = new Set(['length', 'max_tokens', 'max_output_tokens']);
const OUTPUT_LIMIT_RETRY_INSTRUCTION =
  'The previous attempt hit the output limit and was discarded. Retry the original request ' +
  'from scratch as one complete replacement, not a continuation. For prose, use at most 300 ' +
  'words unless the user explicitly requested more detail. Preserve required code or artifact ' +
  'content, but remove commentary, repetition, and optional detail.';

function getGenerationText(result) {
  const generation = result?.generations?.[0]?.[0];
  const content = generation?.message?.content ?? generation?.text;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
}

function isZeroUsageGenericRefusal(result) {
  const generation = result?.generations?.[0]?.[0];
  const message = generation?.message;
  if ((message?.tool_calls?.length ?? 0) > 0) {
    return false;
  }
  const usage =
    message?.usage_metadata ?? result?.llmOutput?.tokenUsage ?? result?.llmOutput?.usage;
  const tokenCounts = [
    usage?.input_tokens ?? usage?.promptTokens ?? usage?.prompt_tokens,
    usage?.output_tokens ?? usage?.completionTokens ?? usage?.completion_tokens,
    usage?.total_tokens ?? usage?.totalTokens,
  ].filter((value) => typeof value === 'number');
  const text = getGenerationText(result).trim().replaceAll('’', "'").toLowerCase();
  return (
    tokenCounts.length >= 2 &&
    tokenCounts.every((value) => value === 0) &&
    text === GENERIC_ZERO_USAGE_REFUSAL
  );
}

function isOutputTruncated(result) {
  const message = result?.generations?.[0]?.[0]?.message;
  const metadata = message?.response_metadata;
  const values = [
    metadata?.finish_reason,
    metadata?.stop_reason,
    metadata?.stopReason,
    metadata?.incomplete_details?.reason,
  ];
  return values.some(
    (value) => typeof value === 'string' && OUTPUT_LIMIT_VALUES.has(value.trim().toLowerCase()),
  );
}

function stampLangfuseResponseModel(result) {
  const generation = result?.generations?.at(-1)?.at(-1);
  const responseMetadata = generation?.message?.response_metadata;
  if (responseMetadata == null || typeof responseMetadata !== 'object') {
    return;
  }
  const responseModel = getResponseModel({ output: { response_metadata: responseMetadata } });
  if (typeof responseModel === 'string' && responseModel !== '') {
    responseMetadata.model_name = responseModel;
  }
}

function getToolMessageType(message) {
  return typeof message?.getType === 'function' ? message.getType() : message?.role;
}

function repairModelRouterToolHistory(messages) {
  for (const message of messages) {
    if (getToolMessageType(message) !== 'tool' || message.tool_call_id) {
      continue;
    }
    const fallbackId = message.additional_kwargs?.tool_call_id;
    if (typeof fallbackId === 'string' && fallbackId !== '') {
      message.tool_call_id = fallbackId;
    }
  }

  const paired = sanitizeOrphanToolBlocks(messages);
  const complete = paired.filter(
    (message) =>
      getToolMessageType(message) !== 'tool' ||
      (typeof message.tool_call_id === 'string' && message.tool_call_id !== ''),
  );
  return complete.length === paired.length ? paired : sanitizeOrphanToolBlocks(complete);
}

function createModelRetryHandler(metadata) {
  const state = {
    refusalCount: 0,
    truncationCount: 0,
    recoveryInstructionCount: 0,
    truncatedTexts: [],
    truncatedToolCallIds: [],
  };
  const handler = BaseCallbackHandler.fromMethods({
    handleChatModelStart(_llm, messageBatches, _runId, _parentRunId, _tags, runMetadata) {
      if (state.truncationCount > state.recoveryInstructionCount) {
        for (const messages of messageBatches) {
          messages.push(new HumanMessage(OUTPUT_LIMIT_RETRY_INSTRUCTION));
        }
        state.recoveryInstructionCount = state.truncationCount;
      }
      const model = runMetadata?.ls_model_name;
      if (typeof model !== 'string' || !model.toLowerCase().includes('model-router')) {
        return;
      }
      for (const messages of messageBatches) {
        const repaired = repairModelRouterToolHistory(messages);
        if (repaired !== messages) {
          messages.splice(0, messages.length, ...repaired);
        }
      }
    },
    handleLLMEnd(result) {
      // Must stay synchronous: this handler is registered before Langfuse, so
      // Langfuse sees Azure's routed model instead of the `model-router` alias.
      stampLangfuseResponseModel(result);
      if (isOutputTruncated(result)) {
        state.truncationCount += 1;
        const text = getGenerationText(result);
        if (text !== '') {
          state.truncatedTexts.push(text);
        }
        const message = result?.generations?.[0]?.[0]?.message;
        const toolCalls = [
          ...(message?.tool_calls ?? []),
          ...(message?.tool_call_chunks ?? []),
          ...(message?.invalid_tool_calls ?? []),
        ];
        for (const toolCall of toolCalls) {
          if (typeof toolCall?.id === 'string' && toolCall.id !== '') {
            state.truncatedToolCallIds.push(toolCall.id);
          }
        }
        logger.warn('[AgentClient] Retrying output-limit truncation', {
          ...metadata,
          attempt: state.truncationCount,
        });
        throw new Error(
          JSON.stringify({
            type: 'output_truncated',
            info: { reason: 'max_output_tokens', retryable: true },
          }),
        );
      }
      if (!isZeroUsageGenericRefusal(result)) {
        return;
      }
      state.refusalCount += 1;
      logger.warn('[AgentClient] Retrying zero-usage generic refusal', {
        ...metadata,
        attempt: state.refusalCount,
      });
      throw new Error(
        JSON.stringify({
          type: ErrorTypes.REFUSAL,
          info: { reason: 'zero_usage_generic_refusal', retryable: true },
        }),
      );
    },
  });
  handler.raiseError = true;
  handler.awaitHandlers = true;
  return { handler, state };
}

function stripRetriedGenericRefusal(contentParts) {
  return contentParts.flatMap((part) => {
    if (part?.type !== ContentTypes.TEXT || typeof part.text !== 'string') {
      return [part];
    }
    const normalized = part.text.trimStart().replaceAll('’', "'").toLowerCase();
    if (!normalized.startsWith(GENERIC_ZERO_USAGE_REFUSAL)) {
      return [part];
    }
    const refusalEnd = part.text.toLowerCase().indexOf('request.') + 'request.'.length;
    const text = part.text.slice(refusalEnd).trimStart();
    return text === '' ? [] : [{ ...part, text }];
  });
}

function stripTextPrefix(contentParts, prefix) {
  let remaining = prefix;
  return contentParts.flatMap((part) => {
    if (remaining === '' || part?.type !== ContentTypes.TEXT || typeof part.text !== 'string') {
      return [part];
    }
    if (remaining.startsWith(part.text)) {
      remaining = remaining.slice(part.text.length);
      return [];
    }
    if (!part.text.startsWith(remaining)) {
      return [part];
    }
    const text = part.text.slice(remaining.length);
    remaining = '';
    return text === '' ? [] : [{ ...part, text }];
  });
}

function stripRetriedModelOutput(contentParts, state) {
  let cleaned = state.refusalCount > 0 ? stripRetriedGenericRefusal(contentParts) : contentParts;
  for (const text of state.truncatedTexts) {
    cleaned = stripTextPrefix(cleaned, text);
  }
  const truncatedToolCallIds = new Set(state.truncatedToolCallIds);
  return cleaned.filter(
    (part) =>
      part?.type !== ContentTypes.TOOL_CALL ||
      !truncatedToolCallIds.has(part[ContentTypes.TOOL_CALL]?.id),
  );
}
// End [knauf]

function isHostFileAuthoringArtifact(artifact) {
  return artifact?.[HOST_FILE_AUTHORING_ARTIFACT_KEY] === true;
}

function isCodeArtifactToolOutput(output) {
  return isCodeSessionToolName(output.name) || isHostFileAuthoringArtifact(output.artifact);
}

class ModelEndHandler {
  /**
   * @param {Array<UsageMetadata>} collectedUsage
   * @param {Record<string, string> | null} [collectedThoughtSignatures] Map of
   *   `tool_call_id → thoughtSignature` accumulated across `chat_model_end`
   *   events. Used to persist Vertex Gemini 3 thought signatures across DB
   *   round-trips so resumed conversations don't 400 on the next API call.
   *   Each `model_end` may emit multiple tool calls (one per LLM cycle in a
   *   tool-using turn); per-id storage preserves the mapping so each tool
   *   call's signature can be restored onto the right reconstructed
   *   AIMessage rather than being concentrated on the last one.
   *   Optional; when `null`, the handler is a no-op for signatures. Non-Vertex
   *   providers don't emit `additional_kwargs.signatures`, so capture is also
   *   a no-op for them even when the map is provided.
   * @param {(data: Record<string, unknown>) => Promise<void> | void} [emitUsage] Optional
   *   callback to stream per-call token usage to the client.
   * @param {{ text: string } | null} [nativeWebSearchOutputSink] Final native-search response text.
   */
  // [knauf] KK20-194 — accept the final native-search output sink.
  constructor(
    collectedUsage,
    collectedThoughtSignatures = null,
    emitUsage = null,
    nativeWebSearchOutputSink = null,
  ) {
    // End [knauf]
    if (!Array.isArray(collectedUsage)) {
      throw new Error('collectedUsage must be an array');
    }
    this.collectedUsage = collectedUsage;
    this.collectedThoughtSignatures = collectedThoughtSignatures;
    this.emitUsage = emitUsage;
    // [knauf] KK20-194 — filled at model end, applied after all stream deltas finish.
    this.nativeWebSearchOutputSink = nativeWebSearchOutputSink;
    // End [knauf]
  }

  finalize(errorMessage) {
    if (!errorMessage) {
      return;
    }
    throw new Error(errorMessage);
  }

  /**
   * @param {string} event
   * @param {ModelEndData | undefined} data
   * @param {Record<string, unknown> | undefined} metadata
   * @param {StandardGraph} graph
   * @returns {Promise<void>}
   */
  async handle(event, data, metadata, graph) {
    if (!graph || !metadata) {
      console.warn(`Graph or metadata not found in ${event} event`);
      return;
    }

    /** @type {string | undefined} */
    let errorMessage;
    try {
      const agentContext = graph.getAgentContext(metadata);
      // [knauf] KK20-194 — LangChain streams commentary and final-answer phases,
      // while LibreChat's aggregator drops `phase` and concatenates them. Keep
      // the provider's final native-search answer for post-stream persistence.
      const finalWebSearchText = getFinalWebSearchResponseText(
        data?.output?.response_metadata?.output,
      );
      const isVisibleModel =
        !metadata.hide_sequential_outputs ||
        checkIfLastAgent(metadata.last_agent_id, metadata.langgraph_node);
      if (this.nativeWebSearchOutputSink && isVisibleModel) {
        this.nativeWebSearchOutputSink.text = finalWebSearchText;
      }
      // End [knauf]
      if (data?.output?.additional_kwargs?.stop_reason === 'refusal') {
        const info = { ...data.output.additional_kwargs };
        errorMessage = JSON.stringify({
          type: ErrorTypes.REFUSAL,
          info,
        });
        logger.debug(`[ModelEndHandler] Model refused to respond`, {
          ...info,
          userId: metadata.user_id,
          messageId: metadata.run_id,
          conversationId: metadata.thread_id,
        });
      }

      // [knauf] KK20-252 — surface an Azure Responsible-AI completion block.
      // Upstream types `finish_reason` as including 'content_filter'
      // (packages/api/src/agents/openai/types.ts:105) and then never reads it, so
      // a filtered completion was indistinguishable from the model choosing to
      // decline — which cost real diagnosis time on KK20-252, where the visible
      // symptom ("I'm sorry, but I cannot assist with that request.") turned out
      // to be a genuine model refusal driven by contradictory instructions rather
      // than a filter. Logged, not thrown: unlike the `stop_reason === 'refusal'`
      // branch above, a content filter can arrive alongside partial streamed
      // content, and converting it to an error would discard output the user can
      // already see. `stop_reason` covers Anthropic; this covers Azure/OpenAI.
      if (data?.output?.response_metadata?.finish_reason === 'content_filter') {
        logger.warn('[ModelEndHandler] Azure content filter blocked the completion', {
          userId: metadata.user_id,
          messageId: metadata.run_id,
          conversationId: metadata.thread_id,
          model: metadata?.ls_model_name,
          promptFilterResults: data.output.response_metadata.prompt_filter_results,
          contentFilterResults: data.output.response_metadata.content_filter_results,
        });
      }
      // End [knauf]

      // [knauf] NO-TICKET — surface responses truncated by the configured output fuse.
      const responseMetadata = data?.output?.response_metadata;
      if (
        responseMetadata?.status === 'incomplete' ||
        responseMetadata?.finish_reason === 'length'
      ) {
        logger.warn('[ModelEndHandler] Completion reached its output limit', {
          userId: metadata.user_id,
          messageId: metadata.run_id,
          conversationId: metadata.thread_id,
          model: getResponseModel(data) || metadata.ls_model_name,
          outputTokens: data?.output?.usage_metadata?.output_tokens,
          incompleteDetails: responseMetadata.incomplete_details,
        });
      }
      // End [knauf]

      const usage = data?.output?.usage_metadata;
      if (!usage) {
        return this.finalize(errorMessage);
      }
      // [knauf] Model Router returns the selected underlying model in response metadata.
      const responseModel = getResponseModel(data);
      const modelName =
        responseModel || metadata?.ls_model_name || agentContext.clientOptions?.model;
      if (agentContext.clientOptions?.model) {
        usage.knauf_requestedModel = agentContext.clientOptions.model;
      }
      // End [knauf]
      if (modelName) {
        usage.model = modelName;
      }
      if (agentContext.provider) {
        usage.provider = agentContext.provider;
      }
      /** Tag the producing agent so multi-endpoint graphs can price each call
       *  with its own endpoint token config (recordCollectedUsage resolver). */
      if (agentContext.agentId) {
        usage.agentId = agentContext.agentId;
      }

      let taggedUsage = markSummarizationUsage(usage, metadata);
      /** Hidden intermediate sequential-agent calls are billed but never shown.
       *  Tag them non-primary on the COLLECTED usage too (not just the emit) so
       *  recordCollectedUsage excludes their output from the parent's tokenCount
       *  and the client folds them into cost/totals only — not the live gauge. */
      if (
        taggedUsage.usage_type == null &&
        !checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node) &&
        metadata?.hide_sequential_outputs === true
      ) {
        taggedUsage = { ...taggedUsage, usage_type: 'sequential' };
      }

      this.collectedUsage.push(taggedUsage);

      if (this.emitUsage) {
        /** Normalize Anthropic/Bedrock-style top-level cache fields into details */
        const cache_creation =
          taggedUsage.input_token_details?.cache_creation ??
          taggedUsage.cache_creation_input_tokens;
        const cache_read =
          taggedUsage.input_token_details?.cache_read ?? taggedUsage.cache_read_input_tokens;
        try {
          await this.emitUsage({
            input_tokens: taggedUsage.input_tokens,
            output_tokens: taggedUsage.output_tokens,
            total_tokens: taggedUsage.total_tokens,
            input_token_details:
              cache_creation != null || cache_read != null
                ? { cache_creation, cache_read }
                : undefined,
            model: taggedUsage.model,
            provider: taggedUsage.provider,
            usage_type: taggedUsage.usage_type,
            /** Producing agent for per-endpoint pricing; consumed by the emit
             *  cost resolver and not included in the emitted/persisted payload. */
            agentId: taggedUsage.agentId,
            runId: metadata?.run_id,
            /** Per-run sequence so identical payloads from distinct calls
             *  stay distinguishable during resume dedupe */
            seq: this.collectedUsage.length,
          });
        } catch (err) {
          /** Best-effort telemetry: a failed emit (closed SSE, Redis publish
           *  error) must not abort the handler before the thought-signature
           *  capture below, or resumed tool-call requests lose that metadata */
          logger.warn('[ModelEndHandler] Failed to emit token usage', err);
        }
      }

      /**
       * `additional_kwargs.signatures` is a flat array indexed by response
       * part position (text + functionCall interleaved). `tool_calls` is
       * just the function calls in their original order. Non-empty
       * signatures correspond 1:1 with `tool_calls` in order — see
       * `partsToSignatures` in `@langchain/google-common`. Walk both in a
       * single pass to map each signature onto the right `tool_call.id`.
       */
      const signatures = data?.output?.additional_kwargs?.signatures;
      const toolCalls = data?.output?.tool_calls;
      if (
        this.collectedThoughtSignatures &&
        Array.isArray(signatures) &&
        Array.isArray(toolCalls)
      ) {
        let toolIdx = 0;
        for (const sig of signatures) {
          if (typeof sig !== 'string' || sig.length === 0) continue;
          if (toolIdx >= toolCalls.length) break;
          const id = toolCalls[toolIdx++]?.id;
          if (id) this.collectedThoughtSignatures[id] = sig;
        }
      }
    } catch (error) {
      logger.error('Error handling model end event:', error);
      return this.finalize(errorMessage);
    }
  }
}

/**
 * @deprecated Agent Chain helper
 * @param {string | undefined} [last_agent_id]
 * @param {string | undefined} [langgraph_node]
 * @returns {boolean}
 */
function checkIfLastAgent(last_agent_id, langgraph_node) {
  if (!last_agent_id || !langgraph_node) {
    return false;
  }
  return langgraph_node?.endsWith(last_agent_id);
}

/**
 * Helper to emit events either to res (standard mode) or to job emitter (resumable mode).
 * In Redis mode, awaits the emit to guarantee event ordering (critical for streaming deltas).
 * @param {ServerResponse} res - The server response object
 * @param {string | null} streamId - The stream ID for resumable mode, or null for standard mode
 * @param {Object} eventData - The event data to send
 * @returns {Promise<void>}
 */
async function emitEvent(res, streamId, eventData) {
  if (streamId) {
    await GenerationJobManager.emitChunk(streamId, eventData);
  } else {
    sendEvent(res, eventData);
  }
}

/**
 * Maps a {@link SubagentUpdateEvent} phase to the corresponding
 * {@link GraphEvents} name that the SDK's `createContentAggregator`
 * knows how to consume. Phases that don't carry content (`start`, `stop`,
 * `error`) or whose payload doesn't match a handled event (`run_step`
 * with an `ON_TOOL_EXECUTE`-shaped batch request rather than a RunStep)
 * return `null` so the caller skips them.
 * @param {SubagentUpdateEvent} event
 * @returns {string | null}
 */
function subagentPhaseToGraphEvent(event) {
  switch (event?.phase) {
    case 'run_step':
      /** `ON_RUN_STEP` and `ON_TOOL_EXECUTE` both forward with phase
       *  `run_step`; only the former matches the aggregator's RunStep
       *  schema. Detect by presence of `stepDetails`. */
      return event.data?.stepDetails ? GraphEvents.ON_RUN_STEP : null;
    case 'run_step_delta':
      return GraphEvents.ON_RUN_STEP_DELTA;
    case 'run_step_completed':
      return GraphEvents.ON_RUN_STEP_COMPLETED;
    case 'message_delta':
      return GraphEvents.ON_MESSAGE_DELTA;
    case 'reasoning_delta':
      return GraphEvents.ON_REASONING_DELTA;
    default:
      return null;
  }
}

/**
 * Folds a single {@link SubagentUpdateEvent} into the given content
 * aggregator. Silent no-op for phases outside the aggregator's domain.
 * @param {{ aggregateContent: Function }} aggregator
 * @param {SubagentUpdateEvent} event
 */
function feedSubagentAggregator(aggregator, event) {
  const graphEvent = subagentPhaseToGraphEvent(event);
  if (!graphEvent) return;
  aggregator.aggregateContent({ event: graphEvent, data: event.data });
}

/**
 * @typedef {Object} ToolExecuteOptions
 * @property {(toolNames: string[]) => Promise<{loadedTools: StructuredTool[]}>} loadTools - Function to load tools by name
 * @property {Object} configurable - Configurable context for tool invocation
 */

/**
 * Get default handlers for stream events.
 * @param {Object} options - The options object.
 * @param {ServerResponse} options.res - The server response object.
 * @param {ContentAggregator} options.aggregateContent - Content aggregator function.
 * @param {ToolEndCallback} options.toolEndCallback - Callback to use when tool ends.
 * @param {Array<UsageMetadata>} options.collectedUsage - The list of collected usage metadata.
 * @param {string | null} [options.streamId] - The stream ID for resumable mode, or null for standard mode.
 * @param {ToolExecuteOptions} [options.toolExecuteOptions] - Options for event-driven tool execution.
 * @param {UsageCostDeps} [options.usageCost] - Pricing context for authoritative per-event cost.
 * @param {{ latest: TContextUsageEvent | null, count: number }} [options.contextUsageSink] - Mutable
 *   holder for the latest visible context snapshot + a count of visible snapshots (model calls),
 *   used to persist the breakdown only when the final call emitted usage.
 * @param {Array<TTokenUsageEvent>} [options.usageEmitSink] - Array collecting each emitted
 *   `on_token_usage` payload (incl. cost) so the response's usage rollup can be persisted.
 * @returns {Record<string, t.EventHandler>} The default handlers.
 * @throws {Error} If the request is not found.
 */
function getDefaultHandlers({
  res,
  aggregateContent,
  toolEndCallback,
  collectedUsage,
  collectedThoughtSignatures = null,
  streamId = null,
  toolExecuteOptions = null,
  summarizationOptions = null,
  subagentAggregatorsByToolCallId = null,
  usageCost = null,
  contextUsageSink = null,
  usageEmitSink = null,
  // [knauf] KK20-194 — mutable sink for authoritative native-search text.
  nativeWebSearchOutputSink = null,
  // End [knauf]
}) {
  if (!res || !aggregateContent) {
    throw new Error(
      `[getDefaultHandlers] Missing required options: res: ${!res}, aggregateContent: ${!aggregateContent}`,
    );
  }
  /**
   * Emit a token-usage event, attaching the authoritative per-event USD cost
   * when cost display is enabled. The backend is the single source of truth
   * for pricing (premium tiers, cache rates) — the client sums these instead
   * of re-deriving from base rates.
   * @param {Record<string, unknown>} data
   */
  const emitTokenUsage = ({ agentId, ...data }) => {
    let payload = data;
    if (usageCost?.enabled === true && usageCost.pricing) {
      try {
        /** Price with the producing agent's config (multi-endpoint graphs) so
         *  the streamed/persisted cost matches the per-agent balance transaction;
         *  `agentId` is resolved here, not forwarded to the client or rollup. */
        const endpointTokenConfig = usageCost.resolveEndpointTokenConfig
          ? usageCost.resolveEndpointTokenConfig({ agentId })
          : usageCost.endpointTokenConfig;
        payload = {
          ...data,
          cost: computeUsageCostUSD(data, usageCost.pricing, endpointTokenConfig),
        };
      } catch (err) {
        logger.warn('[getDefaultHandlers] Failed to compute usage cost', err);
      }
    }
    /** Collect the same payload the client folds so the response's usage rollup
     *  persisted on `metadata.usage` reproduces the live branch/total + cost. */
    if (usageEmitSink) {
      usageEmitSink.push(payload);
    }
    return emitEvent(res, streamId, { event: UsageEvents.ON_TOKEN_USAGE, data: payload });
  };
  const handlers = {
    [GraphEvents.CHAT_MODEL_END]: new ModelEndHandler(
      collectedUsage,
      collectedThoughtSignatures,
      emitTokenUsage,
      // [knauf] KK20-194 — pass the native-search output sink to model-end handling.
      nativeWebSearchOutputSink,
      // End [knauf]
    ),
    [GraphEvents.TOOL_END]: new ToolEndHandler(toolEndCallback, logger),
    [GraphEvents.ON_RUN_STEP]: {
      /**
       * Handle ON_RUN_STEP event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (data?.stepDetails.type === StepTypes.TOOL_CALLS) {
          await emitEvent(res, streamId, { event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        } else {
          const agentName = metadata?.name ?? 'Agent';
          const isToolCall = data?.stepDetails.type === StepTypes.TOOL_CALLS;
          const action = isToolCall ? 'performing a task...' : 'thinking...';
          await emitEvent(res, streamId, {
            event: 'on_agent_update',
            data: {
              runId: metadata?.run_id,
              message: `${agentName} is ${action}`,
            },
          });
        }
      },
    },
    [GraphEvents.ON_RUN_STEP_DELTA]: {
      /**
       * Handle ON_RUN_STEP_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (data?.delta.type === StepTypes.TOOL_CALLS) {
          await emitEvent(res, streamId, { event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        }
      },
    },
    [GraphEvents.ON_RUN_STEP_COMPLETED]: {
      /**
       * Handle ON_RUN_STEP_COMPLETED event.
       * @param {string} event - The event name.
       * @param {StreamEventData & { result: ToolEndData }} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (data?.result != null) {
          await emitEvent(res, streamId, { event, data });
        } else if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        }
      },
    },
    [GraphEvents.ON_MESSAGE_DELTA]: {
      /**
       * Handle ON_MESSAGE_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        }
      },
    },
    [GraphEvents.ON_REASONING_DELTA]: {
      /**
       * Handle ON_REASONING_DELTA event.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        aggregateContent({ event, data });
        if (checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node)) {
          await emitEvent(res, streamId, { event, data });
        } else if (!metadata?.hide_sequential_outputs) {
          await emitEvent(res, streamId, { event, data });
        }
      },
    },
  };

  if (toolExecuteOptions) {
    handlers[GraphEvents.ON_TOOL_EXECUTE] = createToolExecuteHandler(toolExecuteOptions);
  }

  handlers[GraphEvents.ON_SUBAGENT_UPDATE] = {
    /**
     * Forwards subagent progress envelopes to the client stream, and
     * (when a caller-owned aggregator map is provided) also folds each
     * event into a per-tool-call `createContentAggregator`. The
     * resulting `contentParts` are attached to the parent's `subagent`
     * tool_call at message-save time so the child's reasoning / tool
     * calls / final text survive a page refresh — in-memory Recoil
     * atoms alone wouldn't persist that.
     *
     * Aggregation runs regardless of stream visibility (persistence +
     * dialog depend on it), but the SSE forward respects
     * `hide_sequential_outputs` the same way `ON_RUN_STEP`,
     * `ON_MESSAGE_DELTA`, etc. do — so intermediate agents in a
     * sequential chain don't leak their subagent activity when the
     * chain is configured to suppress intermediates.
     */
    handle: async (event, data, metadata) => {
      const isLastAgent = checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node);
      const visible = isLastAgent || !metadata?.hide_sequential_outputs;
      /**
       * Gate BOTH aggregation (persistence) AND streaming on the same
       * visibility rule. If we aggregated for a hidden intermediate
       * agent, `finalizeSubagentContent` would still attach its
       * child's reasoning / tool output to the saved message — so a
       * page refresh would reveal activity that was intentionally
       * suppressed live. Treat hide_sequential_outputs as a
       * consistent "don't record" rule for subagent traces.
       */
      if (!visible) return;
      if (subagentAggregatorsByToolCallId && data?.parentToolCallId) {
        const key = data.parentToolCallId;
        let aggregator = subagentAggregatorsByToolCallId.get(key);
        if (!aggregator) {
          aggregator = createContentAggregator();
          subagentAggregatorsByToolCallId.set(key, aggregator);
        }
        try {
          feedSubagentAggregator(aggregator, data);
        } catch (err) {
          logger.warn(
            `[ON_SUBAGENT_UPDATE] Failed to aggregate phase "${data?.phase}" for tool_call ${key}: ${err?.message ?? err}`,
          );
        }
      }
      await emitEvent(res, streamId, { event, data });
    },
  };

  if (summarizationOptions?.enabled !== false) {
    handlers[GraphEvents.ON_SUMMARIZE_START] = {
      handle: async (_event, data) => {
        await emitEvent(res, streamId, {
          event: GraphEvents.ON_SUMMARIZE_START,
          data,
        });
      },
    };
    handlers[GraphEvents.ON_SUMMARIZE_DELTA] = {
      handle: async (_event, data) => {
        aggregateContent({ event: GraphEvents.ON_SUMMARIZE_DELTA, data });
        await emitEvent(res, streamId, {
          event: GraphEvents.ON_SUMMARIZE_DELTA,
          data,
        });
      },
    };
    handlers[GraphEvents.ON_SUMMARIZE_COMPLETE] = {
      handle: async (_event, data) => {
        aggregateContent({ event: GraphEvents.ON_SUMMARIZE_COMPLETE, data });
        await emitEvent(res, streamId, {
          event: GraphEvents.ON_SUMMARIZE_COMPLETE,
          data,
        });
      },
    };
  }

  handlers[GraphEvents.ON_AGENT_LOG] = { handle: agentLogHandler };

  /** Guarded: no-op when the installed @librechat/agents predates the event */
  if (GraphEvents.ON_CONTEXT_USAGE) {
    handlers[GraphEvents.ON_CONTEXT_USAGE] = {
      /**
       * Forward per-model-call context usage snapshots to the client,
       * honoring the same sequential-agent visibility gate as deltas.
       * @param {string} event - The event name.
       * @param {StreamEventData} data - The event data.
       * @param {GraphRunnableConfig['configurable']} [metadata] The runnable metadata.
       */
      handle: async (event, data, metadata) => {
        if (
          checkIfLastAgent(metadata?.last_agent_id, metadata?.langgraph_node) ||
          !metadata?.hide_sequential_outputs
        ) {
          /** Capture the latest visible snapshot (last-wins) and how many usage
           *  events preceded it BEFORE awaiting the emit. `emitEvent` can yield
           *  (resumable SSE / Redis publish); with parallel runs active this
           *  call's own primary usage could land in `usageEmitSink` during that
           *  yield, pushing `latestUsageIndex` past the very event that proves the
           *  snapshot completed — the save path would then slice it away and drop
           *  a valid breakdown. The recorded index lets the save path persist only
           *  when a PRIMARY usage follows this snapshot (the snapshot's call
           *  actually invoked the model); a summarization detour emits a snapshot
           *  whose only following usage is tagged `summarization`, which a plain
           *  snapshot-count would over-count and wrongly drop. */
          if (contextUsageSink) {
            contextUsageSink.latest = data;
            contextUsageSink.count = (contextUsageSink.count ?? 0) + 1;
            contextUsageSink.latestUsageIndex = usageEmitSink?.length ?? 0;
          }
          await emitEvent(res, streamId, { event, data });
        }
      },
    };
  }

  return handlers;
}

/**
 * Helper to write attachment events either to res or to job emitter.
 * Note: Attachments are not order-sensitive like deltas, so fire-and-forget is acceptable.
 * @param {ServerResponse} res - The server response object
 * @param {string | null} streamId - The stream ID for resumable mode, or null for standard mode
 * @param {Object} attachment - The attachment data
 */
function writeAttachment(res, streamId, attachment) {
  if (streamId) {
    GenerationJobManager.emitChunk(streamId, { event: 'attachment', data: attachment });
  } else {
    res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }
}

/**
 * Predicate: is it safe to push an SSE write to the caller right now?
 *
 * In `streamId` (resumable) mode, writes go to the job emitter and the
 * `res` state is irrelevant — always writable.
 *
 * In standard mode, the caller's `res` must have headers sent (the
 * stream has been opened) and not yet be `writableEnded` (the response
 * hasn't closed). Writing to a closed stream raises
 * `ERR_STREAM_WRITE_AFTER_END`.
 *
 * Used by deferred preview emits in both `createToolEndCallback`
 * (chat-completions) and `createResponsesToolEndCallback` (Open
 * Responses) so the gate logic stays in one place. (Comprehensive
 * review #3 on PR #12957.)
 */
function isStreamWritable(res, streamId) {
  if (streamId) {
    return true;
  }
  return !!res && res.headersSent && !res.writableEnded;
}

/**
 * Emit an update for an attachment that was previously sent with
 * `status: 'pending'`. Fire-and-forget: if the response stream has
 * already closed (the agent finished generating before the deferred
 * preview resolved) the frontend's React Query polling on
 * `/api/files/:file_id/preview` picks up the resolved record on its
 * next tick. Skipping the write in that case avoids
 * `ERR_STREAM_WRITE_AFTER_END`.
 *
 * Reuses the `attachment` SSE event name with a discriminated payload:
 * the frontend's `useAttachmentHandler` upserts by `file_id`, so a
 * second event with the same id and `status: 'ready' | 'failed'`
 * overwrites the pending placeholder in place. No new event type, no
 * new client listener.
 *
 * @param {ServerResponse} res
 * @param {string | null} streamId
 * @param {Object} attachment - Updated attachment payload (must carry `file_id`).
 */
function writeAttachmentUpdate(res, streamId, attachment) {
  if (!isStreamWritable(res, streamId)) {
    return;
  }
  writeAttachment(res, streamId, attachment);
}

/**
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {ServerResponse} params.res
 * @param {Promise<MongoFile | { filename: string; filepath: string; expires: number;} | null>[]} params.artifactPromises
 * @param {string | null} [params.streamId] - The stream ID for resumable mode, or null for standard mode.
 * @returns {ToolEndCallback} The tool end callback.
 */
function createToolEndCallback({ req, res, artifactPromises, streamId = null }) {
  /**
   * @type {ToolEndCallback}
   */
  return async (data, metadata) => {
    const output = data?.output;
    if (!output) {
      return;
    }

    if (!output.artifact) {
      return;
    }

    if (output.artifact[Tools.file_search]) {
      artifactPromises.push(
        (async () => {
          const user = req.user;
          const attachment = await processFileCitations({
            user,
            metadata,
            appConfig: req.config,
            toolArtifact: output.artifact,
            toolCallId: output.tool_call_id,
          });
          if (!attachment) {
            return null;
          }
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing file citations:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.ui_resources]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.ui_resources,
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.ui_resources]: output.artifact[Tools.ui_resources].data,
          };
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.web_search]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.web_search,
            messageId: metadata.run_id,
            toolCallId: output.tool_call_id,
            conversationId: metadata.thread_id,
            [Tools.web_search]: { ...output.artifact[Tools.web_search] },
          };
          if (!streamId && !res.headersSent) {
            return attachment;
          }
          writeAttachment(res, streamId, attachment);
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact.content) {
      /** @type {FormattedContent[]} */
      const content = output.artifact.content;
      for (let i = 0; i < content.length; i++) {
        const part = content[i];
        if (!part) {
          continue;
        }
        if (part.type !== 'image_url') {
          continue;
        }
        const { url } = part.image_url;
        artifactPromises.push(
          (async () => {
            const filename = `${output.name}_img_${nanoid()}`;
            const file_id = output.artifact.file_ids?.[i];
            const file = await saveBase64Image(url, {
              req,
              file_id,
              filename,
              endpoint: metadata.provider,
              context: FileContext.image_generation,
            });
            const fileMetadata = Object.assign(file, {
              messageId: metadata.run_id,
              toolCallId: output.tool_call_id,
              conversationId: metadata.thread_id,
            });
            if (!streamId && !res.headersSent) {
              return fileMetadata;
            }

            if (!fileMetadata) {
              return null;
            }

            writeAttachment(res, streamId, fileMetadata);
            return fileMetadata;
          })().catch((error) => {
            logger.error('Error processing artifact content:', error);
            return null;
          }),
        );
      }
      return;
    }

    if (!isCodeArtifactToolOutput(output)) {
      return;
    }

    if (!output.artifact.files) {
      return;
    }

    for (const file of output.artifact.files) {
      /* `inherited` files are unchanged passthroughs of inputs the caller
       * already owns (skill files, prior session inputs, inherited
       * .dirkeep markers). Skip post-processing: re-downloading with the
       * user's session key 403s when the file is entity-scoped, and the
       * input is already persisted at its origin. They remain available
       * to subsequent calls via primeInvokedSkills / session inheritance. */
      if (file.inherited) {
        continue;
      }
      const { id, name } = file;
      const toolCallId = output.tool_call_id;
      artifactPromises.push(
        (async () => {
          const result = await processCodeOutput({
            req,
            id,
            name,
            messageId: metadata.run_id,
            toolCallId,
            conversationId: metadata.thread_id,
            /**
             * Use the FILE's `storage_session_id` (storage session),
             * not the top-level artifact `session_id` (exec session).
             * The codeapi worker reports two distinct ids on a tool
             * result:
             *   - `artifact.session_id` is the EXEC session — the
             *     sandbox VM that ran the bash command. Files don't
             *     live there; it's torn down post-execution.
             *   - `file.storage_session_id` is the STORAGE session —
             *     the file-server bucket prefix where artifacts
             *     actually live and are served from.
             * `processCodeOutput` builds `/download/{session_id}/{id}`,
             * so passing the exec id resolves to a path the file-server
             * doesn't know about and 404s. Fall back to artifact-level
             * for older worker payloads that may not populate per-file
             * ids.
             */
            session_id: file.storage_session_id ?? output.artifact.session_id,
          });
          const fileMetadata = result?.file ?? null;
          const finalize = result?.finalize;
          if (!fileMetadata) {
            return null;
          }
          /* Initial emit: ship the attachment to the client immediately
           * (carries `status: 'pending'` for office buckets so the UI
           * shows "preparing preview…"). The agent's response stops
           * blocking on extraction here.
           *
           * Use the shared `isStreamWritable` predicate rather than the
           * narrower `streamId || res.headersSent` check that lived
           * here before — a client disconnect mid-stream
           * (`res.writableEnded`) would otherwise hit `res.write` and
           * raise `ERR_STREAM_WRITE_AFTER_END` (caught by the outer
           * IIFE catch but logged as noise). Same gate the Responses
           * path uses below. */
          if (isStreamWritable(res, streamId)) {
            writeAttachment(res, streamId, fileMetadata);
          }
          /* Deferred preview rendering: extraction continues running
           * even after the HTTP response closes. If the stream is still
           * open when the preview resolves, push an `attachment`
           * update event so the UI patches in place; otherwise React
           * Query polling on `/api/files/:file_id/preview` picks it up.
           *
           * Spread the full updated record (mirroring the initial emit
           * shape) and overlay `messageId`/`toolCallId` from the
           * current run. The DB record preserves the original
           * `messageId` across cross-turn filename reuse so
           * `getCodeGeneratedFiles` can trace the file back to its
           * original assistant message; routing the update SSE by the
           * persisted id would land the patch on a stale message
           * slot — turn-N's pending placeholder would stay stuck while
           * turn-1's already-resolved attachment got re-merged.
           * (Codex P1 review on PR #12957.) */
          runPreviewFinalize({
            finalize,
            fileId: fileMetadata.file_id,
            previewRevision: result?.previewRevision,
            onResolved: (updated) => {
              writeAttachmentUpdate(res, streamId, {
                ...updated,
                messageId: metadata.run_id,
                toolCallId,
              });
            },
          });
          return fileMetadata;
        })().catch((error) => {
          logger.error('Error processing code output:', error);
          return null;
        }),
      );
    }
  };
}

/**
 * Helper to write attachment events in Open Responses format (librechat:attachment)
 * @param {ServerResponse} res - The server response object
 * @param {Object} tracker - The response tracker with sequence number
 * @param {Object} attachment - The attachment data
 * @param {Object} metadata - Additional metadata (messageId, conversationId)
 */
function writeResponsesAttachment(res, tracker, attachment, metadata) {
  const sequenceNumber = tracker.nextSequence();
  writeAttachmentEvent(res, sequenceNumber, attachment, {
    messageId: metadata.run_id,
    conversationId: metadata.thread_id,
  });
}

/**
 * Creates a tool end callback specifically for the Responses API.
 * Emits attachments as `librechat:attachment` events per the Open Responses extension spec.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req
 * @param {ServerResponse} params.res
 * @param {Object} params.tracker - Response tracker with sequence number
 * @param {Promise<MongoFile | { filename: string; filepath: string; expires: number;} | null>[]} params.artifactPromises
 * @returns {ToolEndCallback} The tool end callback.
 */
function createResponsesToolEndCallback({ req, res, tracker, artifactPromises }) {
  /**
   * @type {ToolEndCallback}
   */
  return async (data, metadata) => {
    const output = data?.output;
    if (!output) {
      return;
    }

    if (!output.artifact) {
      return;
    }

    if (output.artifact[Tools.file_search]) {
      artifactPromises.push(
        (async () => {
          const user = req.user;
          const attachment = await processFileCitations({
            user,
            metadata,
            appConfig: req.config,
            toolArtifact: output.artifact,
            toolCallId: output.tool_call_id,
          });
          if (!attachment) {
            return null;
          }
          // For Responses API, emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing file citations:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.ui_resources]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.ui_resources,
            toolCallId: output.tool_call_id,
            [Tools.ui_resources]: output.artifact[Tools.ui_resources].data,
          };
          // For Responses API, always emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact[Tools.web_search]) {
      artifactPromises.push(
        (async () => {
          const attachment = {
            type: Tools.web_search,
            toolCallId: output.tool_call_id,
            [Tools.web_search]: { ...output.artifact[Tools.web_search] },
          };
          // For Responses API, always emit attachment during streaming
          if (res.headersSent && !res.writableEnded) {
            writeResponsesAttachment(res, tracker, attachment, metadata);
          }
          return attachment;
        })().catch((error) => {
          logger.error('Error processing artifact content:', error);
          return null;
        }),
      );
    }

    if (output.artifact.content) {
      /** @type {FormattedContent[]} */
      const content = output.artifact.content;
      for (let i = 0; i < content.length; i++) {
        const part = content[i];
        if (!part) {
          continue;
        }
        if (part.type !== 'image_url') {
          continue;
        }
        const { url } = part.image_url;
        artifactPromises.push(
          (async () => {
            const filename = `${output.name}_img_${nanoid()}`;
            const file_id = output.artifact.file_ids?.[i];
            const file = await saveBase64Image(url, {
              req,
              file_id,
              filename,
              endpoint: metadata.provider,
              context: FileContext.image_generation,
            });
            const fileMetadata = Object.assign(file, {
              toolCallId: output.tool_call_id,
            });

            if (!fileMetadata) {
              return null;
            }

            // For Responses API, emit attachment during streaming
            if (res.headersSent && !res.writableEnded) {
              const attachment = {
                file_id: fileMetadata.file_id,
                filename: fileMetadata.filename,
                type: fileMetadata.type,
                url: fileMetadata.filepath,
                width: fileMetadata.width,
                height: fileMetadata.height,
                tool_call_id: output.tool_call_id,
              };
              writeResponsesAttachment(res, tracker, attachment, metadata);
            }

            return fileMetadata;
          })().catch((error) => {
            logger.error('Error processing artifact content:', error);
            return null;
          }),
        );
      }
      return;
    }

    if (!isCodeArtifactToolOutput(output)) {
      return;
    }

    if (!output.artifact.files) {
      return;
    }

    for (const file of output.artifact.files) {
      /* `inherited` files are unchanged passthroughs of inputs the caller
       * already owns (skill files, prior session inputs, inherited
       * .dirkeep markers). Skip post-processing: re-downloading with the
       * user's session key 403s when the file is entity-scoped, and the
       * input is already persisted at its origin. They remain available
       * to subsequent calls via primeInvokedSkills / session inheritance. */
      if (file.inherited) {
        continue;
      }
      const { id, name } = file;
      const toolCallId = output.tool_call_id;
      artifactPromises.push(
        (async () => {
          const result = await processCodeOutput({
            req,
            id,
            name,
            messageId: metadata.run_id,
            toolCallId,
            conversationId: metadata.thread_id,
            /**
             * Use the FILE's `storage_session_id` (storage session),
             * not the top-level artifact `session_id` (exec session).
             * The codeapi worker reports two distinct ids on a tool
             * result:
             *   - `artifact.session_id` is the EXEC session — the
             *     sandbox VM that ran the bash command. Files don't
             *     live there; it's torn down post-execution.
             *   - `file.storage_session_id` is the STORAGE session —
             *     the file-server bucket prefix where artifacts
             *     actually live and are served from.
             * `processCodeOutput` builds `/download/{session_id}/{id}`,
             * so passing the exec id resolves to a path the file-server
             * doesn't know about and 404s. Fall back to artifact-level
             * for older worker payloads that may not populate per-file
             * ids.
             */
            session_id: file.storage_session_id ?? output.artifact.session_id,
          });
          const fileMetadata = result?.file ?? null;
          const finalize = result?.finalize;
          if (!fileMetadata) {
            return null;
          }

          /* Initial emit (Open Responses extension format). The agent's
           * response no longer blocks on extraction. */
          if (isStreamWritable(res, null)) {
            writeResponsesAttachment(
              res,
              tracker,
              buildResponsesAttachment(fileMetadata, toolCallId),
              metadata,
            );
          }

          /* Deferred preview rendering: extract HTML in the background
           * and emit a follow-up `librechat:attachment` with the same
           * `file_id` so the client merges the resolved record over the
           * pending placeholder. Fire-and-forget — survives response
           * close; polling covers the post-close gap. */
          runPreviewFinalize({
            finalize,
            fileId: fileMetadata.file_id,
            previewRevision: result?.previewRevision,
            onResolved: (updated) => {
              if (!isStreamWritable(res, null)) {
                return;
              }
              writeResponsesAttachment(
                res,
                tracker,
                buildResponsesAttachment(updated, toolCallId),
                metadata,
              );
            },
          });

          return fileMetadata;
        })().catch((error) => {
          logger.error('Error processing code output:', error);
          return null;
        }),
      );
    }
  };
}

/**
 * Project a file metadata record into the Open Responses attachment
 * shape. Mirrors the legacy inline projection but adds `status` and
 * `previewError` so deferred preview updates carry the lifecycle
 * signal the client uses to upsert by `file_id`.
 */
function buildResponsesAttachment(fileMetadata, toolCallId) {
  return {
    file_id: fileMetadata.file_id,
    filename: fileMetadata.filename,
    type: fileMetadata.type,
    url: fileMetadata.filepath,
    width: fileMetadata.width,
    height: fileMetadata.height,
    tool_call_id: toolCallId,
    text: fileMetadata.text ?? null,
    textFormat: fileMetadata.textFormat ?? null,
    status: fileMetadata.status,
    previewError: fileMetadata.previewError,
  };
}

const ALLOWED_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function agentLogHandler(_event, data) {
  if (!data) {
    return;
  }
  const logFn = ALLOWED_LOG_LEVELS.has(data.level) ? logger[data.level] : logger.debug;
  const meta = typeof data.data === 'object' && data.data != null ? data.data : {};
  logFn(`[agents:${data.scope ?? 'unknown'}] ${data.message ?? ''}`, {
    ...meta,
    runId: data.runId,
    agentId: data.agentId,
  });
}

function markSummarizationUsage(usage, metadata) {
  const node = metadata?.langgraph_node;
  if (typeof node === 'string' && node.startsWith(GraphNodeKeys.SUMMARIZE)) {
    return { ...usage, usage_type: 'summarization' };
  }
  return usage;
}

// [knauf] Share Azure Model Router backing-model extraction across every agent API path. KK20-227.
function getResponseModel(data) {
  const responseMetadata = data?.output?.response_metadata;
  const initialModel = responseMetadata?.model_name;
  const completedModel = responseMetadata?.model;

  // LangChain concatenates created.model and completed.model across streamed chunks.
  if (
    typeof initialModel === 'string' &&
    initialModel.toLowerCase().includes('model-router') &&
    typeof completedModel === 'string'
  ) {
    return completedModel.startsWith(initialModel)
      ? completedModel.slice(initialModel.length) || initialModel
      : completedModel;
  }

  return initialModel ?? completedModel ?? responseMetadata?.modelName;
}
// End [knauf]

const agentLogHandlerObj = { handle: agentLogHandler };

/**
 * Builds the three summarization SSE event handlers.
 * In streaming mode, each event is forwarded to the client via `res.write`.
 * In non-streaming mode, the handlers are no-ops.
 * @param {{ isStreaming: boolean, res: import('express').Response }} opts
 */
function buildSummarizationHandlers({ isStreaming, res }) {
  if (!isStreaming) {
    const noop = { handle: () => {} };
    return { on_summarize_start: noop, on_summarize_delta: noop, on_summarize_complete: noop };
  }
  const writeEvent = (name) => ({
    handle: async (_event, data) => {
      if (!res.writableEnded) {
        res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    },
  });
  return {
    on_summarize_start: writeEvent('on_summarize_start'),
    on_summarize_delta: writeEvent('on_summarize_delta'),
    on_summarize_complete: writeEvent('on_summarize_complete'),
  };
}

module.exports = {
  ModelEndHandler,
  agentLogHandler,
  agentLogHandlerObj,
  getDefaultHandlers,
  createToolEndCallback,
  isStreamWritable,
  markSummarizationUsage,
  getResponseModel,
  buildSummarizationHandlers,
  createResponsesToolEndCallback,
  // [knauf] KK20-194 — bounded model refusal and output-limit recovery helpers.
  createModelRetryHandler,
  isOutputTruncated,
  isZeroUsageGenericRefusal,
  stampLangfuseResponseModel,
  stripRetriedModelOutput,
  // End [knauf]
};
