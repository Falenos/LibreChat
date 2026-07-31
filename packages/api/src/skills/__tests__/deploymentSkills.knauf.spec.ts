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
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import {
  KNAUF_EXPECTED_DEPLOYMENT_SKILLS,
  checkDeploymentSkills,
} from '../../knauf/skills/deploymentSkillsCheck';
import { loadDeploymentSkillsFromDirectory, type DeploymentSkill } from '../deployment';

/** Repo root, from packages/api/src/skills/__tests__/. */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skill');
/**
 * Parked skills. Not loaded (two levels deep — see `findSkillDirectories`), so
 * every registry-based assertion below is blind to them. They are one `git mv`
 * from shipping, which is exactly when a latent defect surfaces on a day nobody
 * is looking for one, so the content rules are applied to them too.
 */
const DISABLED_DIR = path.join(SKILLS_DIR, '_disabled');

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
 *
 * Imported rather than re-declared: the same list drives the boot-time check in
 * `packages/api/src/knauf/skills/deploymentSkillsCheck.ts`, which is what makes
 * a shadowed `/app/skill` loud in production. Two copies would drift, and the
 * copy that drifts is the one nobody reads until an environment is already
 * missing its brand tokens.
 */
const EXPECTED_SKILL_NAMES = KNAUF_EXPECTED_DEPLOYMENT_SKILLS;

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
    // Every hex the token source declares, from its SKILL.md body AND its own
    // references — charts.md legitimately carries the ramps that SKILL.md only
    // names, and logo.md the mark fill.
    const source = byName.get(TOKEN_SOURCE_SKILL);
    const sourceHexes = new Set(
      [source?.body ?? '', ...(source?.files ?? []).map((file) => file.content ?? '')]
        .flatMap((text) => text.match(HEX_PATTERN) ?? [])
        .map((hex) => hex.toUpperCase()),
    );
    // Consumers are checked over SKILL.md *and* every reference. Checking only
    // the body is what let `#FFFFFF` sit in three templates under a heading
    // claiming they declare no colours of their own.
    const strays: string[] = [];
    for (const skill of skills) {
      if (skill.name === TOKEN_SOURCE_SKILL) {
        continue;
      }
      const sources: Array<[string, string]> = [
        [`${skill.name}/SKILL.md`, skill.body],
        ...skill.files.map((file): [string, string] => [
          `${skill.name}/${file.relativePath}`,
          file.content ?? '',
        ]),
      ];
      for (const [label, text] of sources) {
        // `content` is only cached below MAX_CACHED_TEXT_BYTES and only for
        // text. If that ever stops holding for a markdown reference, this
        // guard degrades to a no-op silently — so fail loudly instead.
        if (label.endsWith('.md')) {
          expect(text.length).toBeGreaterThan(0);
        }
        for (const hex of text.match(HEX_PATTERN) ?? []) {
          if (!sourceHexes.has(hex.toUpperCase())) {
            strays.push(`${label}: ${hex}`);
          }
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

  it('keeps the wordmark path identical to the committed brand SVG', () => {
    // `references/logo.md` transcribes the `d` attribute of
    // knauf/brand/logos/KNAUFLogo2024sRGB.svg, twice (raw SVG + React
    // component). 917 chars of coordinate data with no redundancy: any edit
    // deforms the letterforms and NOTHING errors. Compare geometry rather than
    // bytes, since the transcription drops the source's line breaks — all of
    // which happen to fall before command letters, so no numbers fuse.
    const tokenize = (d: string) => d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];

    /**
     * The yardstick, not the thing under test. `.dockerignore` excludes
     * `knauf/brand/` (~26 MB of EPS/PDF/font archive, nothing runtime-reachable),
     * so this assertion only holds on a checkout — never inside the image. Assert
     * it exists first: without this, pruning the brand kit fails with a bare
     * ENOENT under a title that reads as "the wordmark is broken", sending the
     * reader into logo.md looking for damage that is not there.
     *
     * If this fails: restore the file, or decide deliberately that the wordmark
     * is no longer machine-verifiable and delete this test. Do not "fix" it by
     * comparing logo.md's two copies to each other — they would agree happily on
     * a shared transcription error, which is the failure this test exists for.
     */
    const brandSvgPath = path.join(REPO_ROOT, 'knauf/brand/logos/KNAUFLogo2024sRGB.svg');
    expect(fs.existsSync(brandSvgPath)).toBe(true);

    const svg = fs.readFileSync(brandSvgPath, 'utf8');
    const sourcePath = /<path[^>]*\sd="(M[^"]+)"/.exec(svg)?.[1];
    expect(sourcePath).toBeDefined();

    const logoDoc = fs.readFileSync(path.join(SKILLS_DIR, 'karl-brand/references/logo.md'), 'utf8');
    const transcribed = [...logoDoc.matchAll(/d="(M[^"]+)"/g)].map((m) => m[1]);
    // Both the raw-SVG block and the React component must carry it, so neither
    // medium needs the reader to transcribe it across sections.
    expect(transcribed).toHaveLength(2);

    const expected = tokenize(sourcePath as string);
    expect(expected.length).toBeGreaterThan(100);
    for (const candidate of transcribed) {
      expect(tokenize(candidate)).toEqual(expected);
    }
  });

  it('keeps parked skills inside the catalog cap too', () => {
    // `skill/README.md` documents re-enabling as a single `git mv`. If a parked
    // description is over the cap, that one command ships a silently truncated
    // catalog entry — the exact defect this suite exists to prevent, arriving
    // through the one door the registry-based assertions cannot see.
    if (!fs.existsSync(DISABLED_DIR)) {
      return;
    }
    const overLong: string[] = [];
    for (const entry of fs.readdirSync(DISABLED_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillMd = path.join(DISABLED_DIR, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) {
        continue;
      }
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(skillMd, 'utf8'))?.[1];
      const parsed = frontmatter ? (yaml.load(frontmatter) as { description?: unknown }) : null;
      const description = typeof parsed?.description === 'string' ? parsed.description : '';
      expect(description.length).toBeGreaterThan(0);
      if (description.length > CATALOG_ENTRY_MAX_CHARS) {
        overLong.push(`_disabled/${entry.name}: ${description.length} chars`);
      }
    }
    expect(overLong).toEqual([]);
  });

  /**
   * Wiring tests for the boot-time check. The unit spec beside the module covers
   * classification and log level against synthetic input; these two run the real
   * loader, so they catch the case where the loader and the check disagree about
   * what a "name" is. `checkDeploymentSkills` (pure) rather than
   * `verifyDeploymentSkills` so the failing case does not emit an ERROR line
   * that reads like a broken test run.
   */
  describe('boot-time deployment skill check', () => {
    it('passes against the real shipped tree', () => {
      const result = checkDeploymentSkills({
        loadedNames: skills.map((skill) => skill.name),
        directory: SKILLS_DIR,
      });
      expect(result.missing).toEqual([]);
      expect(result.unexpected).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it('detects a directory mounted over the baked-in skills', async () => {
      // The production failure this check exists for: a volume at /app/skill
      // shadows the image copy. The loader treats that as a SUCCESSFUL boot and
      // logs the zero case at `debug`, so without the check it is invisible.
      const shadowed = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knauf-skill-shadow-'));
      try {
        const registry = await loadDeploymentSkillsFromDirectory(shadowed, {
          projectRoot: REPO_ROOT,
        });
        expect(registry.list()).toEqual([]);

        const result = checkDeploymentSkills({
          loadedNames: registry.list().map((skill) => skill.name),
          directory: registry.getDirectory(),
        });
        expect(result.ok).toBe(false);
        expect(result.missing).toEqual([...KNAUF_EXPECTED_DEPLOYMENT_SKILLS].sort());
      } finally {
        await fs.promises.rm(shadowed, { recursive: true, force: true });
      }
    });
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
