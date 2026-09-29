import fs from 'fs';
import os from 'os';
import path from 'path';
import { tenantStorage } from '@librechat/data-schemas';
import type { CodeEnvRef } from 'librechat-data-provider';
import type { DeploymentSkillBaseMethods } from '~/skills/deployment';
import {
  clearDeploymentSkillCodeEnvRefs,
  recallDeploymentSkillCodeEnvRef,
  rememberDeploymentSkillCodeEnvRef,
} from './deploymentSkillCodeEnvCache';
import {
  createDeploymentSkillMethods,
  getDeploymentSkillIds,
  initializeDeploymentSkills,
} from '~/skills/deployment';

const ON = { KNAUF_CODE_SKILL_FILE_CACHE: 'true' };
const ref = (fileId: string): CodeEnvRef => ({
  kind: 'skill',
  id: 'skill-1',
  version: 1,
  storage_session_id: 'karl-00000000000000000000000000000000',
  file_id: fileId,
});

describe('[knauf] deployment-skill staging refs are tenant-scoped (KK20-397)', () => {
  const roots: string[] = [];
  const previous = process.env.KNAUF_CODE_SKILL_FILE_CACHE;

  afterEach(async () => {
    clearDeploymentSkillCodeEnvRefs();
    if (previous === undefined) {
      delete process.env.KNAUF_CODE_SKILL_FILE_CACHE;
    } else {
      process.env.KNAUF_CODE_SKILL_FILE_CACHE = previous;
    }
    const empty = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knauf-empty-'));
    roots.push(empty);
    await initializeDeploymentSkills({ projectRoot: empty, env: {} });
    await Promise.all(
      roots.splice(0).map((r) => fs.promises.rm(r, { recursive: true, force: true })),
    );
  });

  it('recalls a ref only for the tenant that stored it, and only when the cache is on', () => {
    rememberDeploymentSkillCodeEnvRef('skill-1', 'scripts/a.py', ref('a'), 'tenant-a');
    expect(recallDeploymentSkillCodeEnvRef('skill-1', 'scripts/a.py', 'tenant-a', ON)).toEqual(
      ref('a'),
    );
    expect(
      recallDeploymentSkillCodeEnvRef('skill-1', 'scripts/a.py', 'tenant-b', ON),
    ).toBeUndefined();
    expect(
      recallDeploymentSkillCodeEnvRef('skill-1', 'scripts/a.py', 'tenant-a', {}),
    ).toBeUndefined();
  });

  it('hands a primed ref back on listSkillFiles to the same tenant, never to another', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knauf-skills-'));
    roots.push(root);
    const dir = path.join(root, 'skill', 'karl-docx');
    await fs.promises.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, 'SKILL.md'),
      [
        '---',
        'name: karl-docx',
        'description: Use this skill when a Word document fixture is needed in a test.',
        '---',
        '',
        '# Fixture',
      ].join('\n'),
    );
    await fs.promises.writeFile(path.join(dir, 'scripts', 'karl_docx.py'), 'print(1)\n');
    await initializeDeploymentSkills({ projectRoot: root, env: {} });
    const skillId = getDeploymentSkillIds()[0]!;
    const methods = createDeploymentSkillMethods({
      getSkillById: jest.fn(async () => null),
    } as DeploymentSkillBaseMethods);
    process.env.KNAUF_CODE_SKILL_FILE_CACHE = 'true';

    await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods.updateSkillFileCodeEnvIds?.([
        { skillId, relativePath: 'scripts/karl_docx.py', codeEnvRef: ref('a') },
      ]),
    );

    const listFor = (tenantId: string) =>
      tenantStorage.run({ tenantId }, async () => (await methods.listSkillFiles?.(skillId)) ?? []);
    expect((await listFor('tenant-a'))[0]).toMatchObject({ codeEnvRef: ref('a') });
    expect((await listFor('tenant-b'))[0]).not.toHaveProperty('codeEnvRef');

    delete process.env.KNAUF_CODE_SKILL_FILE_CACHE;
    expect((await listFor('tenant-a'))[0]).not.toHaveProperty('codeEnvRef');
  });
});
