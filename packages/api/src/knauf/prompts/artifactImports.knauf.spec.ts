/**
 * [knauf] Guards what the model is told about imports inside the artifact sandbox.
 *
 * Two failures produced this file, and they had the same shape: the sandbox mounts a
 * file, the model is never told the path, so it invents one and the preview dies with
 * ModuleNotFoundError rather than anything that looks like a prompt problem.
 *
 *   import { useKnaufTheme, KNAUF } from '/knauf-brand-tokens';   // invented
 *   import { Card, Tabs } from '/components/ui';                  // barrel, not mounted
 *
 * The first is fixed by the `[knauf]` line in `prompts/artifacts/index.ts`. The second
 * is fixed by `artifacts: 'shadcnui'` on the specs — `generateShadcnPrompt` is added
 * only in that mode, and it carries `components.ts`, a manifest giving every
 * component's exact import statement. On `'default'` the model gets one sentence
 * saying shadcn exists and no path for anything, which is why it guessed.
 *
 * These assert against the STRING THE MODEL ACTUALLY RECEIVES, not the source
 * constants: one line is interpolated into a `dedent` literal and the other is a whole
 * block appended conditionally, and either silently dropping out is exactly the
 * regression worth catching. The KARL-relevant variant is the OpenAI one —
 * `generateArtifactsPrompt` serves it to every endpoint that is not Anthropic, and all
 * four KARL specs are `azureOpenAI`.
 */
import { EModelEndpoint } from 'librechat-data-provider';
import { generateArtifactsPrompt } from '~/prompts';

/** The mode every user-facing KARL spec sets. Keep in step with `librechat.yaml`. */
const KARL_ARTIFACT_MODE = 'default';

const promptFor = (artifacts: string) =>
  generateArtifactsPrompt({
    endpoint: EModelEndpoint.azureOpenAI,
    artifacts: artifacts as never,
  }) ?? '';

const karlPrompt = () => promptFor(KARL_ARTIFACT_MODE);

describe('[knauf] artifacts prompt — sandbox import rules', () => {
  it('tells the model the brand module exists', () => {
    const prompt = karlPrompt();
    expect(prompt).toContain("import { KNAUF, useKnaufTheme, KnaufWordmark } from '/knauf/brand';");
    expect(prompt).toContain('loads Knauf Screen and Knauf Screen Head automatically');
  });

  it('requires the platform slide renderer for every endpoint', () => {
    for (const endpoint of [EModelEndpoint.azureOpenAI, EModelEndpoint.anthropic]) {
      const prompt =
        generateArtifactsPrompt({ endpoint, artifacts: KARL_ARTIFACT_MODE as never }) ?? '';
      expect(prompt).toContain("import { KnaufSlideDeck } from '/knauf/slides';");
      expect(prompt).toContain('Supply one data object per requested slide');
      expect(prompt).toContain('data-knauf-export-pages={total}');
      expect(prompt).toContain('data-knauf-export-next');
    }
  });

  it('does NOT carry the shadcn manifest — the skill supplies those paths', () => {
    // Pins the trade deliberately. `'default'` omits `generateShadcnPrompt`, so the
    // model gets one shadcn sentence and no per-component path from this prompt.
    // `karl-artifacts` is what closes that gap, and `deploymentSkills.knauf.spec.ts`
    // pins it there. If this ever starts containing the manifest, the mode changed
    // and the ~2.9k tokens/turn came back — a decision, not an accident.
    const prompt = karlPrompt();
    expect(prompt).not.toContain('/components/ui/card');
    expect(prompt).not.toContain('/components/ui/avatar');
    expect(prompt.length).toBeLessThan(promptFor('shadcnui').length);
  });

  it('keeps upstream rules the sandbox still depends on', () => {
    const prompt = karlPrompt();
    expect(prompt).toContain('Components MUST be imported from');
    expect(prompt).toMatch(/NO OTHER LIBRARIES/);
  });

  it('uses edit_artifact for existing-artifact changes and keeps full emission as fallback', () => {
    for (const endpoint of [EModelEndpoint.azureOpenAI, EModelEndpoint.anthropic]) {
      const prompt =
        generateArtifactsPrompt({ endpoint, artifacts: KARL_ARTIFACT_MODE as never }) ?? '';
      expect(prompt).toContain('edit_artifact');
      expect(prompt).toMatch(/do not re-emit the artifact/i);
      expect(prompt).toMatch(/unavailable|rejects|fails/i);
    }
  });

  it('gives the Anthropic variant the same Knauf modules', () => {
    const anthropic =
      generateArtifactsPrompt({
        endpoint: EModelEndpoint.anthropic,
        artifacts: KARL_ARTIFACT_MODE as never,
      }) ?? '';
    expect(anthropic).toContain('/knauf/brand');
    expect(anthropic).toContain('/knauf/slides');
  });

  it('is not emitted at all in custom-prompt mode', () => {
    // Two different gates, worth not confusing: `custom` returns null from this
    // function, while artifacts being switched OFF is gated by the caller
    // (`agent.artifacts !== ''` in packages/api/src/agents/initialize.ts), which never
    // invokes this at all. Asserting the caller's gate here would mean importing the
    // whole agent-initialisation graph, so it is stated rather than tested.
    expect(
      generateArtifactsPrompt({
        endpoint: EModelEndpoint.azureOpenAI,
        artifacts: 'custom' as never,
      }),
    ).toBeNull();
  });
});
