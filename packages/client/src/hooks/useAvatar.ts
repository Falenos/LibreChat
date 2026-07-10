import { useMemo } from 'react';
import { createAvatar } from '@dicebear/core';
import { initials } from '@dicebear/collection';
import type { TUser } from 'librechat-data-provider';

const avatarCache: Record<string, string> = {};

// [knauf] Generated user initials use the Knauf dark blue brand color, not upstream's varied purple palette.
const KNAUF_USER_AVATAR_BACKGROUND_COLORS = ['213A75'];
// End [knauf]

const useAvatar = (user: TUser | undefined): string => {
  return useMemo(() => {
    const { username, name } = user ?? {};
    const seed = name || username;
    if (!seed) {
      return '';
    }

    if (user?.avatar && user?.avatar !== '') {
      return user.avatar;
    }

    if (avatarCache[seed]) {
      return avatarCache[seed];
    }

    const avatar = createAvatar(initials, {
      seed,
      fontFamily: ['Verdana'],
      fontSize: 36,
      backgroundType: ['solid'],
      // [knauf] Pin generated user avatars to Knauf dark blue.
      backgroundColor: KNAUF_USER_AVATAR_BACKGROUND_COLORS,
      // End [knauf]
      textColor: ['ffffff'],
    });

    let avatarDataUri = '';
    try {
      avatarDataUri = avatar.toDataUri();
      if (avatarDataUri) {
        avatarCache[seed] = avatarDataUri;
      }
    } catch (error) {
      console.error('Failed to generate avatar:', error);
    }

    return avatarDataUri;
  }, [user]);
};

export default useAvatar;
