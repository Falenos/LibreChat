import { atomWithLocalStorage } from '~/store/utils';

export type KnaufAdminBuilderMode = 'detailed' | 'simplified';

export const KNAUF_ADMIN_BUILDER_MODE_KEY = 'knaufAdminBuilderMode';

export const knaufAdminBuilderModeAtom = atomWithLocalStorage<KnaufAdminBuilderMode>(
  KNAUF_ADMIN_BUILDER_MODE_KEY,
  'detailed',
);
