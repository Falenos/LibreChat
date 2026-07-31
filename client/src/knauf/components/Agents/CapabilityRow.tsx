/**
 * [knauf] KK20-243 — one row of the "What it can do" section, driven by a
 * `KNAUF_CAPABILITIES` entry.
 *
 * Extracted from `KnaufAgentConfig.tsx` so it can be rendered in isolation. That
 * matters here rather than being tidiness: the defect this file fixes is only
 * observable through a real render. `CapabilitySwitch` is **controlled** — it
 * paints the `checked` prop — so a row that writes a form field it does not
 * subscribe to updates the form and then never re-renders. A unit test calling
 * `applyToForm` and `readFromForm` directly passes with the bug present, because
 * both halves work; what was broken was the render in between. Rendering
 * `KnaufAgentConfig` to reach the row is not a real option (36 imports, Recoil,
 * two dialog trees and three contexts), and a test that mocks all of that breaks
 * on changes unrelated to what it asserts.
 */
import { useFormContext, useWatch } from 'react-hook-form';
import type { KNAUF_CAPABILITIES } from './capabilities';
import type { AgentForm } from '~/common';
import CapabilitySwitch from './CapabilitySwitch';
import { useLocalize } from '~/hooks';

export default function CapabilityRow({
  capability,
}: Readonly<{
  capability: (typeof KNAUF_CAPABILITIES)[number];
}>) {
  const localize = useLocalize();
  const { control, getValues, setValue } = useFormContext<AgentForm>();
  /**
   * Subscribe to the fields THIS row reads, declared by the registry as
   * `watchFields`. This was previously hardcoded to `model_parameters`, which
   * only ever worked for `browseInternet` — that row writes `model_parameters`
   * as a side effect of toggling web search, so the subscription fired by luck.
   * `artifacts` and `skills_enabled` are plain top-level fields, so their rows
   * wrote the form and re-rendered never: the switch showed the old value and
   * every subsequent click re-requested the same transition.
   *
   * `watchFields` is a stable module-level array per entry, so the subscription
   * identity does not churn between renders.
   */
  useWatch({ control, name: capability.watchFields as never });
  const checked = capability.readFromForm({ getValues, setValue });

  return (
    <CapabilitySwitch
      icon={capability.icon}
      /* Prefer the i18n key; the literal is the fallback for rows authored
       * before this panel was localized (see KnaufCapability). */
      label={capability.labelKey ? localize(capability.labelKey as never) : capability.label}
      description={
        capability.descriptionKey
          ? localize(capability.descriptionKey as never)
          : capability.description
      }
      checked={checked}
      onChange={(next) => capability.applyToForm(next, { getValues, setValue })}
    />
  );
}
