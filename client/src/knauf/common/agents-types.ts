/**
 * Knauf personality type + Zod validator. Single source of truth for
 * `usePersonalities` (client) and (eventually) the server-side
 * autogenerate route once the `packages/knauf/` workspace exists to host
 * cross-runtime types.
 *
 * The shape is the subset of upstream's `modelSpecs.list[]` we care about
 * — `name`, `label`, `description`, `preset`. Upstream may surface other
 * keys (`iconURL`, `default`, `authType`, etc.); we don't validate or
 * consume them here.
 */
import { z } from 'zod';
import { KARL_PERSONALITY_PREFIX } from './constants';

export const knaufPersonalitySchema = z.object({
  name: z.string().refine((v) => v.startsWith(KARL_PERSONALITY_PREFIX), {
    message: `name must start with "${KARL_PERSONALITY_PREFIX}"`,
  }),
  label: z.string().min(1),
  description: z.string().optional(),
  preset: z.record(z.unknown()),
});

export type KnaufPersonality = z.infer<typeof knaufPersonalitySchema>;
