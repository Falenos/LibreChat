import { logger } from '@librechat/data-schemas';
import { AgentCapabilities, EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { createEndpointsConfigService } from '~/endpoints/config/endpoints';
import { _resetKnaufCodeEnvWarning } from './codeEnvGuard';

/**
 * [knauf] KK20-257. Proves the fail-closed guard is wired at the choke point that every
 * consumer reads — the served endpoints config (client attach menu + tabular routing),
 * `checkCapability` (upload gate) and `codeEnvAvailable` (tool registration) all derive
 * from `endpoints.agents.capabilities`. If this filter regresses, a deployment missing
 * LIBRECHAT_CODE_BASEURL would POST user files to LibreChat's hosted SaaS.
 */
describe('[knauf] execute_code capability is fail-closed on LIBRECHAT_CODE_BASEURL', () => {
  const ORIGINAL = process.env.LIBRECHAT_CODE_BASEURL;

  const deps = (capabilities: AgentCapabilities[]) => ({
    getAppConfig: jest.fn().mockResolvedValue({
      endpoints: { [EModelEndpoint.agents]: { capabilities } },
    } as unknown as AppConfig),
    loadDefaultEndpointsConfig: jest.fn().mockResolvedValue({
      [EModelEndpoint.agents]: { userProvide: false, order: 0 },
    }),
    loadCustomEndpointsConfig: jest.fn().mockReturnValue(undefined),
  });

  const req = () => ({ user: { id: 'u1', role: 'USER' } }) as ServerRequest;

  const ALL = [
    AgentCapabilities.file_search,
    AgentCapabilities.tools,
    AgentCapabilities.artifacts,
    AgentCapabilities.execute_code,
  ];

  beforeEach(() => {
    _resetKnaufCodeEnvWarning();
    jest.restoreAllMocks();
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterAll(() => {
    process.env.LIBRECHAT_CODE_BASEURL = ORIGINAL;
  });

  it('keeps execute_code when the adapter URL is configured', async () => {
    process.env.LIBRECHAT_CODE_BASEURL = 'http://agentic-karl-code-adapter:3112/v1';
    const { getEndpointsConfig, checkCapability } = createEndpointsConfigService(deps(ALL));

    const config = await getEndpointsConfig(req());
    expect(config?.[EModelEndpoint.agents]?.capabilities).toEqual(ALL);
    await expect(checkCapability(req(), AgentCapabilities.execute_code)).resolves.toBe(true);
  });

  it('strips execute_code — and nothing else — when the URL is unset', async () => {
    delete process.env.LIBRECHAT_CODE_BASEURL;
    const { getEndpointsConfig, checkCapability } = createEndpointsConfigService(deps(ALL));

    const config = await getEndpointsConfig(req());
    expect(config?.[EModelEndpoint.agents]?.capabilities).toEqual([
      AgentCapabilities.file_search,
      AgentCapabilities.tools,
      AgentCapabilities.artifacts,
    ]);
    await expect(checkCapability(req(), AgentCapabilities.execute_code)).resolves.toBe(false);
    await expect(checkCapability(req(), AgentCapabilities.file_search)).resolves.toBe(true);
  });

  it('strips execute_code when the URL is the LibreChat-hosted default', async () => {
    process.env.LIBRECHAT_CODE_BASEURL = 'https://api.librechat.ai/v1';
    const { checkCapability } = createEndpointsConfigService(deps(ALL));

    await expect(checkCapability(req(), AgentCapabilities.execute_code)).resolves.toBe(false);
  });
});
