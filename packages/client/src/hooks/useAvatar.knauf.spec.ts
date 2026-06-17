// [knauf] Seam test: generated user initials must stay on Knauf dark blue.
import { renderHook } from '@testing-library/react';
import { createAvatar } from '@dicebear/core';
import type { TUser } from 'librechat-data-provider';
import useAvatar from './useAvatar';

describe('useAvatar — Knauf user initials colour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses Knauf dark blue as the only generated initials background', () => {
    renderHook(() =>
      useAvatar({
        id: 'user-knauf-blue',
        username: 'zahar',
        name: 'Zahar Alexandru',
        avatar: '',
      } as TUser),
    );

    expect(createAvatar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        backgroundColor: ['213A75'],
        backgroundType: ['solid'],
        textColor: ['ffffff'],
      }),
    );
  });
});
// End [knauf]
