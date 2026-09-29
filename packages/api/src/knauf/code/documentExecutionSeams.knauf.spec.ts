import fs from 'node:fs';
import path from 'node:path';

/**
 * [knauf] KK20-397 — presence checks for the upstream seams behind document generation in
 * the code sandbox. Each seam's behaviour is tested beside its knauf module; these fail
 * when an upstream sync drops the call site that wires it in, which the behaviour tests
 * alone would not notice (they call the knauf module directly).
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('[knauf] KK20-397 document-execution seams', () => {
  it('restores the skill-file cache freshness pair in skillDeps.js', () => {
    const text = source('api/server/services/Endpoints/agents/skillDeps.js');
    expect(text).toMatch(
      /checkIfActive,\s*\/\/ \[knauf\][\s\S]{0,600}\.\.\.knaufSkillCacheDeps\(getSessionInfo\)/,
    );
  });

  it('probes every staged object, not one per storage session', () => {
    const text = source('packages/api/src/agents/skillFiles.ts');
    expect(
      text.match(/probeKey = ref \? `\$\{ref\.storage_session_id\}\/\$\{ref\.file_id\}`/g),
    ).toHaveLength(2);
  });

  it('keeps deployment-skill staging refs per tenant', () => {
    const text = source('packages/api/src/skills/deployment.ts');
    expect(text).toContain('rememberDeploymentSkillCodeEnvRef(update.skillId, update.relativePath');
    expect(text).toContain('recallDeploymentSkillCodeEnvRef(file.skillId, file.relativePath)');
  });

  it('tells the model where bundled skill files are mounted', () => {
    const text = source('packages/api/src/agents/handlers.ts');
    expect(text).toContain('describeSkillSandboxMount(skill.name, knaufMountedNames)');
    expect(text.match(/skillSandboxPath\(skillName, relativePath\)/g)).toHaveLength(6);
    expect(text).not.toContain('/mnt/data/${args.path}');
  });

  it('mounts the files of skills primed this turn', () => {
    expect(source('api/server/controllers/agents/client.js')).toContain(
      'primeInvokedSkills(payload, knaufFreshPrimeNames)',
    );
    expect(source('api/server/services/Endpoints/agents/initialize.js')).toMatch(
      /\(payload, extraSkillNames\) =>[\s\S]{0,300}extraSkillNames,/,
    );
    expect(source('packages/api/src/agents/skillFiles.ts')).toContain(
      'for (const name of deps.extraSkillNames ?? [])',
    );
  });

  it('routes sandbox rasters through the visual-QA reader and keeps them out of attachments', () => {
    const handlers = source('packages/api/src/agents/handlers.ts');
    expect(handlers).toMatch(
      /errorMessage: 'path is required',[\s\S]{0,400}readKnaufSandboxImage\(\{ tc, path: args\.path, mergedConfigurable, req \}\)/,
    );
    expect(handlers).toContain('!isKnaufModelOnlyArtifact(handlerResult.artifact)');
  });

  it('hides sandbox-only skill files from the Skills API', () => {
    const text = source('packages/api/src/skills/handlers.ts');
    expect(text).toContain('rows.filter((row) => !isSandboxOnlySkillFile(row))');
    expect(text).toMatch(/if \(isSandboxOnlySkillFile\(file\)\) \{\s*return res\.status\(404\)/);
  });

  it('applies the code-output policy before download and before any file record', () => {
    const text = source('api/server/services/Files/Code/process.js');
    const qa = text.indexOf('if (isPrivateQaRender(name))');
    const download = text.indexOf("responseType: 'arraybuffer'");
    const blocked = text.indexOf('blockedCodeOutputReason({ name, buffer })');
    const sizeFallback = text.indexOf('if (buffer.length > fileSizeLimit)');
    const claim = text.indexOf('await claimCodeFile({');
    expect(qa).toBeGreaterThan(-1);
    expect(qa).toBeLessThan(download);
    expect(blocked).toBeGreaterThan(download);
    expect(blocked).toBeLessThan(sizeFallback);
    expect(blocked).toBeLessThan(claim);
  });
});
