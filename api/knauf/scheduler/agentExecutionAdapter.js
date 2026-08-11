'use strict';

const { randomUUID } = require('node:crypto');
const { createSchedulerRequestHeaders, BROWSER_USER_AGENT } = require('./internalRequest');

const MAX_ERROR_BODY_CHARS = 500;
const MAX_RESPONSE_PREVIEW_CHARS = 1_000;
const NO_PARENT_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';

class AgentExecutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

class AgentStreamInterruptedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AgentStreamInterruptedError';
  }
}

async function readErrorBody(response) {
  const body = await response.text();
  return body.slice(0, MAX_ERROR_BODY_CHARS);
}

async function assertOk(response, operation) {
  if (response.ok) {
    return;
  }
  const detail = await readErrorBody(response);
  throw new Error(`${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

function parseSseEvent(block) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return { eventName, data: JSON.parse(dataLines.join('\n')) };
}

async function waitForFinalEvent(response, signal) {
  if (response.body == null) {
    throw new AgentStreamInterruptedError('Agent stream response has no body');
  }

  let buffer = '';
  try {
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const separatorLength = buffer[boundary] === '\r' ? 4 : 2;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separatorLength);
        const event = parseSseEvent(block);
        if (event?.eventName === 'error') {
          throw new AgentExecutionError(
            `Agent stream failed: ${event.data?.error ?? 'unknown error'}`,
          );
        }
        if (event?.data?.final === true) {
          return event.data;
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
  } catch (error) {
    if (error instanceof AgentExecutionError || signal?.aborted) {
      throw error;
    }
    throw new AgentStreamInterruptedError('Agent stream ended before a final event', {
      cause: error,
    });
  }
  throw new AgentStreamInterruptedError('Agent stream ended before a final event');
}

function createRunResult(finalEvent, fallbackConversationId) {
  const response = finalEvent.responseMessage ?? {};
  const conversationId = finalEvent.conversation?.conversationId ?? fallbackConversationId;
  if (response.unfinished === true) {
    return {
      status: 'interrupted',
      conversationId,
    };
  }
  const structuredError =
    finalEvent.error != null && typeof finalEvent.error === 'object' ? finalEvent.error : null;
  if (
    structuredError != null ||
    response.error === true ||
    (finalEvent.conversation != null && finalEvent.responseMessage == null)
  ) {
    throw new AgentExecutionError(
      (typeof structuredError?.message === 'string' && structuredError.message) ||
        (typeof response.text === 'string' && response.text) ||
        'The scheduled agent request failed',
    );
  }
  const text = typeof response.text === 'string' ? response.text : '';
  return {
    conversationId,
    messageId: response.messageId,
    title: finalEvent.title ?? finalEvent.conversation?.title,
    responsePreview: text.slice(0, MAX_RESPONSE_PREVIEW_CHARS),
  };
}

function createAgentExecutionAdapter({
  apiBaseUrl,
  getUserById,
  generateToken,
  getProject,
  resolveAgent,
  internalSecret,
  isUserDeleting = async () => false,
  fetchImpl = fetch,
  tokenLifetimeMs = 15 * 60_000,
  abortCleanupTimeoutMs = 5_000,
  logger = console,
}) {
  if (
    !apiBaseUrl ||
    typeof getUserById !== 'function' ||
    typeof generateToken !== 'function' ||
    typeof getProject !== 'function' ||
    typeof resolveAgent !== 'function' ||
    !internalSecret
  ) {
    throw new TypeError(
      'apiBaseUrl, getUserById, generateToken, getProject, resolveAgent, and internalSecret are required',
    );
  }
  const baseUrl = apiBaseUrl.replace(/\/+$/, '');

  const createAuthenticatedHeaders = async ({ user, userId, trigger, method, path }) => {
    const token = await generateToken(user, tokenLifetimeMs);
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': BROWSER_USER_AGENT,
      ...createSchedulerRequestHeaders({
        secret: internalSecret,
        userId,
        trigger,
        method,
        path,
      }),
    };
  };

  return async function executeScheduledAgent({ run, signal }) {
    if (await isUserDeleting(run.ownerId)) {
      throw new Error(`Schedule owner ${run.ownerId} is being deleted`);
    }
    const user = await getUserById(run.ownerId);
    if (user == null) {
      throw new Error(`Schedule owner ${run.ownerId} no longer exists`);
    }
    if (run.execution?.preflightError) {
      throw new Error(run.execution.preflightError);
    }
    const resolvedAgent = await resolveAgent(run.agentId, user);
    if (resolvedAgent == null) {
      throw new Error('Scheduled agent no longer exists or is not editable');
    }
    const agentSnapshot = run.execution?.agentSnapshot ?? resolvedAgent.snapshot;
    if (agentSnapshot == null) {
      throw new Error('Scheduled agent snapshot is unavailable');
    }
    if (
      typeof run.chatProjectId !== 'string' ||
      run.chatProjectId.length === 0 ||
      (await getProject(run.ownerId, run.chatProjectId)) == null
    ) {
      throw new Error('Scheduled chat project no longer exists');
    }
    const trigger = run.trigger === 'manual' ? 'manual' : 'automatic';
    const startPath = '/api/agents/chat/agents';
    const messageId = randomUUID();
    let streamId = run.conversationId;

    try {
      if (run.recovered === true) {
        if (typeof streamId !== 'string' || streamId.length === 0) {
          return {
            status: 'interrupted',
            interruptionReason: 'agent_job_identity_unavailable',
          };
        }
      } else {
        const startHeaders = await createAuthenticatedHeaders({
          user,
          userId: run.ownerId,
          trigger,
          method: 'POST',
          path: startPath,
        });
        const startResponse = await fetchImpl(`${baseUrl}${startPath}`, {
          method: 'POST',
          headers: startHeaders,
          signal,
          body: JSON.stringify({
            text: run.prompt,
            sender: user.name || user.username || 'User',
            endpoint: 'agents',
            agent_id: run.agentId,
            knaufAgentSnapshot: agentSnapshot,
            conversationId: streamId ?? 'new',
            parentMessageId: NO_PARENT_MESSAGE_ID,
            messageId,
            isCreatedByUser: true,
            isRegenerate: false,
            isTemporary: false,
            timezone: run.timezone,
            chatProjectId: run.chatProjectId,
          }),
        });
        await assertOk(startResponse, 'Scheduled agent start');
        const started = await startResponse.json();
        streamId = started.streamId;
        if (typeof streamId !== 'string' || streamId.length === 0) {
          throw new Error('Scheduled agent start did not return a streamId');
        }
      }

      const streamPath = `/api/agents/chat/stream/${encodeURIComponent(streamId)}${
        run.recovered === true ? '?resume=true' : ''
      }`;
      const streamHeaders = await createAuthenticatedHeaders({
        user,
        userId: run.ownerId,
        trigger,
        method: 'GET',
        path: streamPath,
      });
      const streamResponse = await fetchImpl(`${baseUrl}${streamPath}`, {
        headers: streamHeaders,
        signal,
      });
      if (run.recovered === true && streamResponse.status === 404) {
        return {
          status: 'interrupted',
          conversationId: streamId,
          interruptionReason: 'agent_job_unavailable_after_recovery',
        };
      }
      await assertOk(streamResponse, 'Scheduled agent stream');
      const finalEvent = await waitForFinalEvent(streamResponse, signal);
      return createRunResult(finalEvent, streamId);
    } catch (error) {
      if ((signal?.aborted || error instanceof AgentStreamInterruptedError) && streamId) {
        const abortController = new AbortController();
        const abortTimer = setTimeout(
          () => abortController.abort(new Error('Scheduled agent abort cleanup timed out')),
          abortCleanupTimeoutMs,
        );
        abortTimer.unref?.();
        try {
          const abortPath = '/api/agents/chat/abort';
          const abortHeaders = await createAuthenticatedHeaders({
            user,
            userId: run.ownerId,
            trigger,
            method: 'POST',
            path: abortPath,
          });
          const abortResponse = await fetchImpl(`${baseUrl}${abortPath}`, {
            method: 'POST',
            headers: abortHeaders,
            signal: abortController.signal,
            body: JSON.stringify({ streamId }),
          });
          await assertOk(abortResponse, 'Scheduled agent abort');
        } catch (abortError) {
          logger.warn?.(`[scheduler] abort cleanup failed for ${streamId}: ${abortError.message}`);
        } finally {
          clearTimeout(abortTimer);
        }
      }
      if (error instanceof AgentStreamInterruptedError) {
        return {
          status: 'interrupted',
          conversationId: streamId,
          interruptionReason: 'agent_stream_incomplete',
        };
      }
      throw error;
    }
  };
}

module.exports = {
  createAgentExecutionAdapter,
  createRunResult,
  parseSseEvent,
  waitForFinalEvent,
};
