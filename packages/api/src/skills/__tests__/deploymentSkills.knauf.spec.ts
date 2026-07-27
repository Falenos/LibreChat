/**
 * [knauf] KK20-243 — guard the REAL `skill/` tree that ships in the image.
 *
 * `deployment.test.ts` covers the loader against temp fixtures. Nothing covers
 * the skills we actually ship, so today three classes of mistake are invisible:
 *
 *  - A frontmatter typo (unknown key, bad type) makes `loadDeploymentSkill`
 *    throw, which takes down `initializeDeploymentSkills` at
 *    `api/server/index.js` — i.e. the whole backend fails to boot, discovered
 *    by a human on restart rather than by CI.
 *  - A `description` over 250 chars is silently truncated in the model-visible
 *    catalog by `formatSkillCatalog` (@librechat/agents), so trigger words past
 *    that point never reach the model and the skill under-discovers. There is
 *    no warning anywhere.
 *  - A typo'd `skills/<name>/<path>` reference inside a SKILL.md body is a
 *    dead `read_file` at runtime with no build-time signal at all.
 *
 * These assertions are deliberately about the shipped content, not the loader.
 */
import fs from 'fs';
import path from 'path';
import { loadDeploymentSkillsFromDirectory, type DeploymentSkill } from '../deployment';

/** Repo root, from packages/api/src/skills/__tests__/. */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skill');

/**
 * `formatSkillCatalog` in @librechat/agents hard-truncates every catalog entry
 * at DEFAULT_MAX_ENTRY_CHARS = 250 (slice(0, 249) + '…'). The 1024-char
 * SKILL_DESCRIPTION_MAX_LENGTH is only the storage cap — this is the one that
 * decides what the model actually sees.
 */
const CATALOG_ENTRY_MAX_CHARS = 250;

/**
 * The exact set we intend to ship. Asserting equality (not `toContain`) is what
 * catches `skill/_disabled/` becoming discoverable — `findSkillDirectories`
 * only scans immediate children today, and an upstream change to that depth
 * would silently resurrect a skill we deliberately parked.
 */
const EXPECTED_SKILL_NAMES = ['karl-artifacts', 'karl-brand'];

/** The token source of truth. Every other skill mirrors, never authors. */
const TOKEN_SOURCE_SKILL = 'karl-brand';

const HEX_PATTERN = /#[0-9a-fA-F]{6}\b/g;
/** `read_file` reference paths: `skills/<skill-name>/<relative/path>`. */
const SKILL_REF_PATTERN = /\bskills\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9._\-/]+)/g;

let skills: DeploymentSkill[];
let byName: Map<string, DeploymentSkill>;

beforeAll(async () => {
  const registry = await loadDeploymentSkillsFromDirectory(SKILLS_DIR, {
    projectRoot: REPO_ROOT,
    explicitlyConfigured: true,
  });
  skills = registry.list();
  byName = new Map(skills.map((skill) => [skill.name, skill]));
});

describe('[knauf] shipped deployment skills', () => {
  it('loads the real skill/ directory without throwing', () => {
    // beforeAll would have rejected. Assert we got something, so a silently
    // empty directory (which the loader tolerates) still fails here.
    expect(skills.length).toBeGreaterThan(0);
  });

  it('ships exactly the intended skills', () => {
    expect(skills.map((skill) => skill.name).sort()).toEqual([...EXPECTED_SKILL_NAMES].sort());
  });

  it('keeps every description inside the 250-char catalog entry cap', () => {
    const overLong = skills
      .filter((skill) => skill.description.length > CATALOG_ENTRY_MAX_CHARS)
      .map((skill) => `${skill.name}: ${skill.description.length} chars`);
    expect(overLong).toEqual([]);
  });

  it('keeps the token-source skill readable across skills', () => {
    const source = byName.get(TOKEN_SOURCE_SKILL);
    expect(source).toBeDefined();
    // Cross-skill `read_file` of `skills/karl-brand/...` is rejected at
    // packages/api/src/agents/handlers.ts when the target skill has
    // disableModelInvocation and was not primed this turn. `userInvocable:
    // false` would additionally drop it from the `$` popover.
    expect(source?.disableModelInvocation).not.toBe(true);
    expect(source?.userInvocable).not.toBe(false);
  });

  it('never authors a hex outside the token source', () => {
    const sourceHexes = new Set(
      (byName.get(TOKEN_SOURCE_SKILL)?.body.match(HEX_PATTERN) ?? []).map((hex) =>
        hex.toUpperCase(),
      ),
    );
    const strays: string[] = [];
    for (const skill of skills) {
      if (skill.name === TOKEN_SOURCE_SKILL) {
        continue;
      }
      for (const hex of skill.body.match(HEX_PATTERN) ?? []) {
        if (!sourceHexes.has(hex.toUpperCase())) {
          strays.push(`${skill.name}: ${hex}`);
        }
      }
    }
    expect(strays).toEqual([]);
  });

  it('resolves every skills/<name>/<path> reference in a SKILL.md body', () => {
    const broken: string[] = [];
    for (const skill of skills) {
      for (const [, targetName, relativePath] of skill.body.matchAll(SKILL_REF_PATTERN)) {
        const target = byName.get(targetName);
        if (!target) {
          broken.push(`${skill.name} -> unknown skill "${targetName}"`);
          continue;
        }
        // `SKILL.md` is served from `skill.body`, not from the file list.
        if (relativePath === 'SKILL.md') {
          continue;
        }
        if (!target.files.some((file) => file.relativePath === relativePath)) {
          broken.push(`${skill.name} -> ${targetName}/${relativePath}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('keeps YAML frontmatter out of reference files', () => {
    // Only SKILL.md is frontmatter-parsed. A leading `---` in a reference is a
    // stray horizontal rule today and a live trap if the file is ever promoted.
    const offenders: string[] = [];
    for (const skill of skills) {
      for (const file of skill.files) {
        if (!file.relativePath.endsWith('.md')) {
          continue;
        }
        const absolute = path.join(SKILLS_DIR, skill.name, file.relativePath);
        const first = fs.readFileSync(absolute, 'utf8').split('\n', 1)[0].trim();
        if (first === '---') {
          offenders.push(`${skill.name}/${file.relativePath}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
