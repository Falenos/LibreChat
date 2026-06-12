/**
 * POST /api/knauf/autogenerate-prompt
 *
 * One-shot completion that drafts (or polishes) an agent's system instructions
 * from the V6 agent builder's current state. Also used for template-based
 * preview generation when `sourceTemplate` is provided.
 *
 * Config source-of-truth: the `karl-autogenerate-prompt` modelSpec entry in
 * `librechat.yaml` — its `preset` carries provider, model/deployment,
 * max_completion_tokens, and promptPrefix (= the system message).
 *
 * Provider routing: getProviderConfig → initializeModel (same path used by
 * chat turns). Any YAML-configured provider works without provider-specific
 * deps in this file. Request body: bounded by `autogeneratePromptSchema`.
 * Auth: requireJwtAuth.
 */
const express = require('express');
const { z } = require('zod');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { logger, getTenantId } = require('@librechat/data-schemas');
const { getProviderConfig } = require('@librechat/api');
const { initializeModel } = require('@librechat/agents');
const { specialVariables } = require('librechat-data-provider');
const { resolveProvider, tokenLimitParam } = require('./lib/resolveProvider');
const { getAppConfig } = require('~/server/services/Config');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const SPEC_NAME = 'karl-autogenerate-prompt';

const autogeneratePromptSchema = z.object({
  agent: z.object({
    name: z.string().max(256).default(''),
    description: z.string().max(512).default(''),
    category: z.string().max(80).default(''),
    personality: z
      .object({
        label: z.string().max(64).default(''),
        description: z.string().max(200).default(''),
      })
      .default({ label: '', description: '' }),
    capabilities: z.array(z.string().max(80)).max(8).default([]),
    knowledgeFiles: z
      .array(z.object({ name: z.string().max(256), type: z.string().max(100).default('') }))
      .max(50)
      .default([]),
    tools: z.array(z.string().max(120)).max(20).default([]),
    mcpServers: z.array(z.string().max(80)).max(10).default([]),
  }),
  currentDraft: z.string().max(4000).default(''),
  sourceTemplate: z.string().max(4000).optional(),
});

/** Build the user-message body from the validated request shape. */
function buildUserMessage(input) {
  const { agent, currentDraft, sourceTemplate } = input;
  const name = agent.name.trim() || 'this agent';
  const description = agent.description.trim();
  const category = agent.category.trim();
  const personalityLabel = agent.personality.label.trim();
  const personalityDescription = agent.personality.description.trim();
  const capabilities = agent.capabilities;
  const knowledgeFiles = agent.knowledgeFiles ?? [];
  const tools = agent.tools;
  const mcpServers = agent.mcpServers;

  const categoryLine = category ? `Category: ${category}` : '';
  const personalityLine = personalityLabel
    ? personalityDescription
      ? `Personality: ${personalityLabel} — ${personalityDescription}`
      : `Personality: ${personalityLabel}`
    : '';
  const capLine =
    capabilities.length > 0
      ? `What it can do: ${capabilities.join(', ')}`
      : 'What it can do: reply from its own knowledge only';
  let knowledgeLine = '';
  if (knowledgeFiles.length > 0) {
    const fileList = knowledgeFiles.map((f) => f.name).join(', ');
    knowledgeLine = `Knowledge files (${knowledgeFiles.length}): ${fileList}`;
  }
  // Tools and MCP get their own lines so the drafter knows they're
  // *callable* (not just a vague capability). Helps the model write
  // instructions like "use the X tool when ...".
  const toolsLine = tools.length > 0 ? `Tools available: ${tools.join(', ')}` : '';
  const mcpLine =
    mcpServers.length > 0 ? `MCP servers connected: ${mcpServers.join(', ')}` : '';
  const descLine = description ? `What it's for: ${description}` : '';

  // Substitution tokens — sourced from the canonical `specialVariables`
  // list in librechat-data-provider. The platform replaces these at chat
  // time via `replaceSpecialVars()`. Surfacing them here lets the drafter
  // emit them where genuinely useful (e.g. time-aware agents).
  const variableTokens = Object.keys(specialVariables).map((k) => `{{${k}}}`);
  const variablesLine = `Available variables (replaced at chat time): ${variableTokens.join(', ')}`;

  const lines = [
    `Agent name: ${name}`,
    descLine,
    categoryLine,
    personalityLine,
    capLine,
    knowledgeLine,
    toolsLine,
    mcpLine,
    variablesLine,
  ].filter(Boolean);

  if (currentDraft.trim()) {
    lines.push('');
    lines.push("User's draft:");
    lines.push('"""');
    lines.push(currentDraft.trim());
    lines.push('"""');
  }

  if (sourceTemplate && sourceTemplate.trim()) {
    lines.push('');
    lines.push('Reference template (follow its structural pattern):');
    lines.push('"""');
    lines.push(sourceTemplate.trim());
    lines.push('"""');
  }

  return lines.join('\n');
}

const router = express.Router();
router.use(requireJwtAuth);

router.post('/', express.json({ limit: '32kb' }), async (req, res) => {
  const parseResult = autogeneratePromptSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      message: 'Invalid request body.',
      issues: parseResult.error.issues,
    });
  }
  const input = parseResult.data;

  try {
    const appConfig = await getAppConfig({
      role: req.user?.role,
      userId: req.user?.id,
      tenantId: req.user?.tenantId || getTenantId(),
    });

    // 1. Resolve the autogenerate spec from modelSpecs.
    const spec = (appConfig?.modelSpecs?.list ?? []).find(
      (s) => s?.name === SPEC_NAME,
    );
    const provider = spec?.preset?.endpoint;
    const model = spec?.preset?.model;
    if (!provider || !model) {
      logger.warn(
        `[knauf autogenerate-prompt] modelSpec '${SPEC_NAME}' missing preset.endpoint or preset.model`,
      );
      return res
        .status(500)
        .json({ message: 'Autogenerate is not configured on this deployment.' });
    }

    // 2. Walk the same provider-routing path the regular chat turn uses.
    //    `getOptions` resolves env-var API keys, Azure deployment mapping,
    //    custom-endpoint baseURL/headers, and returns a langchain-shaped
    //    `llmConfig` we can hand straight to ChatOpenAI/AzureChatOpenAI.
    let getOptions;
    try {
      ({ getOptions } = getProviderConfig({ provider, appConfig }));
    } catch (cfgErr) {
      logger.warn(
        `[knauf autogenerate-prompt] getProviderConfig failed for provider '${provider}': ${cfgErr?.message}`,
      );
      return res
        .status(500)
        .json({ message: 'Autogenerate is not configured on this deployment.' });
    }

    // Synthetic req: only initialize* needs `config`, `body.key`, and `user`.
    // Re-using the live req would surface our route body as `req.body.key`,
    // tripping the BYOK code path inside initializeOpenAI.
    const initReq = { user: req.user, body: {}, config: appConfig };

    const options = await getOptions({
      req: initReq,
      endpoint: provider,
      model_parameters: { model },
      db: { getUserKey: db.getUserKey, getUserKeyValues: db.getUserKeyValues },
    });

    const llmConfig = options?.llmConfig ?? {};

    // 3. Build the chat model via initializeModel (provider-agnostic).
    const { provider: resolvedProvider, useResponsesApi } = resolveProvider({
      provider,
      llmConfig,
    });

    const maxCompletionTokens = spec.preset.max_completion_tokens;
    const modelKwargs = { ...(llmConfig.modelKwargs ?? {}) };
    if (typeof maxCompletionTokens === 'number') {
      modelKwargs[tokenLimitParam(useResponsesApi)] = maxCompletionTokens;
    }

    let client;
    try {
      client = initializeModel({
        provider: resolvedProvider,
        clientOptions: {
          ...llmConfig,
          streaming: false,
          disableStreaming: true,
          modelKwargs,
          configuration: options.configOptions,
        },
      });
    } catch (initErr) {
      logger.warn(
        `[knauf autogenerate-prompt] initializeModel failed for provider '${provider}': ${initErr?.message}`,
      );
      return res
        .status(500)
        .json({ message: 'Autogenerate is not configured on this deployment.' });
    }

    // 4. Compose system + user messages.
    const systemMsg =
      typeof spec.preset.promptPrefix === 'string'
        ? spec.preset.promptPrefix.slice(0, 8_000)
        : '';
    const userMsg = buildUserMessage(input);

    const response = await client.invoke([
      ...(systemMsg ? [new SystemMessage(systemMsg)] : []),
      new HumanMessage(userMsg),
    ]);

    const raw = response?.content;
    const text = (typeof raw === 'string' ? raw : Array.isArray(raw)
      ? raw
          .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
          .join('')
      : ''
    ).trim();
    if (!text) {
      logger.warn('[knauf autogenerate-prompt] Empty completion from provider.');
      return res.status(502).json({ message: 'No draft was returned.' });
    }

    return res.json({ text });
  } catch (err) {
    logger.error('[knauf autogenerate-prompt] Error', err);
    return res
      .status(err?.status ?? 500)
      .json({ message: err?.message ?? 'Failed to autogenerate prompt.' });
  }
});

module.exports = router;
module.exports.buildUserMessage = buildUserMessage;
