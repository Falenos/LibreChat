/**
 * [knauf] Seam test for the artifacts + skills composer-chip hides.
 *
 * Every user-facing KARL spec sets `artifacts: 'default'` and `skills: true`, so
 * both capabilities are permanently on. Upstream renders a checked chip for each,
 * whose only reachable action is to turn the capability OFF — a switch users read
 * as "this is optional" for something the product treats as ambient.
 *
 * The hides are `KNAUF_HIDE_ARTIFACTS_CHIP` / `KNAUF_HIDE_SKILLS_CHIP` early
 * returns in the upstream components, mirroring the KK20-190 file-search chip.
 *
 * Each case below sets up the context that would make the chip visible upstream —
 * capability enabled, toggle on, chip pinned, permission granted — so the only
 * thing keeping the render empty is the seam. Flip either const to `false` and
 * these fail. That is the point: a `Manual` entry in SEAMS.md would not survive an
 * upstream sync that took upstream's version of the early-return block.
 */
import React from 'react';
import { render } from '@testing-library/react';
import { ArtifactModes } from 'librechat-data-provider';
import Artifacts from '~/components/Chat/Input/Artifacts';
import Skills from '~/components/Chat/Input/Skills';

const mockUseBadgeRowContext = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  // Both capabilities on — the chips' own gates must not be what hides them.
  useAgentCapabilities: () => ({ artifactsEnabled: true, skillsEnabled: true }),
  useHasAccess: () => true,
}));

jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => mockUseBadgeRowContext(),
}));

/** Renders something visible, so a removed seam produces a non-empty container. */
jest.mock('@librechat/client', () => ({
  __esModule: true,
  CheckboxButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockUseBadgeRowContext.mockReturnValue({
    // Toggled ON and pinned — upstream would render both chips.
    artifacts: {
      toggleState: ArtifactModes.DEFAULT,
      debouncedChange: jest.fn(),
      isPinned: true,
      setIsPinned: jest.fn(),
    },
    skills: {
      toggleState: true,
      debouncedChange: jest.fn(),
      isPinned: true,
      setIsPinned: jest.fn(),
    },
    agentsConfig: { capabilities: ['artifacts', 'skills'] },
  });
});

describe('[knauf] composer chip hides', () => {
  it('renders no artifacts chip even when enabled, toggled on and pinned', () => {
    const { container } = render(<Artifacts />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders no skills chip even when permitted, toggled on and pinned', () => {
    const { container } = render(<Skills />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not depend on the capability being off to stay hidden', () => {
    // Guards against a future "fix" that hides the chips by disabling the
    // capability instead — that would also switch the feature off for the model.
    const { container: artifacts } = render(<Artifacts />);
    const { container: skills } = render(<Skills />);
    expect(artifacts).toBeEmptyDOMElement();
    expect(skills).toBeEmptyDOMElement();
    // The context still reports both capabilities as active.
    expect(mockUseBadgeRowContext.mock.results[0].value.agentsConfig.capabilities).toEqual([
      'artifacts',
      'skills',
    ]);
  });
});
