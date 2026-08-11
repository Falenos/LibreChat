import { join } from 'path';
import { readFileSync } from 'fs';

/**
 * [knauf] KK20-257 — tripwire on the three manual code-execution surfaces.
 *
 * `interface.runCode` is `true` in librechat.yaml, which is what makes the manual
 * execution path work at all: `POST /tools/:toolId/call` is the one server route that
 * checks RUN_CODE.USE (api/server/controllers/tools.js). It has never gated agent
 * auto-run — that comes from the `execute_code` capability plus the per-spec
 * `executeCode` flag (packages/api/src/agents/load.ts).
 *
 * The permission being on means every UI surface it unlocks has to be suppressed
 * deliberately, in three separate components. KARL ships none of them: code execution is
 * automatic and has no user-facing controls, the same model as artifacts, skills and file
 * search. The failure this guards is partial — someone flips one constant, or deletes one
 * `[knauf]` block during an upstream merge, and the chat grows a control we removed on
 * purpose while the other two stay hidden. That reads as a bug, not a decision.
 *
 * Asserted at source level rather than by rendering three components: the invariant is
 * "all three, together, plus the permission that makes them meaningful", which no single
 * render test can express.
 */
const CLIENT_SRC = join(__dirname, '..', '..', '..');
const REPO_ROOT = join(CLIENT_SRC, '..', '..');

const read = (relativeToClientSrc: string): string =>
  readFileSync(join(CLIENT_SRC, relativeToClientSrc), 'utf8');

const SURFACES: { file: string; flag: string; what: string }[] = [
  {
    file: 'components/Chat/Input/CodeInterpreter.tsx',
    flag: 'KNAUF_HIDE_CODE_INTERPRETER_CHIP',
    what: 'composer code-interpreter chip',
  },
  {
    file: 'components/Chat/Input/ToolsDropdown.tsx',
    flag: 'KNAUF_HIDE_CODE_INTERPRETER_TOOL',
    what: 'tools-menu Run code row',
  },
  {
    file: 'components/Chat/Messages/Content/MarkdownComponents.tsx',
    flag: 'KNAUF_HIDE_CODE_BLOCK_RUN_BUTTON',
    what: 'per-code-block Run button',
  },
];

describe('[knauf] KK20-257 manual code-execution surfaces stay hidden', () => {
  it.each(SURFACES)('hides the $what', ({ file, flag }) => {
    const source = read(file);
    expect(source).toContain(`const ${flag} = true as boolean`);
  });

  it('keeps every surface hidden — a partial flip is the regression', () => {
    const flipped = SURFACES.filter(
      ({ file, flag }) => !read(file).includes(`const ${flag} = true as boolean`),
    );
    // Names in the failure output, so the diff says which surface would render.
    expect(flipped.map((s) => s.what)).toEqual([]);
  });

  it.each(SURFACES)('wraps the $what gate in a paired [knauf] block', ({ file, flag }) => {
    const source = read(file);
    const gateIndex = source.indexOf(flag);
    expect(gateIndex).toBeGreaterThan(-1);
    // The seam scanner only registers a block that wraps code, so an unpaired marker
    // silently drops the row from SEAMS.md.
    const before = source.slice(0, gateIndex);
    const after = source.slice(gateIndex);
    expect(before).toContain('[knauf]');
    expect(after).toContain('End [knauf]');
  });

  it('leaves the RUN_CODE permission enabled, so the hides are load-bearing', () => {
    // If someone "simplifies" this back to `runCode: false`, the three constants above
    // become dead code and the manual path is disabled by permission instead — which is
    // the state KK20-252 shipped and KK20-257 deliberately moved away from.
    const yaml = readFileSync(join(REPO_ROOT, 'librechat.yaml'), 'utf8');
    expect(yaml).toMatch(/^\s*runCode:\s*true\s*$/m);
  });
});
