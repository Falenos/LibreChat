# Testing Strategy & Rollback

---

## Testing Strategy

### Upstream Tests

LibreChat has its own test suite. We run it on every PR via `test:coverage`. If our seams break upstream tests, we know immediately.

These tests are a partial defense — upstream tests catch public API changes and regression, but may NOT catch private function renames or internal refactors. Seam-specific tests (below) cover those gaps.

### Seam-Specific Tests

For each `[knauf]` marker, write a test that verifies the seam's behavior. These are insurance against upstream refactors that change internal APIs without breaking upstream's own tests.

**Example: AgentFooter button-hiding seam:**

```typescript
describe('[knauf] Simplified builder — hidden buttons', () => {
  it('does not render the Advanced panel button', () => {
    render(<AgentFooter ... />);
    expect(screen.queryByRole('button', { name: /advanced/i })).not.toBeInTheDocument();
  });

  it('does not render the Duplicate agent button', () => {
    render(<AgentFooter ... />);
    expect(screen.queryByRole('button', { name: /duplicate/i })).not.toBeInTheDocument();
  });

  it('still renders Save and Delete buttons', () => {
    render(<AgentFooter ... />);
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });
});
```

**Current seam test coverage:**

| Seam | Test File | Coverage |
|---|---|---|
| API mount-point | `api/server/routes/knauf/autogeneratePrompt.spec.js` | 206-line spec |
| AgentPanel import swap | `AgentPanel.test.tsx` lines 149–156 | Mock prevents import chain break |
| AgentFooter buttons | `__tests__/AgentFooter.spec.tsx` lines 269–507 | 3 assertion blocks |
| Knauf types | `client/src/knauf/common/agents-types.spec.ts` | 43 lines |
| Personalities hook | `client/src/knauf/data-provider/Agents/usePersonalities.spec.ts` | 57 lines |

### Post-Merge Smoke Tests

After an upstream merge, before merging to `main`, run these against staging:

| Test | What It Verifies | How |
|---|---|---|
| Login with Okta | OpenID flow still works | Manual or Playwright |
| Agent builder renders | `KnaufAgentConfig` import seam | Open agent builder, verify simplified view |
| Advanced/Duplicate buttons absent | AgentFooter seam | Verify buttons are not present |
| Autogenerate Prompt works | API mount-point seam | Click button, verify response |
| Core chat works | Nothing broken by merge | Send a message, get a response |

A Playwright config and `e2e:ci` script exist. No test cases have been authored yet — manual verification is required until they are.

### Refactoring Resilience

The biggest risk: upstream restructures code that our seams depend on, without breaking their own tests.

| Upstream Refactor | Detection Mechanism |
|---|---|
| File renamed/moved | Seam validator: SEAMS.md entry points to non-existent file → CI fails |
| Function renamed | Seam-specific tests: test calls function by name → compile/runtime error |
| Variable shape changed | Seam tests: test asserts on extraction logic → test fails |
| `PermissionTypes` enum changed | Upstream tests likely break; seam tests import the enum → compile error |
| Asset paths changed | Asset reference validator warns when our assets are no longer referenced |

**Key principle:** Every seam has both a **path anchor** (file path in SEAMS.md) and a **behavior anchor** (test that exercises the seam). Path anchors catch renames/deletes. Behavior anchors catch API/logic changes.

---

## Rollback & Emergency Procedures

### Reverting a Bad Upstream Merge

```bash
# Identify the merge commit
git log --merges --oneline -5

# Revert the entire merge (keeps history intact)
git revert -m 1 <merge-commit-sha>

# Push the revert
git push origin main
```

This is why we merge instead of rebase — a single `git revert` undoes the entire upstream sync atomically.

### When to Revert

- Auth/login failures in staging or production
- Frontend JS errors spiking after deploy
- Build failures on `main` that block other work
- Agent builder breaking for all users

### Post-Revert Actions

1. **Investigate** — identify which upstream change broke which seam
2. **Fix forward** — apply the fix on a new branch, re-merge with the fix
3. **Update SEAMS.md** — if the breakage revealed a new coupling, document it
4. **Add a test** — every revert should produce a new seam test to prevent recurrence

### Post-Deploy Monitoring

After any upstream merge reaches staging/production, monitor for 24h:

| Signal | What to Watch | Tool |
|---|---|---|
| Login error rate | Spike after deploy = auth seam broken | Application logs / APM |
| Frontend JS errors | New errors = UI seam broken | Error tracking |
| API 4xx/5xx rate | Spike = backend seam broken | Application logs / APM |
| Agent builder load | Failure = import seam broken | Manual check |

---

## Related

- [code-change-protocol.md](code-change-protocol.md) — marker format and SEAMS.md authoring
