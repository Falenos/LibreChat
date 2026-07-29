/**
 * [knauf] KK20-243 — rendered interaction test for the capability rows.
 *
 * `capabilities.knauf.spec.ts` pins `applyToForm` / `readFromForm` in isolation
 * and passed while both KK20-243 rows were unusable, because each half worked:
 * the click wrote the form, and reading the form returned the new value. What
 * was broken sat between them — `CapabilitySwitch` is controlled, and the row
 * subscribed to `model_parameters` while the new rows write top-level
 * `artifacts` / `skills_enabled`. No subscription, no re-render, so `checked`
 * stayed stale: the DOM went false -> false while the form went undefined ->
 * 'default'. Every later click re-requested the same transition.
 *
 * These tests therefore assert on the **rendered switch**, not on the form
 * object. A form-only assertion cannot fail on this class of bug.
 */
import userEvent from '@testing-library/user-event';
import { useForm, FormProvider } from 'react-hook-form';
import { render, screen } from '@testing-library/react';
import { AgentCapabilities, ArtifactModes } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { KNAUF_CAPABILITIES } from './capabilities';
import CapabilityRow from './CapabilityRow';

jest.mock('~/hooks', () => ({
  // The rows under test declare i18n keys; echo the key so the label is stable
  // and we are not asserting on translated copy.
  useLocalize: () => (key: string) => key,
}));

function capabilityById(id: string) {
  const capability = KNAUF_CAPABILITIES.find((entry) => entry.id === id);
  if (!capability) {
    throw new Error(`No capability registered with id "${id}"`);
  }
  return capability;
}

/**
 * Renders one row inside a real react-hook-form context. `formRef` exposes the
 * live form so a test can assert the persisted value alongside the DOM — both
 * halves matter, and only checking one is how this bug survived.
 */
function renderRow(id: string, defaultValues: Partial<AgentForm> = {}) {
  const formRef: { current: ReturnType<typeof useForm<AgentForm>> | null } = { current: null };
  const capability = capabilityById(id);

  function Harness() {
    const methods = useForm<AgentForm>({ defaultValues: defaultValues as AgentForm });
    formRef.current = methods;
    return (
      <FormProvider {...methods}>
        <CapabilityRow capability={capability} />
      </FormProvider>
    );
  }

  render(<Harness />);
  const label = capability.labelKey ?? capability.label;
  return { formRef, capability, label, toggle: screen.getByRole('switch', { name: label }) };
}

const isOn = (element: HTMLElement) => element.getAttribute('aria-checked') === 'true';

describe('[knauf] CapabilityRow — rendered interaction', () => {
  it.each([
    ['artifacts', 'com_knauf_capability_artifacts_label'],
    ['skills', 'com_knauf_capability_skills_label'],
  ])('renders %s off by default and turns it on in the DOM', async (id, expectedLabel) => {
    const { formRef, toggle, label } = renderRow(id);
    expect(label).toBe(expectedLabel);
    expect(isOn(toggle)).toBe(false);

    await userEvent.click(toggle);

    // The assertion that fails without `watchFields`: the switch itself repaints.
    expect(isOn(screen.getByRole('switch', { name: label }))).toBe(true);
    // And the form really was written — so this is a render fix, not a mask.
    const field = id === 'artifacts' ? AgentCapabilities.artifacts : 'skills_enabled';
    expect(formRef.current?.getValues(field as keyof AgentForm)).toBeTruthy();
  });

  it.each([['artifacts'], ['skills']])('round-trips %s off again on a second click', async (id) => {
    // The stale-`checked` bug made a controlled switch un-toggleable: with
    // `checked` pinned false, every click asked for false -> true again and
    // the row could never be turned back off.
    const { formRef, label } = renderRow(id);

    await userEvent.click(screen.getByRole('switch', { name: label }));
    expect(isOn(screen.getByRole('switch', { name: label }))).toBe(true);

    await userEvent.click(screen.getByRole('switch', { name: label }));
    expect(isOn(screen.getByRole('switch', { name: label }))).toBe(false);

    const field = id === 'artifacts' ? AgentCapabilities.artifacts : 'skills_enabled';
    expect(formRef.current?.getValues(field as keyof AgentForm)).toBeFalsy();
  });

  it('reflects a pre-set artifacts mode as on, without a click', () => {
    // Mirrors loading a saved agent: resetAgentForm populates the field and the
    // row must render checked on first paint.
    const { toggle } = renderRow('artifacts', {
      [AgentCapabilities.artifacts]: ArtifactModes.DEFAULT,
    } as Partial<AgentForm>);
    expect(isOn(toggle)).toBe(true);
  });

  it('reflects a pre-set skills_enabled as on, without a click', () => {
    const { toggle } = renderRow('skills', { skills_enabled: true } as Partial<AgentForm>);
    expect(isOn(toggle)).toBe(true);
  });

  it('writes the artifacts mode STRING, visible through the rendered row', async () => {
    // The string-vs-boolean trap, exercised through the UI rather than by
    // calling applyToForm directly.
    const { formRef, label } = renderRow('artifacts');
    await userEvent.click(screen.getByRole('switch', { name: label }));
    const value = formRef.current?.getValues(AgentCapabilities.artifacts as keyof AgentForm);
    expect(value).toBe(ArtifactModes.DEFAULT);
    expect(typeof value).toBe('string');
  });

  it('still works for browseInternet, which writes model_parameters too', async () => {
    // Regression guard on the row that previously worked only by accident: its
    // watchFields now name `web_search` explicitly rather than relying on the
    // incidental `model_parameters` write.
    const { formRef, toggle, label } = renderRow('web');
    expect(isOn(toggle)).toBe(false);

    await userEvent.click(screen.getByRole('switch', { name: label }));

    expect(isOn(screen.getByRole('switch', { name: label }))).toBe(true);
    expect(formRef.current?.getValues(AgentCapabilities.web_search as keyof AgentForm)).toBe(true);
    expect(
      (formRef.current?.getValues('model_parameters') as Record<string, unknown> | undefined)
        ?.web_search,
    ).toBe(true);
  });
});

describe('[knauf] KNAUF_CAPABILITIES watchFields', () => {
  it('declares watchFields for every entry', () => {
    for (const entry of KNAUF_CAPABILITIES) {
      expect(Array.isArray(entry.watchFields)).toBe(true);
      expect(entry.watchFields.length).toBeGreaterThan(0);
    }
  });

  it('watches the exact field each row writes', () => {
    // The invariant that keeps the render honest: whatever applyToForm writes
    // must appear in watchFields, or the switch goes stale again. Derived by
    // recording the writes rather than restating them.
    for (const entry of KNAUF_CAPABILITIES) {
      const written: string[] = [];
      entry.applyToForm(true, {
        getValues: (() => ({})) as never,
        setValue: ((name: string) => written.push(name)) as never,
      });
      expect(written.length).toBeGreaterThan(0);
      for (const field of written) {
        expect(entry.watchFields).toContain(field);
      }
    }
  });

  it('keeps watchFields referentially stable, so useWatch does not churn', () => {
    for (const entry of KNAUF_CAPABILITIES) {
      expect(entry.watchFields).toBe(entry.watchFields);
    }
  });
});
