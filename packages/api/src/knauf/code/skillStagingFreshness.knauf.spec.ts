import type { CodeEnvRef } from 'librechat-data-provider';
import {
  createSkillStagingFreshness,
  isKnaufSkillFileCacheEnabled,
  knaufSkillCacheDeps,
  KNAUF_SKILL_CACHE_MIN_REMAINING_MS,
} from './skillStagingFreshness';

const ref: CodeEnvRef = {
  kind: 'skill',
  id: 'skill-1',
  version: 1,
  storage_session_id: 'karl-00000000000000000000000000000000',
  file_id: 'file-1',
};
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('[knauf] skill-file cache freshness (KK20-397)', () => {
  it('is off unless KNAUF_CODE_SKILL_FILE_CACHE=true', () => {
    expect(isKnaufSkillFileCacheEnabled({})).toBe(false);
    expect(isKnaufSkillFileCacheEnabled({ KNAUF_CODE_SKILL_FILE_CACHE: '1' })).toBe(false);
    expect(isKnaufSkillFileCacheEnabled({ KNAUF_CODE_SKILL_FILE_CACHE: 'true' })).toBe(true);
    expect(knaufSkillCacheDeps(jest.fn(), {})).toEqual({});
  });

  it('maps the object-metadata record to its authoritative expiresAt', async () => {
    const probe = jest.fn().mockResolvedValue({ size: 3, expiresAt: iso(NOW + 5 * 3_600_000) });
    const { getSessionInfo } = createSkillStagingFreshness(probe, { now: () => NOW });
    await expect(getSessionInfo(ref, 'req')).resolves.toBe(iso(NOW + 5 * 3_600_000));
    expect(probe).toHaveBeenCalledWith(ref, 'req');
  });

  it('reports a missing or malformed record as not cached', async () => {
    for (const record of [null, undefined, {}, { expiresAt: '' }, { expiresAt: 42 }]) {
      const { getSessionInfo } = createSkillStagingFreshness(jest.fn().mockResolvedValue(record));
      await expect(getSessionInfo(ref)).resolves.toBeNull();
    }
  });

  it('lets operational probe failures propagate so the caller re-uploads', async () => {
    const { getSessionInfo } = createSkillStagingFreshness(
      jest.fn().mockRejectedValue(new Error('availability could not be verified')),
    );
    await expect(getSessionInfo(ref)).rejects.toThrow('availability could not be verified');
  });

  it('requires at least an hour of staging life, not just a future expiry', () => {
    const { checkIfActive } = createSkillStagingFreshness(jest.fn(), { now: () => NOW });
    expect(checkIfActive(iso(NOW + KNAUF_SKILL_CACHE_MIN_REMAINING_MS + 1_000))).toBe(true);
    expect(checkIfActive(iso(NOW + KNAUF_SKILL_CACHE_MIN_REMAINING_MS - 1_000))).toBe(false);
    expect(checkIfActive(iso(NOW - 1_000))).toBe(false);
    expect(checkIfActive('not a date')).toBe(false);
  });

  it('provides both keys when enabled, so the upstream cache path runs', () => {
    const deps = knaufSkillCacheDeps(jest.fn(), { KNAUF_CODE_SKILL_FILE_CACHE: 'true' });
    expect(typeof deps.getSessionInfo).toBe('function');
    expect(typeof deps.checkIfActive).toBe('function');
  });
});
