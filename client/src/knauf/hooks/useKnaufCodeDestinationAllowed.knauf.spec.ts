import { renderHook } from '@testing-library/react';
import useKnaufCodeDestinationAllowed from './useKnaufCodeDestinationAllowed';

/**
 * [knauf] KK20-257 — the shared "may this file go to the code sandbox" answer.
 *
 * The case that matters is the third one: an unseeded ephemeral agent
 * (`codeAllowedByAgent === false`) on a conversation whose spec sets `executeCode: true`.
 * The server would register the tool there — it ORs the two
 * (packages/api/src/agents/load.ts) — so a client that reads only the agent flag hides a
 * destination that works. That is what made the attach menu's code row vanish on a
 * button-created new chat and reappear after F5.
 */
const mockStartupConfig = jest.fn();

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
}));

const specs = (list: unknown[]) => ({ modelSpecs: { list } });

beforeEach(() => {
  jest.clearAllMocks();
  mockStartupConfig.mockReturnValue(
    specs([
      { name: 'karl', default: true, executeCode: true },
      { name: 'karl-web', executeCode: true },
      { name: 'karl-legacy', executeCode: false },
    ]),
  );
});

const run = (params: Parameters<typeof useKnaufCodeDestinationAllowed>[0]) =>
  renderHook(() => useKnaufCodeDestinationAllowed(params)).result.current;

describe('[knauf] useKnaufCodeDestinationAllowed', () => {
  it('is false when the capability is stripped, whatever else says yes', () => {
    // The fail-closed LIBRECHAT_CODE_BASEURL guard removes `execute_code` from the served
    // capabilities; nothing may route past that.
    expect(run({ codeEnabled: false, codeAllowedByAgent: true, specName: 'karl' })).toBe(false);
  });

  it('is true when the agent itself asks for code', () => {
    expect(run({ codeEnabled: true, codeAllowedByAgent: true })).toBe(true);
  });

  it('is true for an unseeded ephemeral agent on a spec that enables code', () => {
    // The regression: new chat via the button, ephemeral agent nulled, spec still karl.
    expect(run({ codeEnabled: true, codeAllowedByAgent: false, specName: 'karl' })).toBe(true);
  });

  it('falls back to the hard default spec when no spec name is known', () => {
    // The drag-drop picker has no conversation object; a fresh chat is submitted with the
    // default spec, so that is the right thing to answer from.
    expect(run({ codeEnabled: true, codeAllowedByAgent: false })).toBe(true);
  });

  it('respects a spec that disables code, rather than being merely permissive', () => {
    // Mirrors the server: `modelSpec.executeCode` false and no agent flag ⇒ no tool.
    expect(run({ codeEnabled: true, codeAllowedByAgent: false, specName: 'karl-legacy' })).toBe(
      false,
    );
  });

  it('prefers the conversation spec over the default', () => {
    mockStartupConfig.mockReturnValue(
      specs([
        { name: 'karl', default: true, executeCode: true },
        { name: 'karl-legacy', executeCode: false },
      ]),
    );
    expect(run({ codeEnabled: true, codeAllowedByAgent: false, specName: 'karl-legacy' })).toBe(
      false,
    );
  });

  it('is false when the deployment configures no specs at all', () => {
    mockStartupConfig.mockReturnValue({});
    expect(run({ codeEnabled: true, codeAllowedByAgent: false })).toBe(false);
    // …but an agent that installed the tool still routes.
    expect(run({ codeEnabled: true, codeAllowedByAgent: true })).toBe(true);
  });

  it('tolerates an unknown spec name by falling back to the default', () => {
    expect(run({ codeEnabled: true, codeAllowedByAgent: false, specName: 'not-a-spec' })).toBe(
      true,
    );
  });
});
