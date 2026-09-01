import { logger } from '@librechat/data-schemas';
import {
  Tools,
  Constants,
  isAgentsEndpoint,
  isEphemeralAgentId,
  encodeEphemeralAgentId,
  // [knauf] KK20-297 — keep source code outside deterministic translation.
  isKnaufSourceCodeFile,
  // End [knauf]
} from 'librechat-data-provider';
import type {
  AgentModelParameters,
  TEphemeralAgent,
  TModelSpec,
  Agent,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { requiresEphemeralUserConnection } from '~/mcp/utils';
import { getCustomEndpointConfig } from '~/app/config';

const { mcp_all, mcp_delimiter } = Constants;
// [knauf] NO-TICKET — runtime-only tool for exact, owned artifact edits.
const EDIT_ARTIFACT_TOOL = 'edit_artifact';
// End [knauf]
// [knauf] KK20-297 — request-only tool for translatable Knauf upload formats.
const FILE_TRANSLATE_TOOL = 'translate_file';
const TRANSLATION_STATUS_TOOL = 'translation_status';
const IDML_EDIT_TOOL = 'edit_idml';
const XML_EDIT_TOOL = 'edit_xml';
const REQUEST_SCOPED_FILE_TOOLS = new Set([
  FILE_TRANSLATE_TOOL,
  TRANSLATION_STATUS_TOOL,
  IDML_EDIT_TOOL,
  XML_EDIT_TOOL,
]);
const IDML_EXTENSION = /\.idml$/i;
const IDML_MIME_TYPE = 'application/vnd.adobe.indesign-idml-package';
const XML_EXTENSION = /\.xml$/i;
const XML_MIME_TYPES = new Set(['application/xml', 'text/xml']);
const TRANSLATABLE_EXTENSIONS =
  /\.(?:idml|pdf|docx|pptx|xlsx|csv|txt|md|markdown|json|xml|svg|png|jpe?g|webp)$/i;
const TRANSLATABLE_MIME_TYPES = new Set([
  'application/vnd.adobe.indesign-idml-package',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/csv',
  'application/json',
  'application/xml',
  'text/csv',
  'text/plain',
  'text/markdown',
  'text/xml',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
]);
// End [knauf]
type ModelParametersWithPromptPrefix = AgentModelParameters & { promptPrefix?: string | null };

// [knauf] KK20-297 — keep deterministic translation request-scoped and fail closed
// unless both the rollout switch and provider credentials are present.
export type RequestFile = { file_id?: string; filename?: string; name?: string; type?: string };

function isFileTranslationConfigured(): boolean {
  return (
    process.env.KNAUF_FILE_TRANSLATION_ENABLED === 'true' &&
    Boolean(process.env.AZURE_TRANSLATOR_ENDPOINT && process.env.AZURE_TRANSLATOR_KEY)
  );
}

function hasTranslatableRequestFile(files: readonly RequestFile[]): boolean {
  return files.some(
    (file) =>
      !isKnaufSourceCodeFile(file.filename ?? file.name ?? '', file.type) &&
      (TRANSLATABLE_MIME_TYPES.has(file.type ?? '') ||
        TRANSLATABLE_EXTENSIONS.test(file.filename ?? file.name ?? '')),
  );
}

function hasIdmlRequestFile(files: readonly RequestFile[]): boolean {
  return files.some(
    (file) => file.type === IDML_MIME_TYPE || IDML_EXTENSION.test(file.filename ?? file.name ?? ''),
  );
}

function hasXmlRequestFile(files: readonly RequestFile[]): boolean {
  return files.some(
    (file) =>
      XML_MIME_TYPES.has(file.type ?? '') || XML_EXTENSION.test(file.filename ?? file.name ?? ''),
  );
}

export function getRequestScopedFileTools(
  files: readonly RequestFile[],
  requestPath?: string,
): string[] {
  if (isCompatibilityAgentsRoute(requestPath)) {
    return [];
  }
  const tools: string[] = [];
  if (isFileTranslationConfigured()) {
    tools.push(TRANSLATION_STATUS_TOOL);
    if (hasTranslatableRequestFile(files)) {
      tools.push(FILE_TRANSLATE_TOOL);
    }
  }
  if (hasIdmlRequestFile(files)) {
    tools.push(IDML_EDIT_TOOL);
  }
  if (hasXmlRequestFile(files)) {
    tools.push(XML_EDIT_TOOL);
  }
  return tools;
}

export function isCompatibilityAgentsRoute(requestPath?: string): boolean {
  return requestPath?.startsWith('/api/agents/v1/') === true;
}

export function filterRequestScopedFileToolNames(
  toolNames: readonly string[],
  requestPath?: string,
): string[] {
  if (!isCompatibilityAgentsRoute(requestPath)) {
    return [...toolNames];
  }
  return toolNames.filter((toolName) => !REQUEST_SCOPED_FILE_TOOLS.has(toolName));
}
// End [knauf]

export interface LoadAgentDeps {
  getAgent: (searchParameter: { id: string }) => Promise<Agent | null>;
  getMCPServerTools: (
    userId: string,
    serverName: string,
  ) => Promise<Record<string, unknown> | null>;
}

export interface LoadAgentParams {
  req: {
    originalUrl?: string;
    user?: { id?: string };
    config?: AppConfig;
    body?: {
      promptPrefix?: string;
      ephemeralAgent?: TEphemeralAgent;
      files?: RequestFile[];
    };
  };
  spec?: string;
  agent_id: string;
  endpoint: string;
  model_parameters?: AgentModelParameters & { model?: string };
}

/**
 * Load an ephemeral agent based on the request parameters.
 */
export async function loadEphemeralAgent(
  { req, spec, endpoint, model_parameters: _m }: Omit<LoadAgentParams, 'agent_id'>,
  deps: LoadAgentDeps,
): Promise<Agent | null> {
  const { model, ...model_parameters } = _m ?? ({} as unknown as AgentModelParameters);
  const modelSpecs = req.config?.modelSpecs as { list?: TModelSpec[] } | undefined;
  let modelSpec: TModelSpec | null = null;
  if (spec != null && spec !== '') {
    modelSpec = modelSpecs?.list?.find((s) => s.name === spec) ?? null;
  }
  const ephemeralAgent: TEphemeralAgent | undefined = req.body?.ephemeralAgent;
  const mcpServers = new Set<string>(ephemeralAgent?.mcp);
  const userId = req.user?.id ?? '';
  if (modelSpec?.mcpServers) {
    for (const mcpServer of modelSpec.mcpServers) {
      mcpServers.add(mcpServer);
    }
  }
  const tools: string[] = [];
  if (ephemeralAgent?.execute_code === true || modelSpec?.executeCode === true) {
    tools.push(Tools.execute_code);
  }
  if (ephemeralAgent?.file_search === true || modelSpec?.fileSearch === true) {
    tools.push(Tools.file_search);
  }
  if (ephemeralAgent?.web_search === true || modelSpec?.webSearch === true) {
    tools.push(Tools.web_search);
  }
  // [knauf] Image generation tool — surfaced in the agent-chat composer as
  // a pinnable chip backed by `image_gen` on TEphemeralAgent. The backend
  // tool toolkit auto-pairs `image_edit_oai` at request time (see
  // packages/api/src/tools/toolkits/oai.ts), so we only push the gen tool.
  // Literal string used because image_gen_oai is registered in the tools
  // registry, not the AgentCapabilities/Tools enum.
  if (ephemeralAgent?.image_gen === true) {
    tools.push('image_gen_oai');
  }
  // End [knauf]
  // [knauf] NO-TICKET — every artifact-enabled default chat can patch its
  // existing owned artifact without re-emitting the complete source.
  if (ephemeralAgent?.artifacts) {
    tools.push(EDIT_ARTIFACT_TOOL);
  }
  // End [knauf]
  // [knauf] KK20-297 — expose file translation only for this request.
  tools.push(...getRequestScopedFileTools(req.body?.files ?? [], req.originalUrl));
  // End [knauf]

  const addedServers = new Set<string>();
  if (mcpServers.size > 0) {
    for (const mcpServer of mcpServers) {
      if (addedServers.has(mcpServer)) {
        continue;
      }
      /** Request-tier overlays are invisible to the cache service's registry
       *  resolver — overlay-scoped servers expand fresh via `mcp_all` instead */
      const overlayConfig = req.config?.mcpConfig?.[mcpServer];
      const serverTools =
        overlayConfig && requiresEphemeralUserConnection(overlayConfig)
          ? null
          : await deps.getMCPServerTools(userId, mcpServer);
      if (!serverTools) {
        tools.push(`${mcp_all}${mcp_delimiter}${mcpServer}`);
        addedServers.add(mcpServer);
        continue;
      }
      tools.push(...Object.keys(serverTools));
      addedServers.add(mcpServer);
    }
  }

  const requestPromptPrefix = req.body?.promptPrefix;
  const { promptPrefix: modelPromptPrefix, ...safeModelParameters } =
    model_parameters as ModelParametersWithPromptPrefix;
  // [knauf] KK20-201 — model-spec prompts are configuration templates. Reload
  // the raw template every request so a client-rendered timezone cannot be
  // persisted and replayed after travel, midnight or a DST transition.
  const modelSpecPromptPrefix = modelSpec?.preset?.promptPrefix;
  let instructions = requestPromptPrefix;
  if (typeof modelPromptPrefix === 'string') {
    instructions = modelPromptPrefix;
  }
  if (typeof modelSpecPromptPrefix === 'string') {
    instructions = modelSpecPromptPrefix;
  }
  // End [knauf]

  // Get endpoint config for modelDisplayLabel fallback
  const appConfig = req.config;
  const endpoints = appConfig?.endpoints;
  let endpointConfig = endpoints?.[endpoint as keyof typeof endpoints];
  if (!isAgentsEndpoint(endpoint) && !endpointConfig) {
    try {
      endpointConfig = getCustomEndpointConfig({ endpoint, appConfig });
    } catch (err) {
      logger.error('[loadEphemeralAgent] Error getting custom endpoint config', err);
    }
  }

  // For ephemeral agents, use modelLabel if provided, then model spec's label,
  // then modelDisplayLabel from endpoint config, otherwise empty string to show model name
  const sender =
    (model_parameters as AgentModelParameters & { modelLabel?: string })?.modelLabel ??
    modelSpec?.label ??
    (endpointConfig as { modelDisplayLabel?: string } | undefined)?.modelDisplayLabel ??
    '';

  // Encode ephemeral agent ID with endpoint, model, and computed sender for display
  const ephemeralId = encodeEphemeralAgentId({
    endpoint,
    model: model as string,
    sender: sender as string,
  });

  const result: Partial<Agent> = {
    id: ephemeralId,
    instructions,
    provider: endpoint,
    model_parameters: safeModelParameters as AgentModelParameters,
    model,
    tools,
  };

  if (ephemeralAgent?.artifacts) {
    result.artifacts = ephemeralAgent.artifacts;
  }
  if (modelSpec?.subagents) {
    result.subagents = modelSpec.subagents;
  }
  if (modelSpec && Object.prototype.hasOwnProperty.call(modelSpec, 'skills')) {
    if (modelSpec.skills === true) {
      result.skills_enabled = true;
    } else if (modelSpec.skills === false) {
      result.skills_enabled = false;
      result.skills = [];
    } else if (Array.isArray(modelSpec.skills)) {
      result.skills_enabled = true;
      result.skills = [];
    }
  }
  return result as Agent;
}

/**
 * Load an agent based on the provided ID.
 * For ephemeral agents, builds a synthetic agent from request parameters.
 * For persistent agents, fetches from the database.
 */
export async function loadAgent(
  params: LoadAgentParams,
  deps: LoadAgentDeps,
): Promise<Agent | null> {
  const { req, spec, agent_id, endpoint, model_parameters } = params;
  if (!agent_id) {
    return null;
  }
  if (isEphemeralAgentId(agent_id)) {
    return loadEphemeralAgent({ req, spec, endpoint, model_parameters }, deps);
  }
  const agent = await deps.getAgent({ id: agent_id });

  if (!agent) {
    return null;
  }

  // Set version count from versions array length
  // [knauf] NO-TICKET — expose edit_artifact to Agent Builder agents whenever
  // their existing artifacts field is enabled. Runtime clone only: never write
  // this internal tool name back to the persisted builder configuration.
  const artifactEditingEnabled = typeof agent.artifacts === 'string' && agent.artifacts !== '';
  const runtimeTools = [...(agent.tools ?? [])];
  if (artifactEditingEnabled && !runtimeTools.includes(EDIT_ARTIFACT_TOOL)) {
    runtimeTools.push(EDIT_ARTIFACT_TOOL);
  }
  // KK20-297: same request-only injection for persistent agents.
  for (const tool of getRequestScopedFileTools(req.body?.files ?? [], req.originalUrl)) {
    if (!runtimeTools.includes(tool)) {
      runtimeTools.push(tool);
    }
  }
  const agentWithVersion = (
    runtimeTools.length === (agent.tools ?? []).length ? agent : { ...agent, tools: runtimeTools }
  ) as Agent & { versions?: unknown[]; version?: number };
  // End [knauf]
  agentWithVersion.version = agentWithVersion.versions ? agentWithVersion.versions.length : 0;
  return agentWithVersion;
}
