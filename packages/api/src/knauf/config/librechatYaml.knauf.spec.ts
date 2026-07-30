/**
 * [knauf] KK20-252 — guards over the COMMITTED `librechat.yaml`.
 *
 * `librechat.yaml` is baked into the image at build time (`Dockerfile` COPY) and
 * nothing validated it: no schema check, no consistency check, no test at all.
 * KK20-243 shipped two defects straight through that gap, and both were found by
 * a human reading a Langfuse trace rather than by CI:
 *
 *  1. **Contradictory instructions.** Enabling artifacts put
 *     `generateArtifactsPrompt` ("artifacts are for reports, emails,
 *     presentations") into the same system message as the KARL prompt's standing
 *     order to "explain that file generation is not supported ... respond as text
 *     within the chat". Asked for a dashboard, the model resolved the conflict by
 *     refusing outright.
 *  2. **A 32k context window nobody intended.** Every model alias our specs use
 *     is Knauf-invented, so `getModelMaxTokens` could not resolve any of them and
 *     `initialize.ts` silently fell back to `DEFAULT_MAX_CONTEXT_TOKENS`.
 *
 * Both are config-shaped, so they are cheap to assert and expensive to rediscover.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { EModelEndpoint } from 'librechat-data-provider';
import { getModelMaxTokens } from '~/utils';

/** Repo root, from packages/api/src/knauf/config/. */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');

/**
 * Mirrors `DEFAULT_MAX_CONTEXT_TOKENS` in `packages/api/src/agents/initialize.ts`.
 * Duplicated deliberately rather than imported: importing `initialize.ts` drags in
 * the whole agent-initialisation graph, and this file only needs the number. If
 * upstream changes it, the assertion below still holds — it asserts that we never
 * *rely* on the fallback, whatever its value.
 */
const DEFAULT_MAX_CONTEXT_TOKENS = 32000;

interface SpecPreset {
  endpoint?: string;
  model?: string;
  promptPrefix?: string;
  maxContextTokens?: number;
}
interface ModelSpec {
  name: string;
  preset?: SpecPreset;
}
interface LibreChatYaml {
  summarization?: { enabled?: boolean };
  modelSpecs?: { list?: ModelSpec[] };
  endpoints?: { agents?: { capabilities?: string[] } };
}

let config: LibreChatYaml;
let specs: ModelSpec[];

beforeAll(() => {
  config = yaml.load(
    fs.readFileSync(path.join(REPO_ROOT, 'librechat.yaml'), 'utf8'),
  ) as LibreChatYaml;
  specs = config.modelSpecs?.list ?? [];
});

describe('[knauf] librechat.yaml — model spec sanity', () => {
  it('ships model specs', () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  it('gives every spec a preset with an endpoint and a model', () => {
    for (const spec of specs) {
      expect(spec.preset?.endpoint).toBeTruthy();
      expect(spec.preset?.model).toBeTruthy();
    }
  });
});

describe('[knauf] librechat.yaml — context window is never left to the fallback', () => {
  /**
   * The defect this pins. `getModelMaxTokens` is the resolver
   * `initialize.ts:1042-1050` consults before falling back, so asking it directly
   * is asking the real question: "would this spec have silently run on 32k?"
   */
  it.each([['model-router-chat'], ['agent-default']])(
    '%s is genuinely unresolvable, so an explicit pin is the only fix',
    (model) => {
      // If this ever starts resolving, the pins below become belt-and-braces
      // rather than load-bearing — good news, but worth noticing deliberately.
      expect(getModelMaxTokens(model, EModelEndpoint.azureOpenAI)).toBeUndefined();
    },
  );

  it('pins maxContextTokens on every spec whose model cannot be resolved', () => {
    const unpinned: string[] = [];
    for (const spec of specs) {
      const model = spec.preset?.model ?? '';
      const resolved = getModelMaxTokens(model, EModelEndpoint.azureOpenAI);
      if (resolved == null && spec.preset?.maxContextTokens == null) {
        unpinned.push(`${spec.name} (model: ${model})`);
      }
    }
    expect(unpinned).toEqual([]);
  });

  it('never pins a window at or below the 32k fallback, which would be pointless', () => {
    for (const spec of specs) {
      const pinned = spec.preset?.maxContextTokens;
      if (pinned != null) {
        expect(pinned).toBeGreaterThan(DEFAULT_MAX_CONTEXT_TOKENS);
      }
    }
  });
});

describe('[knauf] librechat.yaml — prompt does not contradict enabled capabilities', () => {
  const artifactsEnabled = () =>
    config.endpoints?.agents?.capabilities?.includes('artifacts') === true;

  /**
   * The user-facing KARL chat specs — the ones sharing the `&karl_prompt` anchor.
   * Identified by the identity line rather than by "has a promptPrefix", because
   * `karl-autogenerate-prompt` carries its own prompt for the agent-builder's
   * drafter. That one is internal, never renders artifacts, and correctly says
   * nothing about them; holding it to these rules would be wrong.
   */
  const karlChatSpecs = () =>
    specs.filter((spec) => /CorporateGPT named KARL/.test(spec.preset?.promptPrefix ?? ''));

  it('has artifacts enabled (otherwise the rest of this block is moot)', () => {
    expect(artifactsEnabled()).toBe(true);
  });

  it('selects exactly the four user-facing KARL specs', () => {
    /**
     * Without this, every assertion below is one copy-edit from silent.
     * `karlChatSpecs()` filters on the prompt text it is about to assert over, and
     * the remaining cases all read `expect(<derived from that filter>).toEqual([])`
     * — which passes trivially on an empty array. Verified: rewording the identity
     * line alone takes this block from "2 failed" to "all green" with the KK20-243
     * contradiction fully reinstated in `librechat.yaml`.
     *
     * Pinning the names means a reword fails HERE, loudly and with an obvious fix,
     * instead of disarming the guard for the defect this whole file exists to catch.
     */
    expect(
      karlChatSpecs()
        .map((spec) => spec.name)
        .sort(),
    ).toEqual([
      'karl',
      'karl-personality-balanced',
      'karl-personality-creative',
      'karl-personality-precise',
    ]);
  });

  it('never tells the model that file generation is unsupported full stop', () => {
    // The exact sentence that produced the refusal. If a future edit reinstates
    // it while artifacts are on, the model is being handed a contradiction again.
    const offenders = karlChatSpecs()
      .filter((spec) => /file generation is not supported/i.test(spec.preset!.promptPrefix!))
      .map((spec) => spec.name);
    expect(offenders).toEqual([]);
  });

  it('never tells the model to respond only as text in the chat', () => {
    // "otherwise, respond as text within the chat" was the other half: a standing
    // instruction to stay in chat cannot coexist with a preview panel.
    const offenders = karlChatSpecs()
      .filter((spec) => /respond as text within the chat/i.test(spec.preset!.promptPrefix!))
      .map((spec) => spec.name);
    expect(offenders).toEqual([]);
  });

  it('affirmatively tells the model it may build artifacts', () => {
    // Removing the contradiction is not enough — with ~2.9k tokens of artifact
    // instructions arriving from elsewhere, the system prompt has to agree.
    const silent = karlChatSpecs()
      .filter((spec) => !/artifact/i.test(spec.preset!.promptPrefix!))
      .map((spec) => spec.name);
    expect(silent).toEqual([]);
  });

  it('still forbids the binary formats we genuinely cannot produce', () => {
    // The original rule existed for a real reason: no code interpreter means no
    // PDF/XLSX. Relaxing the contradiction must not relax that.
    for (const spec of karlChatSpecs()) {
      expect(spec.preset!.promptPrefix!).toMatch(/PDF/);
      expect(spec.preset!.promptPrefix!).toMatch(/XLS/);
    }
  });
});

describe('[knauf] librechat.yaml — summarization is stated, not inferred', () => {
  it('declares summarization explicitly', () => {
    // `resolveSummarizationConfig` tests `config?.enabled !== false`, so an absent
    // block reads as ENABLED. Whatever we want, it has to be written down.
    expect(config.summarization).toBeDefined();
    expect(typeof config.summarization?.enabled).toBe('boolean');
  });
});
