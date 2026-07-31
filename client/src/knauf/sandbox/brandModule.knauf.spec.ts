/**
 * [knauf] KK20-252 — seam test for the brand module mounted into artifact sandboxes.
 *
 * `brandModule.ts` is a copy: its `KNAUF` const and `useKnaufTheme` come from
 * `skill/karl-brand/SKILL.md`, its `KnaufWordmark` from
 * `skill/karl-brand/references/logo.md`. A copy with no guard is a fork waiting to
 * happen — the skill is what the model reads when it reasons about colour, and the
 * module is what actually renders, so a silent divergence means KARL describes one
 * palette and ships another.
 *
 * These assertions hold the two together in BOTH directions, and hold the wordmark to
 * the committed brand SVG the same way `deploymentSkills.knauf.spec.ts` does. When you
 * edit the skill, re-copy into the module; this fails until you do.
 */
import fs from 'fs';
import path from 'path';
import { knaufBrandModule } from './brandModule';
import { sharedFiles } from '~/utils/artifacts';

/** Repo root, from client/src/knauf/sandbox/. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const hexes = (s: string) =>
  new Set((s.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase()));

describe('[knauf] knauf brand sandbox module', () => {
  it('exports the three names an artifact imports', () => {
    for (const name of ['KNAUF', 'useKnaufTheme', 'KnaufWordmark']) {
      expect(knaufBrandModule).toContain(name);
    }
    expect(knaufBrandModule).toMatch(
      /export \{[^}]*KNAUF[^}]*useKnaufTheme[^}]*KnaufWordmark[^}]*\}/,
    );
    // useKnaufTheme calls useMemo; as a standalone module it must import it itself.
    expect(knaufBrandModule).toMatch(/import \{ useMemo \} from 'react';/);
  });

  it('is actually mounted in the sandbox', () => {
    // Without this the module can be perfect and still never reach a preview —
    // the failure mode would be a ModuleNotFoundError identical to having no module.
    expect(sharedFiles['/knauf/brand.tsx']).toBe(knaufBrandModule);
  });

  it('carries the committed wordmark path, unaltered', () => {
    // Same yardstick as deploymentSkills.knauf.spec.ts: compare geometry, not bytes,
    // because transcription drops line breaks. 903 characters with no redundancy —
    // any edit deforms the letterforms and nothing errors.
    const tokenize = (d: string) => d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];

    const brandSvgPath = path.join(REPO_ROOT, 'knauf/brand/logos/KNAUFLogo2024sRGB.svg');
    // `.dockerignore` excludes knauf/brand/, so this only holds on a checkout.
    expect(fs.existsSync(brandSvgPath)).toBe(true);

    const source = /<path[^>]*\sd="(M[^"]+)"/.exec(fs.readFileSync(brandSvgPath, 'utf8'))?.[1];
    expect(source).toBeDefined();

    const inModule = [...knaufBrandModule.matchAll(/d="(M[^"]+)"/g)].map((m) => m[1]);
    expect(inModule).toHaveLength(1);
    expect(tokenize(inModule[0])).toEqual(tokenize(source as string));
    expect(tokenize(source as string).length).toBeGreaterThan(100);
  });

  it('declares no colour the token skill does not authorise', () => {
    const skill = hexes(read('skill/karl-brand/SKILL.md'));
    const strays = [...hexes(knaufBrandModule)].filter((h) => !skill.has(h));
    expect(strays).toEqual([]);
  });

  it('carries every colour the token skill authors', () => {
    // The other direction: a token added to the skill but not re-copied here would
    // leave the model describing a colour the sandbox cannot resolve.
    const skillDoc = read('skill/karl-brand/SKILL.md');
    const tokenBlock = /```ts\n([\s\S]*?)\n```/.exec(skillDoc.split('## Tokens')[1] ?? '')?.[1];
    expect(tokenBlock).toBeDefined();

    const missing = [...hexes(tokenBlock as string)].filter((h) => !hexes(knaufBrandModule).has(h));
    expect(missing).toEqual([]);
  });
});
