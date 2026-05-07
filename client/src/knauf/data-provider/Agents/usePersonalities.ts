/**
 * Reads personality presets from upstream's `modelSpecs.list`.
 *
 * Personalities are defined in librechat.yaml as native modelSpec entries
 * with the name prefix `karl-personality-` (e.g., `karl-personality-precise`).
 * They flow through to the client unchanged via `useGetStartupConfig` — no
 * Knauf-specific config plumbing.
 *
 * Each entry's `preset` carries the model + parameters that get spread into
 * the new agent's `model_parameters` at submit time.
 */
import { useMemo } from 'react';
import { useGetStartupConfig } from '~/data-provider';
import { KARL_PERSONALITY_PREFIX } from '~/knauf/common/constants';
import {
  knaufPersonalitySchema,
  type KnaufPersonality,
} from '~/knauf/common/agents-types';

export type { KnaufPersonality } from '~/knauf/common/agents-types';

export function usePersonalities(): KnaufPersonality[] {
  const { data } = useGetStartupConfig();
  return useMemo(() => {
    const list = data?.modelSpecs?.list ?? [];
    const result: KnaufPersonality[] = [];
    for (const spec of list) {
      if (typeof spec?.name !== 'string') continue;
      if (!spec.name.startsWith(KARL_PERSONALITY_PREFIX)) continue;
      const parsed = knaufPersonalitySchema.safeParse(spec);
      if (parsed.success) {
        result.push(parsed.data);
      } else if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn(
          `[knauf] modelSpec "${spec.name}" failed schema validation`,
          parsed.error.flatten(),
        );
      }
    }
    return result;
  }, [data]);
}
