import type { Types } from 'mongoose';

/**
 * [knauf] KK20-397 — the skills primed THIS turn, by the exact doc the resolver picked.
 *
 * A manual `$name` or always-apply prime has no `skill` call in history yet, so its bundled
 * files are mounted through `primeInvokedSkills` as an extra. That function resolves skills
 * by name, and a name is not unique: the manual resolver prefers the user-invocable doc,
 * while a plain name lookup can return a newer same-name model-only skill. The model would
 * then read skill A's instructions while `/mnt/data/<name>/` held skill B's helpers. So each
 * prime travels with its `_id`, and the file lookup is pinned to it — the same pinning
 * upstream applies to `read_file` (`skillPrimedIdsByName`).
 */
export interface KnaufFreshSkillPrime {
  name: string;
  _id: Types.ObjectId;
}

/** Manual primes first (they win a name clash, as in `injectSkillPrimes`), one per name. */
export function collectKnaufFreshSkillPrimes({
  manualSkillPrimes,
  alwaysApplySkillPrimes,
}: {
  manualSkillPrimes?: KnaufFreshSkillPrime[];
  alwaysApplySkillPrimes?: KnaufFreshSkillPrime[];
}): KnaufFreshSkillPrime[] {
  const byName = new Map<string, KnaufFreshSkillPrime>();
  for (const prime of [...(manualSkillPrimes ?? []), ...(alwaysApplySkillPrimes ?? [])]) {
    if (!byName.has(prime.name)) {
      byName.set(prime.name, { name: prime.name, _id: prime._id });
    }
  }
  return [...byName.values()];
}

/**
 * Name → the id its lookup is pinned to. A prime whose id is not in the caller's
 * ACL-accessible set is dropped, so pinning can narrow a lookup but never widen access.
 */
export function knaufPinnedSkillIds(
  primes: Iterable<KnaufFreshSkillPrime> | undefined,
  accessibleIds: readonly Types.ObjectId[],
): Map<string, Types.ObjectId> {
  const accessible = new Set(accessibleIds.map((id) => String(id)));
  const pinned = new Map<string, Types.ObjectId>();
  for (const prime of primes ?? []) {
    if (!pinned.has(prime.name) && accessible.has(String(prime._id))) {
      pinned.set(prime.name, prime._id);
    }
  }
  return pinned;
}
