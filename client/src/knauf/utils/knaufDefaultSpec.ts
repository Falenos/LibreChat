import type { TConversation, TModelSpec, TPreset } from 'librechat-data-provider';
import { hasModelSelection } from '~/utils/endpoints';

/**
 * [knauf] KK20-257 — should a brand-new conversation inherit the hard default model spec?
 *
 * THE BUG THIS FIXES
 * `useNewConvo` only auto-applies a default spec when `shouldApplyModelSpec` is true, and
 * that expression never covers the **hard default** case (`modelSpecs.list[].default`):
 * `getDefaultModelSpec` returns `{ default }` and returns early, leaving `last` and
 * `softDefault` undefined, so with `modelSpecs.prioritize: false` and
 * `interface.modelSelect: true` — KARL's configuration — every disjunct is false.
 *
 * The visible consequence: clicking "New chat" calls `newConversation()` with no preset,
 * so `applyModelSpecEffects` receives `specName: undefined`, takes its no-spec branch and
 * **nulls the ephemeral agent** for the new conversation. Everything the spec was carrying
 * goes with it — `execute_code`, `artifacts`, `skills`, `web_search` — and the submitted
 * conversation has no `spec` either, so the server cannot restore them from
 * `modelSpec.executeCode` (packages/api/src/agents/load.ts). A page refresh papers over it,
 * because `ChatRoute` DOES pass the default-spec preset on its new-convo effect; that is
 * why the attach menu's code row appears after F5 and not before.
 *
 * It also hid itself: `useToolToggle` persists each key to `LAST_*_TOGGLE_`, so once a
 * capability has been true in a browser the localStorage refill in `BadgeRowContext`
 * restores it on later new chats. `execute_code` was the one key never written true before
 * this ticket, which is why code execution is where the bug surfaced.
 *
 * WHY THE HARD-DEFAULT CASE IS SAFE TO DECIDE HERE
 * A hard `default: true` spec means the deployment has one spec that every fresh
 * conversation runs — it is what `ChatRoute` already applies on load, so honouring it on
 * the button path makes the two paths agree instead of introducing a new policy.
 *
 * `hasModelSelection` is the discriminator that keeps this narrow: it distinguishes "no
 * preset resolved yet" (a genuinely fresh chat, template carries no spec/agent/model/
 * endpoint) from "the user deliberately picked something else" via the model selector,
 * which `modelSpecs.enforce: false` permits. Only the first inherits the default.
 */
export function knaufHardDefaultSpecApplies(params: {
  /** The hard default from `getDefaultModelSpec(...)?.default`, if the deployment has one. */
  hardDefaultSpec?: TModelSpec | null;
  /** The preset the caller passed to `newConversation`, if any. */
  preset?: Partial<TPreset> | null;
  /** The template the caller passed to `newConversation`. */
  template?: Partial<TConversation> | null;
}): boolean {
  const { hardDefaultSpec, preset, template } = params;
  if (hardDefaultSpec == null) {
    return false;
  }
  if (preset != null) {
    return false;
  }
  return !hasModelSelection(template);
}
