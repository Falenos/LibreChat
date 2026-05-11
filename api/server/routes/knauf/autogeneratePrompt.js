/**
 * POST /api/knauf/autogenerate-prompt
 *
 * One-shot completion that drafts (or polishes) an agent's system
 * instructions from the V6 agent builder's current state. Used by the ✦
 * "Autogenerate / Polish & expand" button in the Knauf overlay.
 *
 * Configuration source-of-truth: the `karl-autogenerate-prompt` entry in
 * `librechat.yaml` `modelSpecs.list`. That entry's `preset` carries the
 * provider (`endpoint`), the model/deployment, max_completion_tokens, and
 * promptPrefix (= the system message).
 *
 * Provider routing: we walk the same `getProviderConfig({ provider,
 * appConfig })` path that `packages/api/src/agents/initialize.ts` uses for
 * every chat turn to resolve credentials, then hand the resulting
 * `llmConfig` to `@librechat/agents`'s `initializeModel` — the same single
 * entry point the agent graph and summarization node use to build a chat
 * model. Net effect: any provider configured in the YAML (azureOpenAI,
 * openAI, anthropic, google, bedrock, custom, ...) works without pulling
 * provider-specific deps into this file.
 *
 * Request body: validated by `autogeneratePromptSchema` below. Nested:
 * `{ agent: { name, description, category, personality: { label, description },
 *   capabilities, knowledgeFileCount, tools, mcpServers }, currentDraft }`.
 * Defence in depth — every string field is bounded so the prompt is a
 * fixed-shape input. The `tools` and `mcpServers` arrays carry display
 * names of the agent's selected tools / connected MCP servers so the
 * drafter can write "use the X tool when …" guidance. The user message
 * also lists the canonical `specialVariables` tokens
 * ({{current_date}}, …) so the drafter can emit them for time- or
 * audience-aware framing.
 *
 * Auth: requireJwtAuth, same as every Knauf-relevant route.
 */
const express = require('express');
const { z } = require('zod');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { logger, getTenantId } = require('@librechat/data-schemas');
const { getProviderConfig } = require('@librechat/api');
const { initializeModel } = require('@librechat/agents');
const { specialVariables } = require('librechat-data-provider');
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
    knowledgeFileCount: z.number().int().min(0).max(99).default(0),
    tools: z.array(z.string().max(120)).max(20).default([]),
    mcpServers: z.array(z.string().max(80)).max(10).default([]),
  }),
  currentDraft: z.string().max(4000).default(''),
});

/** Build the user-message body from the validated request shape. */
function buildUserMessage(input) {
  const { agent, currentDraft } = input;
  const name = agent.name.trim() || 'this agent';
  const description = agent.description.trim();
  const category = agent.category.trim();
  const personalityLabel = agent.personality.label.trim();
  const personalityDescription = agent.personality.description.trim();
  const capabilities = agent.capabilities;
  const knowledgeFileCount = agent.knowledgeFileCount;
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
  const knowledgeLine =
    knowledgeFileCount > 0
      ? `Knowledge: ${knowledgeFileCount} attached document${knowledgeFileCount === 1 ? '' : 's'}.`
      : '';
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

    // 3. Build the chat model via `@librechat/agents`'s `initializeModel` —
    //    the single entry point the agent graph and summarization node use.
    //    It dispatches on `provider` to the right LangChain class
    //    (ChatOpenAI / AzureChatOpenAI / ChatAnthropic / ChatVertexAI /
    //    ChatBedrockConverse / …) and applies provider-specific field
    //    assignments, so this route works for any endpoint configured in
    //    `librechat.yaml` modelSpecs without provider-specific deps here.
    const maxCompletionTokens = spec.preset.max_completion_tokens;
    const modelKwargs = { ...(llmConfig.modelKwargs ?? {}) };
    if (typeof maxCompletionTokens === 'number') {
      modelKwargs.max_completion_tokens = maxCompletionTokens;
    }

    let client;
    try {
      client = initializeModel({
        provider,
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
