---
name: knauf-coding-style
description: Use this skill before writing or editing React/TypeScript code in `client/` or `packages/` in this fork. Codifies upstream-aligned patterns for i18n (`com_knauf_*` keys + `localize`), list rendering (lifted state, stable callbacks, useRef for unstable hook closures), TypeScript imports, Knauf-namespaced schema additions, UX edge cases (empty-state messages, setTimeout cleanup, clipboard, locale-pinned sort), and documenting intentional divergences from upstream.
---

# Knauf Coding Style

This skill covers the *how* of writing code in this fork. Pair with [`fork-management`](../fork-management/SKILL.md) (the *where* — tiers and markers), [`seam-manifest`](../seam-manifest/SKILL.md) (SEAMS.md authoring), and [`knauf-change-workflow`](../knauf-change-workflow/SKILL.md) (branches, commits, PRs).

Negative companion rules live in [`.claude/notes/ANTI_PATTERNS.md`](../../notes/ANTI_PATTERNS.md). When something here says "do X this way," there is usually a matching "don't do the alternative" entry there.

---

## Pattern: localise every user-facing string

**Three-file workflow** when introducing a new English label:

1. **Grep upstream first** — many actions already exist as `com_ui_*` / `com_endpoint_*` / `com_nav_*` keys. Reuse beats duplication.

   ```bash
   grep -E '"(Pinned|My Agents|Search agents)"' client/src/locales/en/translation.json
   grep -E '"com_(ui|endpoint|nav)_(pin|unpin|copy|copied|select_agent)"' \
     client/src/locales/en/translation.json
   ```

   Common upstream keys worth checking before adding Knauf duplicates:

   | Concept | Upstream key | Value |
   |---|---|---|
   | Pin (verb) | `com_ui_pin` | Pin |
   | Unpin (verb) | `com_ui_unpin` | Unpin |
   | Copy (verb) | `com_ui_copy` | Copy |
   | Copied! | `com_ui_copied` | Copied! |
   | Select Agent | `com_ui_select_agent` | Select Agent |
   | Default (adj.) | `com_endpoint_default` | default |
   | Search endpoint | `com_endpoint_search` | Search endpoint by name |
   | Clear search | `com_ui_clear_search` | Clear search |

2. **If no upstream match, add a `com_knauf_*` key** to **both** `client/src/locales/en/translation.json` and `client/src/locales/de/translation.json`. Knauf is German-headquartered — minimum two locales. Other locales fall back to English via i18next's missing-key chain (same behaviour the existing `com_knauf_builder_*` keys had).

   Insert alphabetically into the existing `com_knauf_*` block (between `com_info_*` and `com_nav_*` in the file). A whole `com_knauf_*` block in one place is greppable and namespaced.

3. **Use `localize()` at the call site**, never module-level string consts. Each component that needs strings calls `useLocalize()` itself — that's idiomatic across the codebase (`FavoriteItem`, `ModelSelector`, all upstream picker components do this).

   ```tsx
   import { useLocalize } from '~/hooks';

   function KnaufSomething() {
     const localize = useLocalize();
     return (
       <>
         <h2>{localize('com_knauf_pinned')}</h2>
         <button type="button">{localize('com_ui_pin')}</button>
       </>
     );
   }
   ```

**JSX attribute strings vs JSX text children.** `i18next/no-literal-string` only flags JSX *text children* (`<div>literal</div>`), not attribute values (`<div title="literal">`). Attribute literals still need localisation for the same UX reason — but the lint won't catch them. Self-discipline.

**Internal-only string consts are still fine.** Form field names, CSS classes, event names, atom keys, etc. are never JSX text — they're inputs to programmatic APIs. The rule is about user-visible language, not all string constants.

See also: [ANTI_PATTERNS — Don't hide user-facing strings behind module-level consts](../../notes/ANTI_PATTERNS.md).

---

## Pattern: list rendering with stable handlers + lifted hooks

When you render N rows from a list, three things need to be true for `memo()` on the row to actually save work:

1. **Hooks that subscribe to shared state live on the parent**, not in each row. Calling `useFavorites()` / `useTheme()` / any atom-bound hook inside a memo'd row creates N subscriptions and forces N re-renders on every shared-state change.

2. **Callbacks passed to rows are stable.** No inline arrows in the map. Pass a function that takes `id` (or whatever the row knows) and bind inside the row's own `useCallback`.

3. **If the parent's hook returns mutators that aren't memoised** (the common pattern in this codebase — `useFavorites` rebuilds `addFavoriteAgent`/`removeFavoriteAgent` every render), wrap them in refs and update via a deps-less `useEffect`. Then `useCallback` reads through `ref.current` and stays stable forever.

Reference implementation — agents list with pin/unpin:

```tsx
function Parent() {
  const { favorites, addFavoriteAgent, removeFavoriteAgent } = useFavorites();

  // Hook closures are unstable → stable refs to satisfy memo() on rows.
  const addRef = useRef(addFavoriteAgent);
  const removeRef = useRef(removeFavoriteAgent);
  useEffect(() => {
    addRef.current = addFavoriteAgent;
    removeRef.current = removeFavoriteAgent;
  });

  const pinnedIds = useMemo(
    () => new Set(favorites.map((f) => f.agentId).filter(Boolean)),
    [favorites],
  );

  const onSelect = useCallback((agentId: string) => {
    /* … */
  }, [/* parent-stable deps */]);

  const onTogglePin = useCallback((agentId: string, pinned: boolean) => {
    (pinned ? removeRef.current : addRef.current)(agentId);
  }, []);

  return agents.map((agent) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      pinned={pinnedIds.has(agent.id)}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
    />
  ));
}

const AgentRow = memo(function AgentRow({
  agent,
  pinned,
  onSelect,
  onTogglePin,
}: Readonly<{
  agent: Agent;
  pinned: boolean;
  onSelect: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
}>) {
  const handleSelect = useCallback(() => onSelect(agent.id), [agent.id, onSelect]);
  const handlePin = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onTogglePin(agent.id, pinned);
    },
    [agent.id, pinned, onTogglePin],
  );
  /* … */
});
```

Pre-merge checklist for list components:

- [ ] No inline arrows in the `.map(...)` JSX
- [ ] No `useFavorites()` / atom-subscribing hooks inside the memo'd row
- [ ] Stable handlers are actually stable (deps array doesn't include hook-returned mutators directly)
- [ ] `Readonly<{...}>` on all new row props

See also: [ANTI_PATTERNS — Don't break `memo()` with inline arrows or per-row hook calls](../../notes/ANTI_PATTERNS.md).

---

## Pattern: TypeScript imports and prop types

**Type-only imports for type references.** Don't reach for `React.X` if you can `import type { X } from 'react'`. The latter is explicit, tree-shakeable, and works without a default React import.

```tsx
// Good — type-only, named.
import { useCallback, useEffect, type ComponentType, type MouseEvent } from 'react';
import type { LucideProps } from 'lucide-react';
import type { Agent, TStartupConfig } from 'librechat-data-provider';

// Bad — relies on global namespace from @types/react.
const handle = (e: React.MouseEvent) => { /* … */ };
```

**Reuse upstream prop types when replacing or wrapping an upstream component, but wrap them in `Readonly<>`.** If `ModelSelector` takes `ModelSelectorProps`, your `KnaufModelSelector` does too — that way an upstream rename surfaces as a TS error at your import site, not a runtime drift months later. SonarCloud's `readonly props` rule (S6759) cares about the declared type at the destructure site, and the upstream interface isn't `Readonly`, so the wrapper is required.

```tsx
// Good — upstream alignment + Readonly wrapper.
import type { ModelSelectorProps } from '~/common';

export default function KnaufModelSelector({
  startupConfig,
}: Readonly<ModelSelectorProps>) { … }

// Acceptable for net-new components — but inline shapes don't catch upstream drift.
function KnaufThing({ x }: Readonly<{ x: string }>) { … }

// Bad — reusing the upstream type without the wrapper still trips S6759.
function KnaufModelSelector({ startupConfig }: ModelSelectorProps) { … }
```

**One import statement per source module.** ANTI_PATTERNS already enforces this. Add it to your muscle memory: before adding `import { Foo } from 'X'`, grep the file for `'X'` and merge into the existing line.

**`Readonly<{…}>` on every new React prop type.** ANTI_PATTERNS rule; SonarQube rule too. No exceptions for "it's a tiny component" and no exceptions for "I'm reusing an imported interface."

---

## Pattern: Knauf-namespaced schema additions

Knauf-only additions to `librechat.yaml`'s `interface:` block (or any block in the upstream-defined config schema) nest under a `knauf:` key, not at the top level.

**`librechat.yaml`:**
```yaml
interface:
  modelSelect: true
  presets: false
  multiConvo: false
  knauf:                 # ← Knauf-only options live in their own block
    defaultAgentId: 'agent_xyz'
```

**Zod schema in `packages/data-provider/src/config.ts`** (inside a `[knauf]` block, per fork-management Tier 4c):
```ts
interfaceSchema = z.object({
  // … upstream fields …
  // [knauf] Knauf-specific interface options, namespaced so future Knauf
  // additions don't collide with upstream `interface.*` fields. (KK20-XXX)
  knauf: z
    .object({
      defaultAgentId: z.string().optional(),
    })
    .optional(),
  // End [knauf]
});
```

**Why nest:** if a future upstream release adds `interface.defaultAgentId` at the top level with different semantics, a Knauf top-level field would silently collide on merge. The `knauf:` sub-object is collision-proof.

**Reading from the schema:**
- After `npm run build:packages`, the Zod-inferred `TInterfaceConfig` carries the `knauf` field and you can read it directly.
- **Before** that rebuild, the `dist/` artefact is one step behind source. A small typed-accessor helper bridges the gap:

  ```tsx
  type KnaufInterfaceExtension = { knauf?: { defaultAgentId?: string } };
  function getKnaufDefaultAgentId(interfaceConfig: unknown): string {
    return (interfaceConfig as KnaufInterfaceExtension | null | undefined)?.knauf?.defaultAgentId
      ?? '';
  }
  ```

  Drop the helper once the rebuild lands. JSDoc the intent so reviewers know it's a crutch.

See also: [CLAUDE.local.md — Shared packages run from `dist/`, not `src/`](../../../CLAUDE.local.md).

---

## Pattern: UX edge cases that bite later

**Distinguish empty data from no-search-match.** A single "No items" message lies when the list is truly populated but the search filtered everything out.

```tsx
{filteredAgents.length === 0 ? (
  <div className="p-3 text-center text-xs text-text-secondary">
    {searchValue
      ? localize('com_knauf_no_agent_matches')
      : localize('com_knauf_no_agents_available')}
  </div>
) : (
  /* render the list */
)}
```

**`setTimeout` from event handlers needs cleanup.** Capture the timer id in a ref, clear on unmount, and clear the previous timer before starting a new one (otherwise repeated clicks stack toasts).

```tsx
const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
useEffect(() => {
  return () => {
    if (timeoutRef.current != null) clearTimeout(timeoutRef.current);
  };
}, []);

const onCopy = useCallback(() => {
  if (timeoutRef.current != null) clearTimeout(timeoutRef.current);
  setCopied(true);
  timeoutRef.current = setTimeout(() => setCopied(false), 1500);
}, []);
```

**`navigator.clipboard` may be undefined** on older browsers or non-HTTPS contexts. Guard the call, and ideally surface a fallback path (selectable text + manual `Cmd+C`) rather than failing silently.

```tsx
if (typeof navigator === 'undefined' || !navigator.clipboard) return;
navigator.clipboard.writeText(text).then(/* … */, () => undefined);
```

**Locale-sensitive `Array.sort` needs a pinned locale.** `localeCompare` without args uses the browser's default — which means German users may see a different order than English users on the same data. For cross-user-consistent orderings, pin to one locale:

```ts
const SORT_LOCALE = 'en';
items.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', SORT_LOCALE));
```

Pick a locale that matches the dominant user base (Knauf-DE → arguably `'de'`); the important property is consistency, not which locale wins.

**`<button type="button">` for any clickable non-submit element.** No `role="button"` on a `<div>`, no `tabIndex={0}` + `onKeyDown` to mimic native behaviour. ANTI_PATTERNS rule, easy to forget on hover-revealed action buttons inside menu items.

---

## Pattern: document intentional divergence from upstream

When a Knauf variant deliberately differs from the upstream component it replaces or seams into, leave a code comment explaining *why*. The diff during a future upstream sync should make the intent obvious — without that comment, the reviewer has to reconstruct the reasoning from git history.

```tsx
/**
 * Diverges intentionally from upstream `ModelSelector`, which keeps the
 * picker visible when `modelSelect: false` *and* there are model specs.
 * In the Knauf flow model specs are hidden from the picker by design, so
 * `modelSelect: false` means "no picker", full stop.
 */
if (interfaceConfig.modelSelect === false) {
  return null;
}
```

Two-line minimum: what's different, why we made it different. Avoid "see PR #N" — PRs vanish from search, code comments don't.

The same rule applies to `[knauf]` markers in upstream files: the description on the open line is content, not boilerplate. `// [knauf] hide Advanced for simplified builder` beats `// [knauf] change`.

---

## Pre-PR self-review (positive companion to ANTI_PATTERNS)

Before opening a PR with React/TS changes, walk this list:

| Check | Pattern |
|---|---|
| All user-facing strings go through `localize()`? | [i18n](#pattern-localise-every-user-facing-string) |
| New i18n keys added to both `en/` and `de/`, sorted alphabetically? | [i18n](#pattern-localise-every-user-facing-string) |
| List rows are `memo`'d with stable handlers + no per-row hooks? | [List rendering](#pattern-list-rendering-with-stable-handlers--lifted-hooks) |
| State-driven effects gated on state, not on one-shot refs? | [ANTI_PATTERNS — one-shot ref](../../notes/ANTI_PATTERNS.md) |
| All `useRef` for unstable hook closures updated via deps-less `useEffect`? | [List rendering](#pattern-list-rendering-with-stable-handlers--lifted-hooks) |
| Knauf-only `interface.*` fields nested under `interface.knauf.*`? | [Schema namespace](#pattern-knauf-namespaced-schema-additions) |
| `import type` for type-only references; upstream prop types reused? | [TS imports](#pattern-typescript-imports-and-prop-types) |
| Empty-state messages distinguish "empty" from "no match"? | [UX edge cases](#pattern-ux-edge-cases-that-bite-later) |
| `setTimeout`s cleaned up + clipboard guarded + sort locale pinned? | [UX edge cases](#pattern-ux-edge-cases-that-bite-later) |
| Intentional divergence from upstream documented inline? | [Divergence](#pattern-document-intentional-divergence-from-upstream) |
| `[knauf]` markers + SEAMS.md rows in sync? | [`seam-manifest`](../seam-manifest/SKILL.md) |
| Lint + tsc + `seams.js check && diff-check` all green locally? | [ANTI_PATTERNS — Run lint + tsc locally](../../notes/ANTI_PATTERNS.md) |
