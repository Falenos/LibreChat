import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('[knauf] Code Execution runtime seams', () => {
  it.each([
    'api/server/services/Endpoints/agents/initialize.js',
    'api/server/controllers/agents/openai.js',
    'api/server/controllers/agents/responses.js',
    'api/server/controllers/agents/client.js',
    'packages/api/src/agents/openai/service.ts',
  ])('%s derives codeEnvAvailable through the canonical helper', (relativePath) => {
    const text = source(relativePath);

    expect(text).toContain('isKnaufCodeExecutionEnabled');
    expect(text).toMatch(/codeEnvAvailable[\s\S]{0,180}isKnaufCodeExecutionEnabled/);
  });

  it('gates the ToolService ephemeral fallback before constructing its Set', () => {
    const text = source('api/server/services/ToolService.js');

    expect(text).toContain('withKnaufCodeExecutionGate(fallbackCapabilities)');
  });

  it('gates served capabilities and Skills API visibility through shared helpers', () => {
    expect(source('packages/api/src/endpoints/config/endpoints.ts')).toContain(
      'capabilities: withKnaufCodeExecutionGate(capabilities)',
    );
    expect(source('packages/api/src/skills/handlers.ts')).toContain(
      'listSkillsAvailableForCodeEnvironment({',
    );
  });

  it('threads the environment decision through configured and pre-resolved skills', () => {
    expect(source('api/server/services/Endpoints/agents/initialize.js')).toMatch(
      /resolveModelSpecSkillIds\([\s\S]{0,240}codeEnvAvailable/,
    );
    expect(source('api/server/services/Endpoints/agents/addedConvo.js')).toMatch(
      /resolveModelSpecSkillIds\([\s\S]{0,240}codeEnvAvailable/,
    );
    const initializer = source('packages/api/src/agents/initialize.ts');
    expect(initializer).toMatch(
      /resolveManualSkills\([\s\S]{0,600}codeEnvAvailable: params\.codeEnvAvailable/,
    );
    expect(initializer).toMatch(
      /resolveAlwaysApplySkills\([\s\S]{0,600}codeEnvAvailable: params\.codeEnvAvailable/,
    );
  });
});
