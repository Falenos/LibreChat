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
  maxTokens?: number;
}
interface ModelSpec {
  name: string;
  /** Spec-level capability keys — siblings of `preset`, not fields inside it. */
  artifacts?: string;
  skills?: boolean;
  preset?: SpecPreset;
}
interface LibreChatYaml {
  summarization?: { enabled?: boolean };
  modelSpecs?: { list?: ModelSpec[] };
  endpoints?: { agents?: { capabilities?: string[] } };
  interface?: { runCode?: boolean; prompts?: unknown; peoplePicker?: unknown };
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

describe('[knauf] librechat.yaml — default KARL response latency', () => {
  it('uses task-sized prose ceilings without truncating requested source', () => {
    const karl = specs.find((spec) => spec.name === 'karl');
    const prompt = karl?.preset?.promptPrefix ?? '';

    expect(karl?.preset).toMatchObject({ maxTokens: 8192 });
    expect(karl?.preset).not.toHaveProperty('verbosity');
    expect(prompt).toMatch(/simple fact[^\n]*1[–-]3 sentences[^\n]*at most 80 words/i);
    expect(prompt).toMatch(/ordinary question[^\n]*at most 160 words/i);
    expect(prompt).toMatch(
      /comparison, troubleshooting request, or decision[^\n]*at most 300 words/i,
    );
    expect(prompt).toMatch(/ceilings, not targets/i);
    expect(prompt).toMatch(/answer the user's exact question first[^\n]*stop when it is answered/i);
    expect(prompt).toMatch(/preserve the conclusion[^\n]*evidence[^\n]*material caveat/i);
    expect(prompt).toMatch(
      /omit introductions[^\n]*generic background[^\n]*repeated explanations/i,
    );
    expect(prompt).toMatch(/tool or source availability never justifies extra detail/i);
    expect(prompt).toMatch(/why is the sky blue[^\n]*1[–-]3 sentence/i);
    expect(prompt).not.toMatch(/narrative style/i);
    expect(prompt).toMatch(/exceed 300 words only when the user requests detail/i);
    expect(prompt).toMatch(/does not apply to a complete artifact, code, configuration/i);
    expect(prompt).toMatch(/never truncate valid source/i);
    expect(prompt).toMatch(/complete all search calls before emitting any user-visible text/i);
    expect(prompt).toMatch(/stream only the final answer after searching finishes/i);
  });
});

describe('[knauf] librechat.yaml — complete user-facing sources', () => {
  it('does not cap the source footer below the files used in the answer', () => {
    const prompt = specs.find((spec) => spec.name === 'karl')?.preset?.promptPrefix ?? '';

    expect(prompt).toMatch(/include every source you used for answer generation/i);
    expect(prompt).not.toMatch(/maximum of 3/i);
  });
});

describe('[knauf] librechat.yaml — Admin-managed prompt sharing', () => {
  it('does not override prompt or People Picker permissions', () => {
    expect(config.interface).not.toHaveProperty('prompts');
    expect(config.interface).not.toHaveProperty('peoplePicker');
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

  it('keeps every user-facing spec on the artifacts mode the skill is written for', () => {
    /**
     * NO-TICKET. `'default'` omits `generateShadcnPrompt` and therefore the whole
     * components.ts manifest, so the model has no per-component import path and
     * relies entirely on what `karl-artifacts` shows it. That is a deliberate
     * trade — the manifest costs ~2.9k tokens per turn for a catalogue of 37
     * components when the skill recommends four.
     *
     * It is only safe while the skill carries those four import lines, which
     * `deploymentSkills.knauf.spec.ts` pins. Flipping this to `'shadcnui'` is a
     * valid choice; flipping it and dropping the skill's import block is not, and
     * the two specs together are what make that visible.
     */
    const wrong = specs
      .filter((spec) => spec.artifacts != null && spec.artifacts !== 'default')
      .map((spec) => `${spec.name} (artifacts: ${String(spec.artifacts)})`);
    expect(wrong).toEqual([]);
    // An absent key reads as "off", not "inherit" — so assert it is actually set.
    expect(karlChatSpecs().every((spec) => spec.artifacts === 'default')).toBe(true);
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

  it('uses the runtime edit tool instead of re-emitting small artifact changes', () => {
    for (const spec of karlChatSpecs()) {
      expect(spec.preset?.promptPrefix).toContain('use edit_artifact');
      expect(spec.preset?.promptPrefix).toMatch(/do not re-emit it/i);
      expect(spec.preset?.promptPrefix).toMatch(/Full artifact emission is the fallback/i);
    }
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

  it('requires official Knauf branding for visual deliverables and generated images', () => {
    for (const spec of karlChatSpecs()) {
      const prompt = spec.preset!.promptPrefix!;
      expect(prompt).toMatch(/every user-facing visual deliverable/i);
      expect(prompt).toMatch(/load and follow the karl-brand skill/i);
      expect(prompt).toMatch(/Knauf Screen for body copy, Knauf Screen Head for headings/i);
      expect(prompt).toMatch(/exact official SVG wordmark with its required clear space/i);
      expect(prompt).toMatch(/never type, redraw or ask an image model to generate the logo/i);
    }
  });

  it('still forbids the binary formats we genuinely cannot produce', () => {
    // The original rule existed for a real reason, but the reason moved. KK20-257
    // gave KARL a real sandbox, so .xlsx/.csv/.png/.md written to /mnt/data ARE
    // delivered as downloads and the old blanket ban made it refuse the very
    // deliverables the sandbox exists for. What the sandbox still cannot hand back is
    // PDF/PPTX/DOCX/ZIP/audio/video, so that half must survive verbatim.
    for (const spec of karlChatSpecs()) {
      expect(spec.preset!.promptPrefix!).toMatch(/PDF/);
      expect(spec.preset!.promptPrefix!).toMatch(/PPT\/PPTX, DOC\/DOCX, ZIP/);
    }
  });

  it('permits the data files the sandbox really can produce', () => {
    // The other half of the same boundary: a blanket "you cannot produce XLSX/CSV"
    // sentence would out-argue the code interpreter, so assert the carve-out is
    // present and that the old combined ban token is gone.
    for (const spec of karlChatSpecs()) {
      const prompt = spec.preset!.promptPrefix!;
      expect(prompt).not.toMatch(/XLS\/XLSX\/CSV/);
      expect(prompt).toMatch(/Data files are the exception/i);
      expect(prompt).toMatch(/never say you cannot produce a spreadsheet or a CSV/i);
    }
  });

  it('tells the model where tabular attachments actually are', () => {
    // Tabular uploads are routed to the sandbox, not the file_search corpus
    // (useFileHandling, KK20-257). Without this the model searches for a file that
    // was never embedded and then confabulates its contents.
    for (const spec of karlChatSpecs()) {
      const prompt = spec.preset!.promptPrefix!;
      expect(prompt).toMatch(/Data files:/);
      expect(prompt).toMatch(/\/mnt\/data/);
      expect(prompt).toMatch(/does not go into the file_search corpus/i);
    }
  });

  it('requires the artifact to be emitted, not just announced', () => {
    /**
     * Observed failure: KARL replied "You'll find it open in the preview panel
     * now" and described the deck, having emitted nothing. The text it was
     * following — "say in a single short line that it is open in the preview
     * panel, and do not restate its contents" — scripted the narration and never
     * required the emission, so the model did the narration and stopped.
     *
     * Both halves have to survive: telling it to emit, and forbidding the claim
     * without the emission. A future edit that trims either one reopens it.
     */
    for (const spec of karlChatSpecs()) {
      const prompt = spec.preset!.promptPrefix!;
      expect(prompt).toMatch(/a description of an artifact is not an artifact/i);
      expect(prompt).toMatch(/unless you have actually emitted it/i);
    }
  });

  it('pins the artifact emission syntax in the anchor itself', () => {
    /**
     * Observed failure: KARL emitted `<artifact identifier=... type=...>` — the
     * XML shape it is trained on — instead of the `:::artifact{...}` remark
     * directive this UI parses, so a whole React component rendered as raw text
     * in the chat.
     *
     * Root cause was a sentence here that said the appended artifacts prompt was
     * "written for a general assistant, this one is written for KARL" while
     * claiming precedence. That devalued the only text carrying the syntax. The
     * fix is to state the syntax in the anchor, which is always present and
     * highest-authority, so the format no longer depends on how much weight the
     * model gives the appended prompt.
     */
    for (const spec of karlChatSpecs()) {
      const prompt = spec.preset!.promptPrefix!;
      expect(prompt).toContain(':::artifact{identifier=');
      expect(prompt).toMatch(/never use an xml-style `<artifact>` tag/i);
      // The devaluing clause must not come back.
      expect(prompt).not.toMatch(/written for a general assistant/i);
    }
  });

  it('constrains the artifact body without breaking markdown or code comments', () => {
    /**
     * Observed failure: the artifact body carried trailing prose, an HTML comment
     * (`<!-- Tabs and Cards come from shadcn/ui ... -->`, which threw at 97:0 in
     * Sandpack) and mangled backtick fences after the component's closing brace.
     *
     * The first attempt at this rule banned "prose" and "annotations" outright,
     * which would have broken `text/markdown` artifacts — prose is their entire
     * content — and could have suppressed the comments inside the `KNAUF` block
     * that karl-brand orders transcribed verbatim. Both carve-outs are asserted
     * here so a future tightening cannot quietly drop them.
     */
    for (const spec of karlChatSpecs()) {
      const prompt = spec.preset!.promptPrefix!;
      expect(prompt).toMatch(/inside the fence is the file, and nothing but the file/i);
      expect(prompt).toMatch(/ordinary code comments are welcome/i);
      expect(prompt).toMatch(/for `text\/markdown` the file is the document/i);
      // The ban must be about audience, not syntax — otherwise it just relocates.
      expect(prompt).toMatch(/whether or not it compiles/i);
    }
  });

  it('routes presentations to React, not Markdown', () => {
    // Observed: asked for a presentation, KARL built a `text/markdown` artifact.
    // It followed karl-artifacts' type table correctly — that table never
    // mentioned decks and filed "report" under markdown, while the skill ships
    // tsx templates for both. The table is fixed; this pins the always-present
    // half so the routing does not depend on the skill having been loaded.
    for (const spec of karlChatSpecs()) {
      expect(spec.preset!.promptPrefix!).toMatch(
        /presentation, deck or branded report is always a React artifact/i,
      );
    }
  });

  it('does not let the library-disclosure ban reach the import statements', () => {
    // The ban exists because upstream orders the model to announce shadcn/ui.
    // Scoped too widely it forbids `import { Card } from '/components/ui/card'`
    // itself, and the model hand-rolls primitives out of raw divs instead.
    for (const spec of karlChatSpecs()) {
      expect(spec.preset!.promptPrefix!).toMatch(/code is not a disclosure/i);
    }
  });

  it('pins the artifact directive to column 0', () => {
    // The upstream format example is indented 6 spaces inside its template
    // literal. At 4+ spaces CommonMark takes the block as indented code, the
    // directive never parses, and the deck lands in chat with no error at all.
    for (const spec of karlChatSpecs()) {
      expect(spec.preset!.promptPrefix!).toMatch(/start at the left margin, in column 0/i);
    }
  });

  it('keeps skill internals out of user-facing replies', () => {
    // Observed failure: "The slides follow the structure outlined in
    // references/slides.md, with branding ... driven by the KNAUF token set".
    // Skill bodies are written as second-person working instructions naming
    // internal paths, and nothing told the model those are private.
    for (const spec of karlChatSpecs()) {
      expect(spec.preset!.promptPrefix!).toMatch(/working material, not the user's/i);
    }
  });
});

describe('[knauf] librechat.yaml — code execution is always on, with no chip', () => {
  /**
   * KK20-252 established that Run Code was a button backed by nothing, because no
   * sandbox was deployed. KK20-257 deployed one (the Knauf code-adapter over ACA
   * dynamic sessions), so the posture changed shape but not intent:
   *
   *   capability `execute_code`      -> the tool exists (upload gate, codeEnvAvailable)
   *   `executeCode: true` per spec   -> it is requested on every KARL turn
   *   `interface.runCode: true`      -> the RUN_CODE permission is granted, because it is
   *                                     the only thing that makes the manual execution
   *                                     path work: `POST /tools/:toolId/call` is the one
   *                                     server route that checks it
   *                                     (api/server/controllers/tools.js).
   *
   * The permission has never gated agent auto-run — that comes from the capability plus
   * the per-spec flag (packages/api/src/agents/load.ts) — so granting it changes nothing
   * about whether code runs. What it does change is the UI: three manual surfaces would
   * appear (composer chip, tools-menu row, per-code-block Run button). KARL ships none of
   * them, and they are suppressed in the components by KNAUF_HIDE_CODE_* flags, pinned by
   * `client/src/knauf/components/Chat/{composerChipHides,codeRunSurfaces}` — which is
   * where a regression on that half shows up, not here.
   *
   * This assertion is `true` deliberately: reverting it to `false` would make those three
   * client constants dead code and re-disable the manual path by permission, which is the
   * KK20-252 state that KK20-257 moved away from.
   *
   * `RUN_CODE: { USE: false }` in the AGENT_BUILDER startup policy is unrelated and
   * stays: it grants nothing reachable now that no UI calls that endpoint. This file
   * cannot see that custom-role policy, and `updateInterfacePermissions` re-seeds only
   * USER and ADMIN.
   */
  it('grants RUN_CODE through interface.runCode, with the UI surfaces hidden client-side', () => {
    expect(config.interface?.runCode).toBe(true);
  });

  it('lists execute_code as an agent capability', () => {
    expect(config.endpoints?.agents?.capabilities ?? []).toContain('execute_code');
  });

  it('requests code execution on every user-facing spec (absent means off, not inherit)', () => {
    const userFacing = (config.modelSpecs?.list ?? []).filter(
      (spec) => spec.name !== 'karl-autogenerate-prompt',
    );

    expect(userFacing.length).toBeGreaterThan(0);
    expect(userFacing.filter((spec) => spec.executeCode !== true).map((spec) => spec.name)).toEqual(
      [],
    );
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
