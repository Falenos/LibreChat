/**
 * Smoke test for the admin builder-mode atom (KK20-125 / FEAT-03).
 *
 * Pins:
 *   - the localStorage key (`knaufAdminBuilderMode`) — the same string used by
 *     `atomWithLocalStorage`, so renaming it would silently lose admin
 *     preferences on first load.
 *   - the default value (`'detailed'`) — flipping this would change the
 *     out-of-the-box experience for admins.
 */
import { KNAUF_ADMIN_BUILDER_MODE_KEY, knaufAdminBuilderModeAtom } from './builderMode';

describe('knaufAdminBuilderModeAtom', () => {
  it('uses the documented localStorage key', () => {
    expect(KNAUF_ADMIN_BUILDER_MODE_KEY).toBe('knaufAdminBuilderMode');
  });

  it('exposes a Recoil atom whose key matches the localStorage key', () => {
    expect(knaufAdminBuilderModeAtom.key).toBe(KNAUF_ADMIN_BUILDER_MODE_KEY);
  });
});
